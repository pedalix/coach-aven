// The Teams bot's composition root (OpenSpec teams-chat-driver): load config + registry, build
// the turn engine, channel resolver and pollers exactly as the Slack root does, bind the Teams
// SDK to the driver's API seam, register the activity routes, recover, listen. Mirrors
// src/chat/slack/app.ts; the two differ only where the platforms do:
//   - one tenant per installation: the home tenant IS the configured tenant, keys stay bare;
//   - no socket: Azure Bot Service POSTs to /api/messages on a loopback port behind nginx
//     (design D9); the public face and TLS are the host's reverse proxy's;
//   - no OAuth installs: the bot identity comes from the infra/teams module's outputs.

import express from 'express';
import { App, ExpressAdapter } from '@microsoft/teams.apps';
import type { Config } from '../../config.js';
import { Store } from '../../state.js';
import { loadProjects, type RegistryRef, resolveByChannel } from '../../projects.js';
import { createTurnEngine } from '../../turn.js';
import { createChannels } from '../../channels.js';
import { createPollers, ROUTINE_TZ } from '../../pollers.js';
import { createDispatcher, type Dispatcher } from '../../dispatchrun.js';
import { createHostRouter } from '../../hostrouter.js';
import { createActorGate } from '../core/gates.js';
import { createInteractions } from '../core/interactions.js';
import { createMessages } from '../core/messages.js';
import { createCommands } from '../core/commands.js';
import { setAlertSink, summary, type AlertLevel } from '../slack/blocks.js';
import { teamsDriver, type OutActivity, type TeamsApi } from './driver.js';
import { registerEvents, type TeamsAppLike } from './events.js';
import { withNetRetry } from '../../netretry.js';
import { log } from '../../log.js';
import { messagingRuntime } from '../../messaging/runtime.js';
import { UsageLog } from '../../metering.js';

export async function runTeams(cfg: Config): Promise<void> {
  const teams = cfg.teams;
  if (!teams) {
    throw new Error('Set TEAMS_APP_ID, TEAMS_APP_PASSWORD and TEAMS_TENANT_ID (the infra/teams module outputs) to run the Teams bot.');
  }
  const reg: RegistryRef = { current: loadProjects(cfg.projectsConfigPath) };
  const store = new Store();
  const tenantId = teams.tenantId;

  // ── the SDK app, on our own listener ──────────────────────────────────────
  // ExpressAdapter: the SDK registers /api/messages on an Express app we own, so the listener
  // binds to loopback (nginx is the public face) and nothing else is served.
  const server = express();
  const app = new App({
    clientId: teams.appId,
    clientSecret: teams.appPassword,
    tenantId,
    httpServerAdapter: new ExpressAdapter(server),
    logger: sdkLogger(),
  });

  // ── the driver's API seam over the SDK's Connector client ─────────────────
  // Proactive sends (pollers, recovery) need the tenant's service URL; inbound activities carry
  // it and the store remembers the last one, so a fresh boot can post before any new message.
  let serviceUrl = store.getTeamsServiceUrl();
  const apiFor = () => (serviceUrl ? app.api.clone({ serviceUrl }) : app.api);
  const api: TeamsApi = {
    async send(conversationId, activity) {
      const sent = await connector('send', conversationId, () => apiFor().conversations.createActivity(conversationId, activity as never));
      return { id: (sent as { id?: string }).id ?? '' };
    },
    async sendTargeted(conversationId, activity) {
      const sent = await connector('sendTargeted', conversationId, () => apiFor().conversations.createTargetedActivity(conversationId, activity as never));
      return { id: (sent as { id?: string }).id ?? '' };
    },
    async update(conversationId, activityId, activity) {
      await connector('update', conversationId, () => apiFor().conversations.updateActivity(conversationId, activityId, activity as never));
    },
    async react(conversationId, activityId, type, op) {
      await connector(`react:${op}`, conversationId, () =>
        op === 'add'
          ? apiFor().conversations.addReaction(conversationId, activityId, type as never)
          : apiFor().conversations.deleteReaction(conversationId, activityId, type as never),
      );
    },
    async memberName(conversationId, userId) {
      const m = await connector('member', conversationId, () => apiFor().conversations.members(conversationId).getById(userId));
      return (m as { name?: string }).name;
    },
    async openPersonal(userId) {
      const res = await connector('openPersonal', userId, () =>
        apiFor().conversations.create({ tenantId, isGroup: false, bot: { id: `28:${teams.appId}` }, members: [{ id: userId }] } as never),
      );
      return (res as { id?: string }).id;
    },
  };
  const tokens = app as unknown as { getBotToken(): Promise<{ toString(): string } | null>; getAppGraphToken(t?: string): Promise<{ toString(): string } | null> };
  const driver = teamsDriver(api, { tenantId, statusMinMs: teams.statusMinMs, targeted: teams.targeted });
  // Operators (TEAMS_OPERATORS): Teams user ids (`29:…`, as `/users` lists them) or Entra object
  // ids — the latter matched through the `aadObjectId` every activity of that person carries.
  const operators = new Set(teams.operators);
  const aadOf = new Map<string, string>();
  const isOperator = (user: string | undefined) => !!user && (operators.has(user) || operators.has(aadOf.get(user) ?? ''));
  const driverFor = () => driver; // one tenant: every record resolves to the same driver

  // Operator error alerts → a Teams channel (AVEN_ALERT_CHANNEL = a channel id the app is in).
  const ALERT_CHANNEL = process.env.AVEN_ALERT_CHANNEL;
  const recentAlerts = new Map<string, number>();
  if (ALERT_CHANNEL) {
    const PREFIX: Record<AlertLevel, string> = { error: '🚨 CoachAven error:', warning: '⚠️ CoachAven:', info: '✅ CoachAven:' };
    setAlertSink((text, level) => {
      const now = Date.now();
      const last = recentAlerts.get(text);
      if (last && now - last < 60_000) return;
      recentAlerts.set(text, now);
      if (recentAlerts.size > 200) recentAlerts.clear();
      void driver.post({ conv: ALERT_CHANNEL }, { kind: 'text', text: `${PREFIX[level]} ${text}`.slice(0, 2000) }).catch(() => {});
    });
  }

  // ── engine, channels, pollers, dispatch — as on Slack ─────────────────────
  const dispatcherRef: { current?: Dispatcher } = {};
  // Agent messaging (OpenSpec agent-messaging): as in the Slack root — the shadow hooks into the engine,
  // the service once the engine exists; nothing reaches it without a `messaging` block.
  const messaging = messagingRuntime({ cfg, store, reg, home: () => tenantId, platform: 'teams' });
  const hostRoutes = createHostRouter({
    reg,
    home: () => tenantId,
    tz: ROUTINE_TZ,
    propose: (slug, record) => dispatcherRef.current?.propose(slug, record) ?? Promise.resolve({ ok: false as const, error: 'dispatch is not available yet' }),
    messaging: messaging.messaging,
  });
  const engine = createTurnEngine(cfg, store, reg, { hostRoutes, shadow: messaging.turnDeps });
  const channels = createChannels(reg, () => tenantId);
  const dispatcher = createDispatcher({ store, reg, engine, channels, driverFor, home: () => tenantId, tz: ROUTINE_TZ });
  messaging.start({ engine, driverFor, usageLog: new UsageLog(), tz: ROUTINE_TZ });
  dispatcherRef.current = dispatcher;
  const pollers = createPollers(cfg, store, reg, driverFor, engine, channels, () => tenantId);

  const actor = createActorGate(store, tenantId);
  const servedTenant = (t: string | undefined) => t === tenantId;
  const core = createInteractions({ cfg, store, reg, engine, homeTeamId: tenantId, servedTenant, actor, prefixFor: () => '', dispatcher, messaging: messaging.messaging });
  const messages = createMessages({ store, reg, engine, channels, homeTeamId: tenantId, actor, parkDmPick: core.parkDmPick });
  const commands = createCommands({ cfg, store, reg, engine, channels, pollers, homeTeamId: tenantId, isOperator, onReload: () => messaging.reload(), asks: messaging.asks });

  registerEvents(app as unknown as TeamsAppLike, {
    tenantId,
    driver,
    messages,
    core,
    commands,
    onServiceUrl: (url) => {
      if (url === serviceUrl) return;
      serviceUrl = url;
      store.setTeamsServiceUrl(url);
    },
    onPerson: (id, name, aad) => {
      driver.knowPerson(id, name);
      if (aad) aadOf.set(id, aad);
    },
    boundProject: (conv) => resolveByChannel(reg.current, conv)?.slug,
    // The SDK keeps both tokens protected; they are the app's own (client credentials), fetched
    // and cached by its token manager. The Graph one is empty until the tenant consented
    // Files.Read.All (the module's `supports_files`).
    files: {
      botToken: async () => (await tokens.getBotToken())?.toString(),
      graphToken: async () => (await tokens.getAppGraphToken(tenantId))?.toString(),
    },
  });

  // Recovery before the listener opens: the journal drain must not race new activities.
  const recovering = engine.resumeInflightTurns(driverFor);
  engine.resumeQueuedTurns(driverFor, recovering);
  messaging.recover(recovering); // messages that were on their way, after their conversation's recovery

  await app.initialize();
  const listener = await new Promise<import('node:http').Server>((resolve, reject) => {
    const l = server.listen(teams.port, '127.0.0.1', () => resolve(l));
    l.once('error', reject);
  });
  log.info(`Teams bot running (:${teams.port}) — ${summary(reg.current)}`);
  pollers.startAll();

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

  let stopping = false;
  const shutdown = (sig: string) => {
    if (stopping) return;
    stopping = true;
    log.info(`${sig} — closing the Teams listener and exiting (in-flight turns recover on the next boot)`);
    // The listener is ours (ExpressAdapter), so it is ours to close — app.stop() would only
    // complain that the server lifecycle is managed externally.
    listener.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));
}

// A Connector call with its failure made legible: the SDK throws axios errors whose message is
// "Request failed with status code 400" and whose actual reason sits in the response body —
// which is what an operator (and the thread) needs to see.
// Retried: 429 (Retry-After honoured — Teams allows ~7 sends/s per thread), 412 (concurrent
// operations on one conversation) and 502/503/504, then transient socket errors; the SDK itself
// retries nothing. Anything else propagates with the body.
const RETRIED = new Set([412, 429, 502, 503, 504]);
async function connector<T>(call: string, target: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await withNetRetry(async () => {
      for (let attempt = 0; ; attempt++) {
        try {
          return await fn();
        } catch (e) {
          const r = (e as { response?: { status?: number; headers?: Record<string, string> } }).response;
          if (!r?.status || !RETRIED.has(r.status) || attempt >= 3) throw e;
          const after = Number(r.headers?.['retry-after']);
          const wait = Number.isFinite(after) && after > 0 ? after * 1000 : [1000, 3000, 8000][attempt];
          log.warn(`teams ${call}: HTTP ${r.status}, retrying in ${wait} ms (${attempt + 1}/3)`);
          await new Promise((res) => setTimeout(res, wait));
        }
      }
    });
  } catch (e) {
    const r = (e as { response?: { status?: number; data?: unknown } }).response;
    if (!r) throw e;
    const body = typeof r.data === 'string' ? r.data : JSON.stringify(r.data);
    // What we sent, for the journal only: the thread gets the Connector's verdict, the operator
    // gets the payload that earned it.
    const sent = (e as { config?: { data?: unknown } }).config?.data;
    if (sent) log.error(`teams ${call} rejected payload: ${String(sent).slice(0, 1500)}`);
    throw new Error(`Teams ${call} → ${target}: HTTP ${r.status} ${body?.slice(0, 500) ?? ''}`.trim());
  }
}

// The SDK logs through its own logger; route it into ours so the journal has one voice.
function sdkLogger() {
  const l = {
    debug: () => {},
    info: (...a: unknown[]) => log.info(`teams-sdk: ${a.map(String).join(' ')}`),
    warn: (...a: unknown[]) => log.warn(`teams-sdk: ${a.map(String).join(' ')}`),
    error: (...a: unknown[]) => log.error(`teams-sdk: ${a.map(String).join(' ')}`),
    log: (...a: unknown[]) => log.info(`teams-sdk: ${a.map(String).join(' ')}`),
    child: () => l,
    enabled: () => true,
    toString: () => 'teams',
  };
  return l as never;
}

export type { OutActivity };
