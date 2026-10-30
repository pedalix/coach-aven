// Agent messaging in a composition root (OpenSpec `agent-messaging`, task 3.5): one function both chat
// drivers' roots call (chat/slack/app.ts, chat/teams/app.ts). Two steps, because the turn engine and the
// service need each other:
//   1. messagingRuntime() before the engine: the shadow driver and the engine's shadow hooks (TurnDeps
//      .shadow), late-bound to the service; and the late-bound service for the host router.
//   2. start(engine, …) after it: the transports — the in-process one always, the hub client only with
//      HUB_URL (and an explicit INSTALLATION_ID and a key file; otherwise a loud error and local
//      messaging only) — the service, the recovery of deliveries, the minute tick.
// An installation without any `messaging` configuration and without HUB_URL registers no tool, opens
// no connection and has nothing to recover: the service exists but nothing reaches it.
import type { ChatDriverName } from '../chat/drivers.js';
import { readFileSync } from 'node:fs';
import { shadowDriver, type ShadowDriver } from '../chat/shadow/driver.js';
import type { DriverFor, DriverRef } from '../chat/surfaces.js';
import type { ChatDriver } from '../chat/driver.js';
import type { Config } from '../config.js';
import { log } from '../log.js';
import type { RegistryRef } from '../projects.js';
import type { Store } from '../state.js';
import type { TurnDeps, TurnEngine } from '../turn.js';
import { applyHubReports, HubClient, type SocketFactory } from './hubclient.js';
import { LocalTransport } from './local.js';
import { droppedPeers, endTasksWithPeer, loadPeers, peersPath, type Peers } from './peers.js';
import type { KeyFile } from './seal.js';
import { createMessaging, type Messaging } from './service.js';
import { asksList, asksTranscript, type AskRow } from './audit.js';
import { UsageLog } from '../metering.js';
import { FactStore } from '../facts.js';
import { cliOwnNames } from './clinames.js';
import { splitTeam } from '../teamkeys.js';
import { shadowDir as shadowDirDefault } from '../paths.js';

const TICK_MS = 60_000;

export interface MessagingRuntime {
  /** The engine's shadow hooks (TurnDeps.shadow). */
  turnDeps: NonNullable<TurnDeps['shadow']>;
  shadow: ShadowDriver;
  /** For the host router and the commands: the service once started. */
  messaging: () => Messaging | undefined;
  start(o: { engine: TurnEngine; driverFor: DriverFor; usageLog?: UsageLog; tz?: string }): void;
  /** After the engine's own restart recovery: the messages that were on their way. */
  recover(recovering: Map<string, Promise<void>>): void;
  /** `/aven reload`: re-read hub.peers.json and the acceptance of open tasks; what changed, in words. */
  reload(): string[];
  /** `/aven asks` (D17), for the commands. */
  asks: { enabled(): boolean; list(): string; transcript(taskId: string): string; cancel(taskId: string, by: string): string };
  /** Whether any project has a `messaging` block (the Home tab's messaging lines, the verb). */
  configured(): boolean;
  stop(): void;
}

export function messagingRuntime(o: { cfg: Config; store: Store; reg: RegistryRef; home: () => string | undefined; platform: ChatDriverName; shadowDir?: string; /** Tests: the hub client's socket. */ socket?: SocketFactory }): MessagingRuntime {
  const ref: { current?: Messaging } = {};
  const shadow = shadowDriver({ dir: o.shadowDir ?? shadowDirDefault() });
  const env = o.cfg.messaging;
  const path = peersPath(o.cfg.projectsConfigPath);
  const readPeers = (): Peers => {
    try {
      return loadPeers(path, env.installation);
    } catch (e) {
      log.error(`agent messaging: ${e instanceof Error ? e.message : String(e)} — no peers`);
      return {};
    }
  };
  const peers = { current: readPeers() };
  let hub: HubClient | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  const localRef: { current?: LocalTransport } = {};
  return {
    shadow,
    messaging: () => ref.current,
    turnDeps: {
      driver: shadow,
      opts: (key) => ref.current?.shadowOpts(key),
      recovered: async (key, r) => ref.current?.settleShadowTurn(key, r.ok ? { ok: true, text: r.text } : { ok: false, reason: r.status }),
    },
    start({ engine, driverFor, usageLog, tz }) {
      // The skills a project's card offers come from the skills scanner's fact (src/skills.ts, agent-skills).
      const facts = new FactStore();
      const local = new LocalTransport(o.store.messagingRecords('local'), { installation: env.installation, onHandlerError: (seq, e) => log.error(`agent messaging: local delivery ${seq}: ${e instanceof Error ? e.message : String(e)}`) });
      localRef.current = local;
      if (env.hubProblem) log.error(`agent messaging: ${env.hubProblem} — the hub client does not start; messaging inside this installation keeps working`);
      if (env.hub) {
        let keys: KeyFile | undefined;
        try {
          keys = JSON.parse(readFileSync(env.hub.keyPath, 'utf8')) as KeyFile;
        } catch (e) {
          log.error(`agent messaging: HUB_KEY_PATH ${env.hub.keyPath} unreadable (${e instanceof Error ? e.message : String(e)}) — run \`orch hub keygen\`; the hub client does not start`);
        }
        if (keys) hub = new HubClient({ url: env.hub.url, installation: env.installation, keys, peers: () => peers.current, store: o.store.messagingRecords('hub'), ...(o.socket ? { socket: o.socket } : {}) });
      }
      const driverOrNone = (ref: DriverRef): ChatDriver | undefined => {
        try {
          return driverFor(ref);
        } catch {
          return undefined;
        }
      };
      const svc = createMessaging({ installation: env.installation, store: o.store, reg: o.reg, home: o.home, peers: () => peers.current, engine, local, ...(hub ? { hub } : {}), shadow, platform: o.platform, driverFor: driverOrNone, ...(usageLog ? { usageLog } : {}), ...(tz ? { tz } : {}), skillsOf: (slug) => facts.projectSkills(slug), commandsOf: (slug) => facts.sessionCommands(slug), cliNamesOf: (slug) => cliOwnNames(o.reg.current.projects.find((p) => p.slug === slug)?.cliVersion ?? o.cfg.claudeCliVersion) });
      ref.current = svc;
      local.onDeliver((x) => svc.onDelivery(local, x));
      if (hub) {
        const h = hub;
        h.onDeliver((x) => svc.onDelivery(h, x));
        applyHubReports(h, o.store, { installation: env.installation, onEnded: (t) => svc.ended(t) });
        h.start();
        log.info(`agent messaging: hub client for ${env.installation} → ${env.hub!.url} (${Object.keys(peers.current).length} pinned peer(s))`);
      }
      timer = setInterval(() => svc.tick(), TICK_MS);
      timer.unref?.();
    },
    recover(recovering) {
      // Unacked local envelopes are handed over again (de-duplicated by envelope id), then every
      // delivery that was on its way — each after its conversation's own recovery.
      void (async () => {
        await ref.current?.recoverDeliveries(recovering);
      })();
      void localRef.current?.start();
    },
    reload() {
      const before = peers.current;
      peers.current = readPeers();
      // The pinned peers are this installation's allow list at the hub (hub-open-network, N3).
      hub?.refreshAllow();
      const notes: string[] = [];
      for (const peer of droppedPeers(before, peers.current)) {
        const gone = endTasksWithPeer(o.store, peer, 'peer removed');
        for (const t of [...gone.out, ...gone.in]) ref.current?.ended(t);
        notes.push(`peer ${peer} removed${gone.out.length + gone.in.length ? ` (${gone.out.length + gone.in.length} open task(s) ended)` : ''}`);
      }
      return [...notes, ...(ref.current?.reload() ?? [])];
    },
    stop() {
      hub?.stop();
      if (timer) clearInterval(timer);
    },
    configured: () => o.reg.current.projects.some((p) => p.messaging !== undefined),
    asks: {
      enabled: () => o.reg.current.projects.some((p) => p.messaging !== undefined) || env.hub !== undefined || env.hubProblem !== undefined,
      list: () => asksList(rows()),
      transcript: (taskId) => {
        const r = rows().find((x) => x.id === taskId);
        if (!r) return `No task \`${taskId}\` here.`;
        const inc = r.dir === 'in' ? o.store.messagingTasks().in.find((t) => t.id === taskId) : undefined;
        return asksTranscript(r, inc ? shadow.read(inc.origin, inc.id) : []);
      },
      cancel: (taskId, by) => ref.current?.cancelByOperator(taskId, by) ?? 'Agent messaging has not started.',
    },
  };

  // The audit's rows: tasks both ways, and held messages; costs from metering (turns run here, by task
  // id) or, for an answer from another installation, the cost it reported (D17).
  function rows(): AskRow[] {
    const usage = new UsageLog().read(31 * 86_400_000) as { taskId?: string; usage?: { costUsd?: number } }[];
    const costOf = (id: string): number | undefined => {
      const rs = usage.filter((u) => u.taskId === id);
      return rs.length ? rs.reduce((a, u) => a + (u.usage?.costUsd ?? 0), 0) : undefined;
    };
    const tasks = o.store.messagingTasks();
    const out: AskRow[] = tasks.out.map((t) => ({
      dir: 'out',
      id: t.id,
      slug: t.slug,
      ...(splitTeam(t.key).tenantId ? { tenant: splitTeam(t.key).tenantId } : {}),
      peer: t.target,
      state: o.store.getHeld(t.id) ? 'held' : t.state,
      ...(t.reason ? { reason: t.reason } : {}),
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
      ...((t.cost ?? costOf(t.id)) !== undefined ? { cost: t.cost ?? costOf(t.id) } : {}),
      question: t.question,
      ...(t.skill ? { skill: t.skill } : {}),
      ...(t.last?.text ? { answer: t.last.text } : {}),
      ...(o.store.getHeld(t.id) ? { why: o.store.getHeld(t.id)!.why } : {}),
    }));
    const inc: AskRow[] = tasks.in.map((t) => ({
      dir: 'in',
      id: t.id,
      slug: t.slug,
      ...(splitTeam(t.key).tenantId ? { tenant: splitTeam(t.key).tenantId } : {}),
      peer: t.from,
      state: t.state,
      ...(t.reason ? { reason: t.reason } : {}),
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
      ...(costOf(t.id) !== undefined ? { cost: costOf(t.id) } : {}),
      question: t.question,
      ...(t.skill ? { skill: t.skill } : {}),
      ...(t.last?.text ? { answer: t.last.text } : {}),
    }));
    return [...out, ...inc];
  }
}
