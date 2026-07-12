// The Bolt bot's composition root: load config + registry, build the turn engine and
// channel resolver, register the Slack surfaces (events + /aven commands), start the
// pollers. The moving parts live in their own modules:
//   blocks.ts   — every Block Kit renderer + user-facing text helpers
//   turn.ts     — the turn engine (queues, live status, agent questions, recovery)
//   channels.ts — channel ↔ project resolution
//   commands.ts — the /aven router and subcommand handlers
//   events.ts   — @mentions, thread replies, DMs, buttons, App Home
//   pollers.ts  — scheduler + auto-review / autofix / YouTrack pollers
import bolt from '@slack/bolt';
import type { Installation } from '@slack/bolt';
import type { Config } from './config.js';
import { Store } from './state.js';
import { createInstallationStore } from './installations.js';
import { loadProjects, type RegistryRef } from './projects.js';
import { createTurnEngine } from './turn.js';
import { createChannels } from './channels.js';
import { createPollers } from './pollers.js';
import { registerCommands } from './commands.js';
import { registerEvents } from './events.js';
import { setAlertSink, summary } from './blocks.js';
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
  // The singleton concerns — alert sink, pollers, restart recovery — are HOME-workspace-only
  // in this slice (per-team pollers arrive with per-team registries). Under OAuth, app.client
  // has no token, so the home client is minted from the installation store: the seeded env
  // token, an explicit SLACK_HOME_TEAM_ID's record, or — on a first-ever OAuth boot with an
  // empty store — nothing, in which case those concerns stay off (with a loud warning) but
  // the bot still starts and serves /slack/install, so the first install can happen at all.
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

  // ── tenant gate (thin-slice security) ───────────────────────────────────
  // Until projects/state are per-team, EVERY installed workspace reaches OUR global
  // registry — and the /slack/install URL is public by design. So in OAuth mode, drop
  // events from any team that isn't the home workspace or explicitly allowlisted
  // (SLACK_ALLOWED_TEAMS, comma-separated team ids). Static-token mode has exactly one
  // workspace by construction — no gate. Remove when the per-team-registry slice lands.
  if (oauth) {
    const allowedTeams = new Set(
      (process.env.SLACK_ALLOWED_TEAMS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    );
    if (homeTeamId) allowedTeams.add(homeTeamId);
    app.use(async ({ context, next }) => {
      const team = (context.teamId ?? context.enterpriseId) as string | undefined;
      if (team && allowedTeams.has(team)) return next();
      // Deliberately silent toward the workspace (no bot post — we may not want to engage
      // at all); loud in our logs so an unexpected install is noticed.
      log.warn(`tenant gate: dropped an event from non-allowlisted team ${team ?? '(unknown)'}`);
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
    setAlertSink((text: string) => {
      const now = Date.now();
      const last = recentAlerts.get(text);
      if (last && now - last < ALERT_DEDUPE_MS) return; // same error just posted — skip
      recentAlerts.set(text, now);
      if (recentAlerts.size > 200) recentAlerts.clear(); // bound the map
      void alertClient.chat
        .postMessage({ channel: ALERT_CHANNEL, text: `:rotating_light: CoachAven error: ${text}`.slice(0, 2000) })
        .catch(() => {}); // never let an alert failure cascade (no log.error here → no loop)
    });
  }

  const engine = createTurnEngine(cfg, store, reg);
  const channels = createChannels(reg);
  // Pollers run against the home workspace. With no home client (first OAuth boot, empty
  // store) they're built but never started; a user-triggered fire (/aven routine run) would
  // fail with not_authed — acceptable until the home workspace is installed.
  const pollers = createPollers(cfg, store, reg, homeClient ?? app.client, engine, channels);

  // Resolve our own bot user id so the message handler can ignore the very messages
  // that already trigger app_mention (avoids double-processing). Home-team only — in
  // other workspaces the per-event context.botUserId covers it (see events.ts).
  const botUserId = homeClient ? ((await homeClient.auth.test()).user_id as string | undefined) : undefined;

  registerEvents(app, { cfg, store, reg, engine, channels, botUserId });
  registerCommands(app, { cfg, store, reg, engine, channels, pollers });

  // Recovery order matters: reattach the turns that were RUNNING first, then replay the
  // journaled ones that were still queued (a replay waits for its key's recovery). Both
  // BEFORE app.start(): the journal drain must happen while no new event can append to it,
  // or a turn accepted in the gap would be replayed as a duplicate. The Web API client
  // works without the socket; events only flow once start() connects.
  // Home-team client: recovering a turn that ran in a CLIENT workspace will finalize its
  // Slack message with the wrong token (a silent no-op) — a known limit of this slice;
  // the per-team-registry slice adds teamId to ChatRecord and resolves per record.
  if (homeClient) {
    const recovering = engine.resumeInflightTurns(homeClient);
    engine.resumeQueuedTurns(homeClient, recovering);
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
