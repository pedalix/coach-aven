// The chat composition root (OpenSpec `multi-driver-installation` D2): ONE turn engine, one set of
// pollers and one agent-messaging runtime, a channel directory per surface, and the chat drivers as
// surface plugins over them. An installation's run mode (`orch slack`, `orch teams`) names its
// DEFAULT surface; `CHAT_SURFACES` names additional ones. Every surface is prepared before any
// starts: a surface that cannot run fails the boot, loudly, so nothing half-starts.
//
// Order of boot, the same each driver had on its own: prepare every surface (SDK clients, the home
// tenant the default resolves) → messaging runtime (it needs the home tenant) → engine → channels →
// pollers → wire each surface's handlers → recover in-flight and queued turns → start each surface's
// connection or listener → pollers → retention → graceful shutdown.

import { checkLocalDocker } from '../sshdocker.js';
import type { Config } from '../config.js';
import { Store } from '../state.js';
import { homeWorkspaceWarning, loadProjects, type RegistryRef } from '../projects.js';
import { createTurnEngine, type TurnEngine } from '../turn.js';
import { createChannels, type Channels, type ChannelsOptions } from '../channels.js';
import { createPollers, ROUTINE_TZ, type Pollers } from '../pollers.js';
import { createHostRouter } from '../hostrouter.js';
import { messagingRuntime, type MessagingRuntime } from '../messaging/runtime.js';
import { UsageLog } from '../metering.js';
import { log } from '../log.js';
import type { ChatDriver } from './driver.js';
import type { ChatDriverName } from './drivers.js';
import type { DriverFor } from './surfaces.js';
import { setAlertSink, type AlertLevel } from './slack/blocks.js';

/** What the root hands every surface once the shared pieces exist. */
export interface SharedDeps {
  cfg: Config;
  store: Store;
  reg: RegistryRef;
  engine: TurnEngine;
  channels: Channels;
  pollers: Pollers;
  messaging: MessagingRuntime;
  /** The driver of any surface + tenant of this installation (surfaces.ts). */
  driverFor: DriverFor;
  /** This surface's name in conversation keys: undefined for the default surface (its keys keep today's shapes). */
  surface?: ChatDriverName;
}

/** A surface after its handlers are wired: how to open and close it. */
export interface WiredSurface {
  /** Open the connection or listener; resolves once people can reach the bot. Logs its own "running" line. */
  start(): Promise<void>;
  /** Close it (a graceful shutdown); never throws. */
  stop(): Promise<void>;
  /** For the shutdown log line: what is being closed ("the Slack socket", "the Teams listener"). */
  closing: string;
}

/** A surface with its SDK clients built and its identity known, before any handler or listener. */
export interface PreparedSurface {
  readonly name: ChatDriverName;
  /** The home tenant id this surface resolved (Slack: after auth.test or from the OAuth home; Teams: its tenant). Late-bound. */
  homeTenantId(): string | undefined;
  /** The driver of a tenant of this surface; throws when that tenant has no live installation. */
  driverFor(tenantId?: string): ChatDriver;
  /** Options for the channel directory on this surface (Teams: team channels map by id only). */
  channelsOptions?: ChannelsOptions;
  /** Whether this surface has a home to serve: recovery and pollers run only then (a Slack OAuth installation without its home install has none). */
  hasHome: boolean;
  /** Operator alerts to this surface's alert channel, when it has one; the root fans every alert out to all of them. */
  alerts?: (text: string, level: AlertLevel) => void;
  /** Wire the surface's handlers over the shared pieces. */
  wire(shared: SharedDeps): Promise<WiredSurface>;
}

export interface SurfacePlugin {
  readonly name: ChatDriverName;
  /** Build the SDK clients and resolve the identity; throws, naming the setting, when the surface cannot run. */
  prepare(cfg: Config, store: Store, reg: RegistryRef): Promise<PreparedSurface>;
}

// Each driver's module is loaded only when its surface runs: a Slack installation never loads the
// Teams SDK (and `src/chat/imports.test.ts` keeps the SDKs inside their driver directories).
async function plugin(name: ChatDriverName): Promise<SurfacePlugin> {
  switch (name) {
    case 'slack':
      return (await import('./slack/app.js')).slackSurface;
    case 'teams':
      return (await import('./teams/app.js')).teamsSurface;
    case 'web':
      return (await import('./web/app.js')).webSurface;
  }
}

export interface RunChatOptions {
  /** Tests: the plugins to use instead of the drivers' modules, and a store on a throwaway path. */
  plugins?: Partial<Record<ChatDriverName, SurfacePlugin>>;
  store?: Store;
}

export async function runChat(cfg: Config, defaultName: ChatDriverName, options: RunChatOptions = {}): Promise<void> {
  const names: ChatDriverName[] = [defaultName, ...cfg.chatSurfaces.filter((n) => n !== defaultName)];
  const reg: RegistryRef = { current: loadProjects(cfg.projectsConfigPath) };
  const store = options.store ?? new Store();
  // Every surface prepared before any starts (D7): a missing setting fails the boot naming the surface.
  const surfaces = new Map<ChatDriverName, PreparedSurface>();
  for (const name of names) {
    const pl = options.plugins?.[name] ?? (await plugin(name));
    try {
      surfaces.set(name, await pl.prepare(cfg, store, reg));
    } catch (e) {
      throw new Error(`chat surface ${name}${name === defaultName ? '' : ' (CHAT_SURFACES)'} cannot start: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  const def = surfaces.get(defaultName)!;

  // Bot-served MCP servers (hostrouter.ts): `host` (agent messaging's tools) and the channel-served
  // `sources` are answered by this process over each session's control channel.
  // Agent messaging (OpenSpec agent-messaging): the shadow conversations' hooks go into the engine,
  // the service is started once the engine exists. Nothing reaches it without a `messaging` block.
  const messaging = messagingRuntime({ cfg, store, reg, home: () => def.homeTenantId(), platform: defaultName });
  const hostRoutes = createHostRouter({ tz: ROUTINE_TZ, messaging: messaging.messaging });
  const engine = createTurnEngine(cfg, store, reg, { hostRoutes, shadow: messaging.turnDeps });
  // One channel directory per surface: each reads its own driver's binding of a project.
  const channelsOf = new Map<ChatDriverName, Channels>();
  for (const [name, s] of surfaces) channelsOf.set(name, createChannels(reg, () => s.homeTenantId(), { ...(s.channelsOptions ?? {}), binding: name }));
  // Every non-event path (pollers, messaging, recovery) resolves a conversation's driver by its
  // surface and tenant; a surface this installation does not run is an error the caller logs and skips.
  const driverFor: DriverFor = (ref) => {
    const name = ref.surface ?? defaultName;
    const s = surfaces.get(name);
    if (!s) throw new Error(`surface ${name} is not available on this installation`);
    return s.driverFor(ref.tenantId);
  };
  messaging.start({ engine, driverFor, usageLog: new UsageLog(), tz: ROUTINE_TZ });
  const pollers = createPollers(cfg, store, reg, driverFor, engine, channelsOf.get(defaultName)!, () => def.homeTenantId(), {
    channelsFor: (name) => channelsOf.get(name),
    defaultSurface: defaultName,
  });
  // Operator alerts reach every surface that has an alert channel.
  const sinks = [...surfaces.values()].map((s) => s.alerts).filter((f): f is NonNullable<typeof f> => !!f);
  if (sinks.length) setAlertSink((text, level) => sinks.forEach((f) => f(text, level)));

  const wired = new Map<ChatDriverName, WiredSurface>();
  for (const [name, s] of surfaces) {
    wired.set(name, await s.wire({ cfg, store, reg, engine, channels: channelsOf.get(name)!, pollers, messaging, driverFor, ...(name === defaultName ? {} : { surface: name }) }));
  }

  // Recovery order matters: reattach the turns that were RUNNING first, then replay the journaled
  // ones that were still queued (a replay waits for its key's recovery). Both BEFORE any surface
  // opens: the journal drain must happen while no new event can append to it, or a turn accepted in
  // the gap would be replayed as a duplicate. Each record resolves ITS OWN surface and tenant.
  if (def.hasHome) {
    const recovering = engine.resumeInflightTurns(driverFor);
    engine.resumeQueuedTurns(driverFor, recovering);
    messaging.recover(recovering); // messages that were on their way, after their conversation's recovery
  }

  // Start in order; a surface that cannot open closes the ones already open and fails the boot (D7).
  const started: WiredSurface[] = [];
  for (const [name, w] of wired) {
    try {
      await w.start();
      started.push(w);
    } catch (e) {
      for (const s of started) await s.stop();
      throw new Error(`chat surface ${name} could not start: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  if (def.hasHome) pollers.startAll();
  // A workspaces block that leaves out the home workspace makes every home channel answer "no projects": say so at boot.
  const homeWarning = homeWorkspaceWarning(reg.current, def.homeTenantId());
  if (homeWarning) log.warn(homeWarning);
  // Sandboxes on this machine's Docker: say at boot, not in the first turn, when the socket is out of reach (never awaited).
  void checkLocalDocker(cfg.sshDocker?.host).catch(() => {});

  // Retention: without it, chats/reviewedPrs grow by one record per thread/PR forever and every
  // save() rewrites the whole (ever larger) state.json several times per turn. Run at boot AND
  // daily — with graceful restarts the process may stay up for months.
  const DAY_MS = 24 * 60 * 60_000;
  const pruneState = () => {
    const chats = store.pruneChats(45 * DAY_MS);
    const prs = store.pruneReviewedPrs(90 * DAY_MS);
    const asks = store.pruneMessaging(30 * DAY_MS); // agent messaging: ended tasks, held messages (none without messaging)
    if (chats || prs) log.info(`retention: pruned ${chats} idle chats, ${prs} reviewed-PR entries`);
    if (asks) log.info(`retention: pruned ${asks} ended agent-messaging records`);
  };
  pruneState();
  setInterval(pruneState, DAY_MS).unref();

  // Graceful shutdown: close the surface first (Slack stops routing events here and redelivers
  // unacked ones on the next connect; the Teams listener is ours to close), then exit promptly —
  // all state writes are synchronous, and in-flight turns keep running in their sandboxes to be
  // recovered on the next boot. Deliberately NOT waiting for turns to finish: they can run 15
  // minutes, recovery is exactly the mechanism built for them.
  let stopping = false;
  const shutdown = (sig: string) => {
    if (stopping) return;
    stopping = true;
    log.info(`${sig} — closing ${[...wired.values()].map((w) => w.closing).join(', ')} and exiting (in-flight turns recover on the next boot)`);
    void Promise.all([...wired.values()].map((w) => w.stop())).finally(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref(); // if the close wedges, exit anyway
  };
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));
}
