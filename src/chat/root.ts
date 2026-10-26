// The chat composition root (OpenSpec `multi-driver-installation` D2): ONE turn engine, one channel
// directory, one set of pollers and one agent-messaging runtime, and the chat drivers as surface
// plugins over them. An installation's run mode (`orch slack`, `orch teams`) names its DEFAULT
// surface; `CHAT_SURFACES` names additional ones. Until PR 2 of that change only the default
// surface runs: naming another is refused at boot, loudly, so nothing half-starts.
//
// Order of boot, the same both drivers had on their own: prepare the default surface (its SDK
// clients and the home tenant it resolves) → messaging runtime (it needs the home tenant) → engine →
// channels → pollers → wire the surface's handlers → recover in-flight and queued turns → start
// the surface's connection or listener → pollers → retention → graceful shutdown.

import type { Config } from '../config.js';
import { Store } from '../state.js';
import { loadProjects, type RegistryRef } from '../projects.js';
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
  }
}

export async function runChat(cfg: Config, defaultName: ChatDriverName): Promise<void> {
  const extra = cfg.chatSurfaces.filter((n) => n !== defaultName);
  if (extra.length) {
    throw new Error(
      `CHAT_SURFACES=${extra.join(',')}: additional chat surfaces are not available yet (multi-driver-installation PR 2) — ` +
        `unset it, or run that driver as this installation's run mode (\`orch ${extra[0]}\`)`,
    );
  }
  const reg: RegistryRef = { current: loadProjects(cfg.projectsConfigPath) };
  const store = new Store();
  const def = await (await plugin(defaultName)).prepare(cfg, store, reg);
  const surfaces = new Map<ChatDriverName, PreparedSurface>([[defaultName, def]]);

  // Bot-served MCP servers (hostrouter.ts): `host` (agent messaging's tools) and the channel-served
  // `sources` are answered by this process over each session's control channel.
  // Agent messaging (OpenSpec agent-messaging): the shadow conversations' hooks go into the engine,
  // the service is started once the engine exists. Nothing reaches it without a `messaging` block.
  const messaging = messagingRuntime({
    cfg,
    store,
    reg,
    home: () => def.homeTenantId(),
    platform: defaultName,
  });
  const hostRoutes = createHostRouter({
    tz: ROUTINE_TZ,
    messaging: messaging.messaging,
  });
  const engine = createTurnEngine(cfg, store, reg, {
    hostRoutes,
    shadow: messaging.turnDeps,
  });
  const channels = createChannels(reg, () => def.homeTenantId(), def.channelsOptions);
  // Every non-event path (pollers, messaging, recovery) resolves a conversation's driver by its
  // surface and tenant; a surface this installation does not run is an error the caller logs and skips.
  const driverFor: DriverFor = (ref) => {
    const name = ref.surface ?? defaultName;
    const s = surfaces.get(name);
    if (!s) throw new Error(`surface ${name} is not available on this installation`);
    return s.driverFor(ref.tenantId);
  };
  messaging.start({
    engine,
    driverFor,
    usageLog: new UsageLog(),
    tz: ROUTINE_TZ,
  });
  const pollers = createPollers(cfg, store, reg, driverFor, engine, channels, () => def.homeTenantId());

  const wired = await def.wire({
    cfg,
    store,
    reg,
    engine,
    channels,
    pollers,
    messaging,
    driverFor,
  });

  // Recovery order matters: reattach the turns that were RUNNING first, then replay the journaled
  // ones that were still queued (a replay waits for its key's recovery). Both BEFORE the surface
  // opens: the journal drain must happen while no new event can append to it, or a turn accepted in
  // the gap would be replayed as a duplicate. Each record resolves ITS OWN surface and tenant.
  if (def.hasHome) {
    const recovering = engine.resumeInflightTurns(driverFor);
    engine.resumeQueuedTurns(driverFor, recovering);
    messaging.recover(recovering); // messages that were on their way, after their conversation's recovery
  }

  await wired.start();
  if (def.hasHome) pollers.startAll();

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
    log.info(`${sig} — closing ${wired.closing} and exiting (in-flight turns recover on the next boot)`);
    void wired.stop().finally(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref(); // if the close wedges, exit anyway
  };
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));
}
