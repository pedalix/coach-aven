// The Bolt bot's composition root: load config + registry, build the turn engine and
// channel resolver, register the Slack surfaces (events + /aven commands), start the
// pollers. The moving parts live in their own modules:
//   chat/slack/blocks.ts — every Block Kit renderer + user-facing text helpers
//   turn.ts     — the turn engine (queues, live status, agent questions, recovery)
//   channels.ts — channel ↔ project resolution
//   commands.ts — the /aven router and subcommand handlers
//   chat/slack/events.ts — @mentions, thread replies, DMs, buttons, App Home
//   pollers.ts  — scheduler + auto-review / autofix / YouTrack pollers
import { createDispatcher } from './dispatchrun.js';
import { slackDriver } from './chat/slack/driver.js';
import bolt from '@slack/bolt';
import type { Installation } from '@slack/bolt';
import type { Config } from './config.js';
import { Store } from './state.js';
import { createInstallationStore } from './installations.js';
import { tenantOf } from './teamkeys.js';
import { RecentSet } from './recent.js';
import { eventLog, eventLogRaw, envelopeMeta } from './eventlog.js';
import { loadProjects, entrySlugs, type RegistryRef } from './projects.js';
import { createTurnEngine } from './turn.js';
import { createChannels } from './channels.js';
import { createPollers, ROUTINE_TZ } from './pollers.js';
import { registerCommands } from './commands.js';
import { registerEvents } from './chat/slack/events.js';
import { setAlertSink, summary, notConfiguredText, type AlertLevel } from './chat/slack/blocks.js';
import { log } from './log.js';

const { App } = bolt;

// One Slack bot, MANY channels. Each channel is bound to a project (channel = context =
// the project's own isolated sandbox, proj-<slug>); naming convention bluefin-{project}.
// The channel determines which repo the bot works against. Two modes:
//   • @mention / thread reply → public, shared thread (collaborate, build features)
//   • /aven slash / DM        → private answer (quick Q&A)
// Each thread/DM is its own Claude session (no shared context), resumed via --resume.
// Seed the installation store from SLACK_BOT_TOKEN so the migration from single-workspace
// to OAuth is transparent: our existing workspace becomes just "the first tenant". Returns
// that workspace's team id (resolved via auth.test — the token knows its own team). Only
// writes when the team has no record yet, so a later REAL install (with true scopes) wins.
async function seedHomeInstallation(store: Store, botToken: string): Promise<string> {
  const probe = new bolt.webApi.WebClient(botToken);
  const auth = await probe.auth.test();
  const teamId = auth.team_id as string;
  if (!store.getInstallation(teamId)) {
    const seed: Installation = {
      team: { id: teamId },
      enterprise: undefined,
      user: { token: undefined, scopes: undefined, id: auth.user_id as string },
      bot: { token: botToken, scopes: [], id: auth.bot_id as string, userId: auth.user_id as string },
      isEnterpriseInstall: false,
      metadata: 'seeded from SLACK_BOT_TOKEN', // so a human reading state.json knows why scopes=[]
    };
    store.setInstallation(teamId, seed);
    log.info(`seeded home-workspace installation for team ${teamId} from SLACK_BOT_TOKEN`);
  }
  return teamId;
}

export async function runSlack(cfg: Config): Promise<void> {
  if (!cfg.slack) {
    throw new Error(
      'Set SLACK_APP_TOKEN plus SLACK_BOT_TOKEN (single-workspace) and/or ' +
        'SLACK_CLIENT_ID/SLACK_CLIENT_SECRET/SLACK_STATE_SECRET (OAuth multi-workspace) to run the Slack bot.',
    );
  }
  // The registry travels as a mutable REF so a future runtime reload can swap `.current`
  // without re-wiring the engine/pollers/handlers that captured it.
  const reg: RegistryRef = { current: loadProjects(cfg.projectsConfigPath) };
  const store = new Store();
  // Two constructions: classic single-workspace (static token; no HTTP listener) vs OAuth
  // multi-workspace. With `oauth` set, the App carries NO default token — Bolt authorizes
  // every incoming event through the installation store (per-team bot tokens), and the
  // SocketModeReceiver additionally serves /slack/install + /slack/oauth_redirect over HTTP
  // (installerOptions.port) for the "Add to Slack" flow. Socket Mode stays the event
  // transport for every installed workspace — one app-level socket, many teams.
  const oauth = cfg.slack.oauth;
  const app = oauth
    ? new App({
        appToken: cfg.slack.appToken,
        socketMode: true,
        clientId: oauth.clientId,
        clientSecret: oauth.clientSecret,
        stateSecret: oauth.stateSecret,
        scopes: oauth.scopes,
        installationStore: createInstallationStore(store),
        // directInstall skips the "Add to Slack" landing page — /slack/install redirects
        // straight into Slack's consent screen.
        installerOptions: { port: oauth.port, directInstall: true },
      })
    : new App({
        token: cfg.slack.botToken,
        appToken: cfg.slack.appToken,
        socketMode: true,
      });

  // ── the home-team client ────────────────────────────────────────────────
  // The singleton concerns — alert sink, dream/housekeeping, restart recovery of home
  // records — run on the home workspace's client. Under OAuth, app.client has no token,
  // so it's minted from the installation store: the seeded env token, an explicit
  // SLACK_HOME_TEAM_ID's record, or — on a first-ever OAuth boot with an empty store —
  // nothing, in which case those concerns stay off (with a loud warning) but the bot
  // still starts and serves /slack/install, so the first install can happen at all.
  let homeClient: bolt.webApi.WebClient | undefined;
  let homeTeamId: string | undefined;
  if (!oauth) {
    homeClient = app.client; // static token — today's behavior, unchanged
  } else {
    homeTeamId = cfg.slack.botToken
      ? await seedHomeInstallation(store, cfg.slack.botToken)
      : oauth.homeTeamId;
    const install = homeTeamId ? (store.getInstallation(homeTeamId) as Installation | undefined) : undefined;
    const homeToken = install?.bot?.token;
    if (homeToken) {
      homeClient = new bolt.webApi.WebClient(homeToken);
    } else {
      log.warn(
        'no home-workspace installation found — alerts, pollers and restart recovery are OFF. ' +
          `Install the app into the home workspace via http://<host>:${oauth.port}/slack/install ` +
          '(or set SLACK_BOT_TOKEN to seed it), then restart.',
      );
    }
  }

  // ── per-tenant client resolver ──────────────────────────────────────────
  // THE way any non-event code path (pollers, recovery) gets a workspace's client.
  // Cache keyed by the TOKEN, not the tenant — a reinstall rotates the token and the
  // stale client falls out of use automatically. Throws for unknown tenants: callers
  // (recovery, pollers) handle that per record and never fall back to the home token
  // against a foreign workspace.
  const clientCache = new Map<string, bolt.webApi.WebClient>();
  function clientForTeam(tenantId?: string): bolt.webApi.WebClient {
    if (!tenantId || tenantId === homeTeamId) {
      if (!homeClient) throw new Error('home workspace has no installation yet');
      return homeClient;
    }
    const install = store.getInstallation(tenantId) as Installation | undefined;
    const token = install?.bot?.token;
    if (!token) throw new Error(`no installation for tenant ${tenantId} — uninstalled or never installed`);
    let c = clientCache.get(token);
    if (!c) {
      if (clientCache.size > 100) clientCache.clear(); // bound (rotations leave dead entries)
      c = new bolt.webApi.WebClient(token);
      clientCache.set(token, c);
    }
    return c;
  }

  // ── envelope journal (AVEN_EVENT_LOG=1) ─────────────────────────────────
  // Metadata-only (whitelist — no message text/values ever) record of every envelope,
  // BEFORE the gate so gated traffic is captured too. Feeds the record→replay loop:
  // real envelope shapes (esp. Slack Connect ones) become fixtures for src/twin.ts.
  if (eventLog) {
    const journal = eventLog; // narrow once — the closure runs long after the check
    app.use(async ({ body, context, next }) => {
      const meta = envelopeMeta(body, context as { teamId?: string; enterpriseId?: string; isEnterpriseInstall?: boolean });
      // 'full' additionally captures the verbatim envelope (message text included) —
      // the complete twin-fixture dataset for the trusted-workspaces phase.
      journal.append(eventLogRaw ? { ...meta, raw: body } : meta);
      return next();
    });
  }

  // ── tenant gate (registry-driven since slice 2) ─────────────────────────
  // A tenant is SERVED iff the workspaces block grants it projects (home always is).
  // SLACK_ALLOWED_TEAMS stays honored as a transitional union. Unserved-but-installed
  // tenants aren't silently dropped anymore: App Home and slash/actions pass through
  // (their handlers render "not configured" — middleware can't ack()), and a mention/DM
  // gets ONE polite reply per channel per hour. Static-token mode has exactly one
  // workspace by construction — always served.
  // The predicate is hot-path cheap (no project list materialized) and FAIL-CLOSED:
  // an unresolved home tenant (first OAuth boot, empty store) serves nobody. Shared
  // with the write-button handlers in events.ts (see EventDeps.servedTenant).
  const allowedTeams = new Set(
    (process.env.SLACK_ALLOWED_TEAMS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
  );
  const servedTenant = (tenant: string | undefined): boolean => {
    if (!oauth) return true; // static mode: one workspace by construction
    return (
      !!homeTeamId &&
      !!tenant &&
      (tenant === homeTeamId ||
        allowedTeams.has(tenant) ||
        (reg.current.workspaces ? (entrySlugs(reg.current.workspaces[tenant])?.length ?? 0) > 0 : false))
    );
  };
  if (oauth) {
    const politeReplied = new RecentSet(60 * 60_000); // channel → polite-reply cooldown
    app.use(async ({ context, body, client, next }) => {
      const tenant = tenantOf(context as { teamId?: string; enterpriseId?: string; isEnterpriseInstall?: boolean });
      if (servedTenant(tenant)) return next();
      // Fail closed when home itself is unresolved (first boot): serve nobody.
      const b = body as { command?: string; type?: string; event?: { type?: string; channel?: string } };
      const evType = b.event?.type;
      // Lifecycle events must reach their handlers from ANY tenant — an uninstall from
      // an unserved-but-installed workspace is exactly the cleanup signal we want.
      if (evType === 'app_uninstalled' || evType === 'tokens_revoked') return next();
      // Surfaces whose handlers give the polite "not configured" answer themselves:
      if (evType === 'app_home_opened') return next(); // onboarding Home view (events.ts)
      if (b.command || b.type === 'block_actions' || b.type === 'view_submission') return next(); // ack() lives there
      if ((evType === 'app_mention' || evType === 'message') && b.event?.channel) {
        const ch = b.event.channel;
        if (politeReplied.claim(ch)) {
          await client.chat.postMessage({ channel: ch, text: notConfiguredText() }).catch(() => {});
        }
        return; // handled here — do not fall through to the handlers
      }
      eventLog?.append({ ...envelopeMeta(body, context as { teamId?: string }), decision: 'gated' });
      log.warn(`tenant gate: dropped a ${evType ?? b.type ?? 'unknown'} event from unserved tenant ${tenant ?? '(unknown)'}`);
    });
  }

  // Operator error alerts → a Slack channel (set AVEN_ALERT_CHANNEL to a channel id the bot is
  // in). Free-tier Sentry can't alert to Slack; the bot is already a Slack app, so it self-reports.
  // Best-effort + deduped (skip a repeat of the same message within the window) to avoid storms.
  const ALERT_CHANNEL = process.env.AVEN_ALERT_CHANNEL;
  const ALERT_DEDUPE_MS = 60_000;
  const recentAlerts = new Map<string, number>();
  if (ALERT_CHANNEL && homeClient) {
    const alertClient = homeClient; // alerts go to OUR workspace (the alert channel lives there)
    const PREFIX: Record<AlertLevel, string> = {
      error: ':rotating_light: CoachAven error:',
      warning: ':warning: CoachAven:',
      info: ':white_check_mark: CoachAven:',
    };
    setAlertSink((text: string, level: AlertLevel) => {
      const now = Date.now();
      const last = recentAlerts.get(text);
      if (last && now - last < ALERT_DEDUPE_MS) return; // same error just posted — skip
      recentAlerts.set(text, now);
      if (recentAlerts.size > 200) recentAlerts.clear(); // bound the map
      void alertClient.chat
        .postMessage({ channel: ALERT_CHANNEL, text: `${PREFIX[level]} ${text}`.slice(0, 2000) })
        .catch(() => {}); // never let an alert failure cascade (no log.error here → no loop)
    });
  }

  // Resolve our own bot user id so the message handler can ignore the very messages
  // that already trigger app_mention (avoids double-processing) — and, in static-token
  // mode, the home TEAM id: team-key logic needs it in both modes (auth.test knows both).
  const authInfo = homeClient ? await homeClient.auth.test() : undefined;
  const botUserId = authInfo?.user_id as string | undefined;
  if (!oauth) homeTeamId = authInfo?.team_id as string | undefined;

  const engine = createTurnEngine(cfg, store, reg);
  // Late-bound home getter: channels is built here, but homeTeamId was resolved above and
  // a future re-auth could in principle refresh it.
  const channels = createChannels(reg, () => homeTeamId);
  // Dispatch primitive (DISPATCH=1): proposals from the sandboxes' outboxes → buttons → side effects.
  const dispatcher = createDispatcher({ store, reg, engine, channels, clientFor: clientForTeam, home: () => homeTeamId, tz: ROUTINE_TZ });
  const pollers = createPollers(cfg, store, reg, clientForTeam, engine, channels, () => homeTeamId, dispatcher);

  registerEvents(app, { cfg, store, reg, engine, channels, botUserId, homeTeamId, servedTenant, dispatcher });
  registerCommands(app, { cfg, store, reg, engine, channels, pollers, homeTeamId });

  // Recovery order matters: reattach the turns that were RUNNING first, then replay the
  // journaled ones that were still queued (a replay waits for its key's recovery). Both
  // BEFORE app.start(): the journal drain must happen while no new event can append to it,
  // or a turn accepted in the gap would be replayed as a duplicate. The Web API client
  // works without the socket; events only flow once start() connects.
  // Each record resolves ITS OWN workspace's client (clientForTeam) — a client-team turn
  // finalizes with that team's token; an uninstalled team's record is cleared, not retried
  // forever. Guarded on homeClient: with no home install there are no records to recover.
  if (homeClient) {
    const driverFor = (t?: string) => slackDriver(clientForTeam(t));
    const recovering = engine.resumeInflightTurns(driverFor);
    engine.resumeQueuedTurns(driverFor, recovering);
  }

  await app.start();
  log.info(
    `Slack bot running (Socket Mode${oauth ? `, OAuth installs on :${oauth.port}` : ''}) — ${summary(reg.current)}`,
  );
  if (homeClient) pollers.startAll();

  // Retention: without it, chats/reviewedPrs grow by one record per thread/PR forever and
  // every save() rewrites the whole (ever larger) state.json several times per turn. Run
  // at boot AND daily — with graceful restarts the process may stay up for months.
  const DAY_MS = 24 * 60 * 60_000;
  const pruneState = () => {
    const chats = store.pruneChats(45 * DAY_MS);
    const prs = store.pruneReviewedPrs(90 * DAY_MS);
    if (chats || prs) log.info(`retention: pruned ${chats} idle chats, ${prs} reviewed-PR entries`);
  };
  pruneState();
  setInterval(pruneState, DAY_MS).unref();

  // Graceful shutdown: systemd's SIGTERM used to hard-kill the process mid-anything.
  // Close the socket first (Slack stops routing events here and redelivers unacked ones
  // on the next connect), then exit promptly — all state writes are synchronous, and
  // in-flight turns keep running in their sandboxes to be recovered on the next boot.
  // Deliberately NOT waiting for turns to finish: they can run 15 minutes, recovery is
  // exactly the mechanism built for them.
  let stopping = false;
  const shutdown = (sig: string) => {
    if (stopping) return;
    stopping = true;
    log.info(`${sig} — closing the Slack socket and exiting (in-flight turns recover on the next boot)`);
    void app
      .stop()
      .catch(() => {})
      .finally(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref(); // if app.stop() wedges, exit anyway
  };
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));
}
