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
import type { Config } from './config.js';
import { Store } from './state.js';
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
export async function runSlack(cfg: Config): Promise<void> {
  if (!cfg.slack) {
    throw new Error('Set SLACK_BOT_TOKEN and SLACK_APP_TOKEN to run the Slack bot.');
  }
  // Capture the bot token here: `cfg.slack` is narrowed non-undefined at this top level, but that
  // narrowing is lost inside the event-handler closures, where it's needed to fetch files.
  const slackBotToken = cfg.slack.botToken;
  // The registry travels as a mutable REF so a future runtime reload can swap `.current`
  // without re-wiring the engine/pollers/handlers that captured it.
  const reg: RegistryRef = { current: loadProjects(cfg.projectsConfigPath) };
  const store = new Store();
  const app = new App({
    token: cfg.slack.botToken,
    appToken: cfg.slack.appToken,
    socketMode: true,
  });

  // Operator error alerts → a Slack channel (set AVEN_ALERT_CHANNEL to a channel id the bot is
  // in). Free-tier Sentry can't alert to Slack; the bot is already a Slack app, so it self-reports.
  // Best-effort + deduped (skip a repeat of the same message within the window) to avoid storms.
  const ALERT_CHANNEL = process.env.AVEN_ALERT_CHANNEL;
  const ALERT_DEDUPE_MS = 60_000;
  const recentAlerts = new Map<string, number>();
  if (ALERT_CHANNEL) {
    setAlertSink((text: string) => {
      const now = Date.now();
      const last = recentAlerts.get(text);
      if (last && now - last < ALERT_DEDUPE_MS) return; // same error just posted — skip
      recentAlerts.set(text, now);
      if (recentAlerts.size > 200) recentAlerts.clear(); // bound the map
      void app.client.chat
        .postMessage({ channel: ALERT_CHANNEL, text: `:rotating_light: CoachAven error: ${text}`.slice(0, 2000) })
        .catch(() => {}); // never let an alert failure cascade (no log.error here → no loop)
    });
  }

  const engine = createTurnEngine(cfg, store, reg);
  const channels = createChannels(reg);
  const pollers = createPollers(cfg, store, reg, app.client, engine, channels);

  // Resolve our own bot user id so the message handler can ignore the very messages
  // that already trigger app_mention (avoids double-processing).
  const authTest = await app.client.auth.test({ token: cfg.slack.botToken });
  const botUserId = authTest.user_id as string | undefined;

  registerEvents(app, { cfg, store, reg, engine, channels, slackBotToken, botUserId });
  registerCommands(app, { cfg, store, reg, engine, channels, pollers });

  await app.start();
  log.info(`Slack bot running (Socket Mode) — ${summary(reg.current)}`);
  engine.resumeInflightTurns(app.client);
  pollers.startAll();
}
