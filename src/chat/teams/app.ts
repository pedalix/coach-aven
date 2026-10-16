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
import { loadProjects, type RegistryRef } from '../../projects.js';
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
import { log } from '../../log.js';

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
      const sent = await apiFor().conversations.createActivity(conversationId, activity as never);
      return { id: (sent as { id?: string }).id ?? '' };
    },
    async update(conversationId, activityId, activity) {
      await apiFor().conversations.updateActivity(conversationId, activityId, activity as never);
    },
    async openPersonal(userId) {
      const res = await apiFor().conversations.create({ tenantId, isGroup: false, bot: { id: `28:${teams.appId}` }, members: [{ id: userId }] } as never);
      return (res as { id?: string }).id;
    },
  };
  const driver = teamsDriver(api, { tenantId, statusMinMs: teams.statusMinMs });
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
  const hostRoutes = createHostRouter({
    reg,
    home: () => tenantId,
    tz: ROUTINE_TZ,
    propose: (slug, record) => dispatcherRef.current?.propose(slug, record) ?? Promise.resolve({ ok: false as const, error: 'dispatch is not available yet' }),
  });
  const engine = createTurnEngine(cfg, store, reg, { hostRoutes });
  const channels = createChannels(reg, () => tenantId);
  const dispatcher = createDispatcher({ store, reg, engine, channels, driverFor, home: () => tenantId, tz: ROUTINE_TZ });
  dispatcherRef.current = dispatcher;
  const pollers = createPollers(cfg, store, reg, driverFor, engine, channels, () => tenantId);

  const actor = createActorGate(store, tenantId);
  const servedTenant = (t: string | undefined) => t === tenantId;
  const core = createInteractions({ cfg, store, reg, engine, homeTeamId: tenantId, servedTenant, actor, prefixFor: () => '', dispatcher });
  const messages = createMessages({ store, reg, engine, channels, homeTeamId: tenantId, actor, parkDmPick: core.parkDmPick });
  const commands = createCommands({ cfg, store, reg, engine, channels, pollers, homeTeamId: tenantId });

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
  });

  // Recovery before the listener opens: the journal drain must not race new activities.
  const recovering = engine.resumeInflightTurns(driverFor);
  engine.resumeQueuedTurns(driverFor, recovering);

  await app.initialize();
  await new Promise<void>((resolve, reject) => {
    server.listen(teams.port, '127.0.0.1', () => resolve()).once('error', reject);
  });
  log.info(`Teams bot running (:${teams.port}) — ${summary(reg.current)}`);
  pollers.startAll();

  const DAY_MS = 24 * 60 * 60_000;
  const pruneState = () => {
    const chats = store.pruneChats(45 * DAY_MS);
    const prs = store.pruneReviewedPrs(90 * DAY_MS);
    if (chats || prs) log.info(`retention: pruned ${chats} idle chats, ${prs} reviewed-PR entries`);
  };
  pruneState();
  setInterval(pruneState, DAY_MS).unref();

  let stopping = false;
  const shutdown = (sig: string) => {
    if (stopping) return;
    stopping = true;
    log.info(`${sig} — closing the Teams listener and exiting (in-flight turns recover on the next boot)`);
    void app
      .stop()
      .catch(() => {})
      .finally(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));
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
