// The /aven slash-command router and its subcommand handlers (status, access, schedule,
// routines, dream, memory, prompt, review, autofix, and the default private-answer path).
// Pure Slack-side orchestration: the heavy lifting lives in the turn engine, the pollers'
// fire* helpers, and the memory/journal modules.

import type bolt from '@slack/bolt';
import type { Config } from './config.js';
import type { Store } from './state.js';
import { loadProjects, resolveBySlug, type ProjectConfig, type RegistryRef } from './projects.js';
import type { TurnEngine } from './turn.js';
import type { Channels } from './channels.js';
import { ROUTINE_TZ, type Pollers } from './pollers.js';
import { parseSchedule, groupRoutinesBySlug } from './schedule.js';
import { mdToMrkdwn, parseTopics } from './format.js';
import { resolvePr } from './pr.js';
import { parseEffort, type ReviewEffort } from './prompts.js';
import { createDriver } from './driver.js';
import { projectCwd } from './project.js';
import { memoryFilePath } from './memory.js';
import { snapshotLog, memoryRepoDir, readSnapshotFile } from './memjournal.js';
import { HOUSEKEEPING_DEFAULT_CRON, HOUSEKEEPING_DEFAULT_SPEC, pruneThreshold } from './housekeeping.js';
import { countOpenPRs, getPrMeta, ciStatusForSha, listReviews } from './github.js';
import {
  CMD,
  MAX_SLACK_TEXT,
  info,
  errText,
  shortRepo,
  accessBlocks,
  statusReportBlocks,
  routineListBlocks,
  allRoutinesBlocks,
  topicButtons,
  type ProjectStatus,
  type StatusReport,
} from './blocks.js';
import { log } from './log.js';

const THINKING = ':hourglass_flowing_sand: thinking…';

export interface CommandDeps {
  cfg: Config;
  store: Store;
  reg: RegistryRef;
  engine: TurnEngine;
  channels: Channels;
  pollers: Pollers;
}

// Read a file from a project's Claude Code auto-memory dir (the sandbox copy). By default
// we do NOT wake a stopped sandbox — this box can't run the whole fleet warm, so forcing a
// start just to read can fail under resource pressure (and it's slow). `wake` (only set by
// `/aven memory live`) opts into starting it. `filePath` is already sanitized. Raw Daytona
// errors are wrapped so the user never sees an axios 500. Throws a friendly message otherwise.
export async function readMemory(
  cfg: Config,
  project: ProjectConfig,
  filePath: string,
  wake: boolean,
): Promise<string> {
  const driver = createDriver(cfg, project.driver);
  const name = `${cfg.sandbox.namePrefix}${project.slug}`;
  let sandbox = await driver.getSandbox(name);
  if (!sandbox) throw new Error('No sandbox for this project yet — nothing remembered.');
  if (!sandbox.started) {
    if (!wake) {
      throw new Error(
        `💤 The *${project.slug}* sandbox is asleep, so I can't read its live memory right now. ` +
          `Use \`${CMD} memory live\` to wake it, or just @-mention me — and once a dream runs, ` +
          `\`${CMD} memory\` serves the snapshot without waking it.`,
      );
    }
    try {
      // The sandbox exists (checked above), so ensure = wake it, not create.
      sandbox = await driver.ensureSandbox(name, project.slug);
    } catch (e) {
      log.error(`readMemory start ${name}: ${e instanceof Error ? e.message : String(e)}`);
      throw new Error(`Couldn't wake the *${project.slug}* sandbox just now — try again in a moment.`);
    }
  }
  let r;
  try {
    r = await sandbox.exec(`cat ${filePath} 2>/dev/null || true`);
  } catch (e) {
    log.error(`readMemory exec ${name}: ${e instanceof Error ? e.message : String(e)}`);
    throw new Error(`Couldn't read memory from the *${project.slug}* sandbox just now — try again in a moment.`);
  }
  const out = (r.result ?? '').trim().slice(0, MAX_SLACK_TEXT);
  if (!out) throw new Error('Nothing remembered yet for this project.');
  return out;
}

export function registerCommands(app: bolt.App, deps: CommandDeps): void {
  const { cfg, store, reg, engine, channels, pollers } = deps;

  // Gather a live snapshot for `/aven status`: per-project sandbox state (Daytona),
  // session count (state.json), conversations with a turn in flight (the in-memory
  // queues), and open-PR counts (GitHub). Every external call is best-effort so a single
  // failing dependency degrades to a ⚠️ rather than erroring the whole command.
  async function collectStatus(): Promise<StatusReport> {
    const registry = reg.current;
    const activeBySlug = new Map<string, number>();
    for (const key of engine.activeKeys()) {
      const slug = engine.slugForKey(key);
      if (slug) activeBySlug.set(slug, (activeBySlug.get(slug) ?? 0) + 1);
    }
    const sessionsBySlug = new Map<string, number>();
    for (const c of store.allChats()) sessionsBySlug.set(c.slug, (sessionsBySlug.get(c.slug) ?? 0) + 1);

    let states = new Map<string, string>();
    let daytonaOk = true;
    try {
      // The fleet may span providers (per-project `driver`) — merge the state maps of
      // every provider actually in use. Any provider failing degrades to the ⚠️ flag.
      const kinds = new Set(registry.projects.map((p) => p.driver ?? cfg.sandboxDriver));
      for (const kind of kinds) {
        for (const [n, s] of await createDriver(cfg, kind).listStates()) states.set(n, s);
      }
    } catch {
      daytonaOk = false;
    }

    const prCounts = await Promise.all(
      registry.projects.map((p) => countOpenPRs(cfg, p.repos).catch(() => undefined)),
    );
    const githubOk = prCounts.some((n) => n !== undefined);

    // Routine counts per project (reports vs dreams vs housekeeping) for the status line.
    const jobsBySlug = new Map<string, { jobs: number; dreams: number; hk: number }>();
    for (const r of store.listRoutines()) {
      const c = jobsBySlug.get(r.slug) ?? { jobs: 0, dreams: 0, hk: 0 };
      if (r.kind === 'dream') c.dreams++;
      else if (r.kind === 'housekeeping') c.hk++;
      else c.jobs++;
      jobsBySlug.set(r.slug, c);
    }

    const projects: ProjectStatus[] = registry.projects.map((p, i) => ({
      slug: p.slug,
      repos: p.repos.length,
      state: states.get(`${cfg.sandbox.namePrefix}${p.slug}`),
      sessions: sessionsBySlug.get(p.slug) ?? 0,
      active: activeBySlug.get(p.slug) ?? 0,
      openPRs: prCounts[i],
      jobs: jobsBySlug.get(p.slug)?.jobs ?? 0,
      dreams: jobsBySlug.get(p.slug)?.dreams ?? 0,
      hk: jobsBySlug.get(p.slug)?.hk ?? 0,
    }));
    return { projects, turnsInFlight: engine.runningCount(), daytonaOk, githubOk };
  }

  // ── /aven access → show what this channel's project exposes (repos + MCP) ────
  async function handleAccess(
    client: bolt.webApi.WebClient,
    channelId: string,
  ): Promise<{ text: string; blocks?: unknown[] }> {
    const { project } = await channels.pickProject(client, channelId, '');
    if (!project) {
      return {
        text: `:information_source: This channel isn't bound to a project. Use a \`${channels.prefix}<slug>\` channel, or ask in one of: ${reg.current.projects.map((p) => p.slug).join(', ')}.`,
      };
    }
    return { text: `Access for ${project.slug}`, blocks: accessBlocks(project) };
  }

  // ── /aven schedule → create a read-only report job bound to this channel ─────
  // Returns an ephemeral payload (text + optional blocks). The project is resolved from
  // the channel binding only (not the text), so a job can't be created in an unbound chat.
  async function handleSchedule(
    client: bolt.webApi.WebClient,
    channelId: string,
    userId: string,
    cmdText: string,
  ): Promise<{ text: string; blocks?: unknown[] }> {
    const usage =
      `Usage: \`${CMD} schedule <when> | <what to report>\`\n` +
      '`<when>` = `daily 9:00`, `weekdays 9:00`, `weekly mon 9:00`, or `cron 0 9 * * 1-5`' +
      ` (times in ${ROUTINE_TZ}).`;
    const rest = cmdText.slice('schedule'.length).trim();
    const bar = rest.indexOf('|');
    if (bar < 0) return { text: `:information_source: ${usage}` };
    const when = rest.slice(0, bar).trim();
    const prompt = rest.slice(bar + 1).trim();
    if (!when || !prompt) return { text: `:information_source: ${usage}` };

    const sched = parseSchedule(when);
    if ('error' in sched) return { text: `:x: ${sched.error}` };

    const { project } = await channels.pickProject(client, channelId, '');
    if (!project) {
      return {
        text: ':x: Schedule a job from a project channel (e.g. `' + `${channels.prefix}${reg.current.projects[0]?.slug ?? 'caldora'}` + '`).',
      };
    }
    const rec = store.addRoutine({
      slug: project.slug,
      channel: channelId,
      cron: sched.cron,
      tz: ROUTINE_TZ,
      spec: sched.spec,
      prompt,
      enabled: true,
      createdBy: userId,
    });
    return {
      text:
        `:white_check_mark: Scheduled *${rec.id}* — \`${rec.spec}\` (${ROUTINE_TZ}) for *${project.slug}*. ` +
        `I'll post the digest here. Read-only — I won't change code or open PRs.\n_Manage:_ \`${CMD} routines\``,
    };
  }

  // ── /aven routines [on|off|rm <id>] → list/manage this channel's report jobs ──
  function handleRoutines(channelId: string, cmdText: string): { text: string; blocks?: unknown[] } {
    const args = cmdText.split(/\s+/).slice(1); // drop the "routines" verb
    const sub = args[0]?.toLowerCase();
    if (!sub) {
      return { text: 'Scheduled jobs', blocks: routineListBlocks(store.listRoutines({ channel: channelId })) };
    }
    if (sub === 'all') {
      // Fleet-wide view: every project's jobs, grouped by project (works from any channel).
      return { text: 'All scheduled jobs', blocks: allRoutinesBlocks(groupRoutinesBySlug(store.listRoutines())) };
    }
    const id = args[1];
    if (!id) return { text: `:information_source: Usage: \`${CMD} routines all | run|on|off|rm <id>\`` };
    const r = store.getRoutine(id);
    if (!r || r.channel !== channelId) return { text: `:x: No job \`${id}\` in this channel.` };
    if (sub === 'off') {
      store.patchRoutine(id, { enabled: false });
      return { text: `:white_check_mark: Paused *${id}*.` };
    }
    if (sub === 'on') {
      store.patchRoutine(id, { enabled: true });
      return { text: `:white_check_mark: Resumed *${id}*.` };
    }
    if (sub === 'rm' || sub === 'remove' || sub === 'delete') {
      store.deleteRoutine(id);
      return { text: `:white_check_mark: Deleted *${id}*.` };
    }
    return { text: `:information_source: Usage: \`${CMD} routines all | run|on|off|rm <id>\`` };
  }

  // ── /aven dream [on|off] → enable/disable nightly memory consolidation for this project ──
  // 'now' is handled in the command handler (it needs the client to fire). Bare = status.
  // One dream routine per project channel (kind: 'dream'); reuses the routine scheduler.
  const DREAM_DEFAULT_CRON = '0 3 * * *'; // 03:00 daily, in ROUTINE_TZ
  function handleDream(channelId: string, userId: string, slug: string | undefined, cmdText: string): { text: string } {
    if (!slug) return { text: `:x: Use \`${CMD} dream\` from a project channel.` };
    const sub = cmdText.split(/\s+/)[1]?.toLowerCase();
    const existing = store.listRoutines({ channel: channelId }).find((r) => r.kind === 'dream');
    if (sub === 'off') {
      if (!existing) return { text: ':information_source: No dreaming scheduled here.' };
      store.patchRoutine(existing.id, { enabled: false });
      return { text: `:white_check_mark: Dreaming paused for *${slug}*.` };
    }
    if (sub === 'on') {
      if (existing) {
        store.patchRoutine(existing.id, { enabled: true });
        return { text: `:crescent_moon: Dreaming on for *${slug}* — \`${existing.spec}\` (${existing.tz}).` };
      }
      const rec = store.addRoutine({
        slug,
        channel: channelId,
        cron: DREAM_DEFAULT_CRON,
        tz: ROUTINE_TZ,
        spec: 'daily 3:00',
        prompt: '',
        enabled: true,
        createdBy: userId,
        kind: 'dream',
      });
      return {
        text: `:crescent_moon: Dreaming on for *${slug}* — \`${rec.spec}\` (${ROUTINE_TZ}). I'll quietly consolidate memory; \`${CMD} dream\` shows the last digest.`,
      };
    }
    // bare / status
    if (!existing) {
      return { text: `:crescent_moon: No dreaming for *${slug}*. Enable nightly memory consolidation: \`${CMD} dream on\`.` };
    }
    const state = existing.enabled ? '🟢 on' : '⚪️ off';
    const last = existing.lastRunAt ? `\nLast run: ${existing.lastRunAt.slice(0, 16).replace('T', ' ')}` : '';
    const digest = existing.lastSummary ? `\nLast: _${existing.lastSummary}_` : '';
    return {
      text: `:crescent_moon: *Dreaming — ${slug}* ${state} · \`${existing.spec}\` (${existing.tz})${last}${digest}\n_Manage:_ \`${CMD} dream on|off|now\``,
    };
  }

  // ── /aven housekeeping [on|off] → nightly sandbox janitor for this project ──
  // Mirrors handleDream ('now' fires in the command handler — it needs the client). One
  // housekeeping routine per project channel (kind: 'housekeeping'), on the same scheduler.
  function handleHousekeeping(channelId: string, userId: string, slug: string | undefined, cmdText: string): { text: string } {
    if (!slug) return { text: `:x: Use \`${CMD} housekeeping\` from a project channel.` };
    const sub = cmdText.split(/\s+/)[1]?.toLowerCase();
    const existing = store.listRoutines({ channel: channelId }).find((r) => r.kind === 'housekeeping');
    if (sub === 'off') {
      if (!existing) return { text: ':information_source: No housekeeping scheduled here.' };
      store.patchRoutine(existing.id, { enabled: false });
      return { text: `:white_check_mark: Housekeeping paused for *${slug}*.` };
    }
    if (sub === 'on') {
      if (existing) {
        store.patchRoutine(existing.id, { enabled: true });
        return { text: `:broom: Housekeeping on for *${slug}* — \`${existing.spec}\` (${existing.tz}).` };
      }
      const rec = store.addRoutine({
        slug,
        channel: channelId,
        cron: HOUSEKEEPING_DEFAULT_CRON,
        tz: ROUTINE_TZ,
        spec: HOUSEKEEPING_DEFAULT_SPEC,
        prompt: '',
        enabled: true,
        createdBy: userId,
        kind: 'housekeeping',
      });
      return {
        text: `:broom: Housekeeping on for *${slug}* — \`${rec.spec}\` (${ROUTINE_TZ}). Nightly janitor: dockerd guard, docker prune past ${pruneThreshold()}% disk, stale-worktree reap. \`${CMD} housekeeping\` shows the last run.`,
      };
    }
    // bare / status
    if (!existing) {
      return { text: `:broom: No housekeeping for *${slug}*. Enable the nightly sandbox janitor: \`${CMD} housekeeping on\`.` };
    }
    const state = existing.enabled ? '🟢 on' : '⚪️ off';
    const last = existing.lastRunAt ? `\nLast run: ${existing.lastRunAt.slice(0, 16).replace('T', ' ')}` : '';
    const digest = existing.lastSummary ? `\nLast: _${existing.lastSummary}_` : '';
    return {
      text: `:broom: *Housekeeping — ${slug}* ${state} · \`${existing.spec}\` (${existing.tz})${last}${digest}\n_Manage:_ \`${CMD} housekeeping on|off|now\``,
    };
  }

  // ── /aven → private answer in the user's DM (per project) ───────────────────
  app.command(CMD, async ({ command, ack, respond, client }) => {
    await ack(); // Slack needs an ack within 3s; the real work runs after.

    const cmdText = (command.text ?? '').trim();
    const verb = cmdText.split(/\s+/)[0]?.toLowerCase();

    // `/aven status` → a live ops snapshot (sandboxes, sessions, in-flight turns, PRs).
    // Reserved keyword, intercepted before project resolution so it works in ANY channel
    // (it's a fleet-wide view, not bound to one project).
    if (verb === 'status') {
      await respond({ response_type: 'ephemeral', text: ':bar_chart: Gathering status…' });
      try {
        const report = await collectStatus();
        await respond({
          response_type: 'ephemeral',
          replace_original: true,
          text: 'CoachAven status',
          blocks: statusReportBlocks(report),
        });
      } catch (err) {
        await respond({ response_type: 'ephemeral', replace_original: true, text: errText(err) });
      }
      return;
    }

    // `/aven usage [days]` → token/cost/turn attribution per project (and per workspace
    // once multiple teams exist) over the last N days (default 30, max 90). Fleet-wide
    // like `status`: works in any channel; reads the usage/<month>.jsonl meter (turn.ts).
    if (verb === 'usage') {
      const days = Math.min(90, Math.max(1, Math.floor(Number(cmdText.split(/\s+/)[1])) || 30));
      try {
        await respond({ response_type: 'ephemeral', text: engine.usageReport(days) });
      } catch (err) {
        await respond({ response_type: 'ephemeral', text: errText(err) });
      }
      return;
    }

    // `/aven reload` → re-read projects.config.json + projects.d/*.md and swap the live
    // registry (see docs/runtime-config.md "Hot-reload"). No restart: everything holds the
    // RegistryRef and reads `.current` per use. Scope honesty: prompts/MCP are baked into a
    // session at openChat, so running conversations keep their current setup until their
    // persistent claude process ends — new sessions pick up the new config immediately.
    // A parse/validation failure leaves the old registry in place.
    if (verb === 'reload') {
      try {
        const before = reg.current.projects.map((p) => p.slug);
        const next = loadProjects(cfg.projectsConfigPath);
        reg.current = next;
        const after = next.projects.map((p) => p.slug);
        const added = after.filter((s) => !before.includes(s));
        const removed = before.filter((s) => !after.includes(s));
        const delta = [
          added.length ? `added: ${added.join(', ')}` : '',
          removed.length ? `removed: ${removed.join(', ')}` : '',
        ]
          .filter(Boolean)
          .join(' · ');
        await respond({
          response_type: 'ephemeral',
          text: `:arrows_counterclockwise: Config reloaded — ${after.length} project(s)${delta ? ` (${delta})` : ''}. New prompts/MCP apply to new sessions; running conversations keep their current setup.`,
        });
      } catch (err) {
        await respond({
          response_type: 'ephemeral',
          text: `${errText(err)}\n_The previous config stays active._`,
        });
      }
      return;
    }

    // `/aven access` → what this channel's project gives me (repos + MCP tools).
    if (verb === 'access') {
      await respond({ response_type: 'ephemeral', ...(await handleAccess(client, command.channel_id)) });
      return;
    }

    // `/aven schedule <when> | <prompt>` → create a read-only report job in this channel.
    if (verb === 'schedule') {
      const r = await handleSchedule(client, command.channel_id, command.user_id, cmdText);
      await respond({ response_type: 'ephemeral', ...r });
      return;
    }
    // `/aven routines [run|on|off|rm <id>]` → list/manage this channel's report jobs.
    if (verb === 'routines') {
      const rargs = cmdText.split(/\s+/).slice(1);
      if (rargs[0]?.toLowerCase() === 'run') {
        // Fire a job on demand (testing / "run the digest now") — needs the client, so
        // it's handled here rather than in the pure handleRoutines.
        const id = rargs[1];
        const r = id ? store.getRoutine(id) : undefined;
        if (!r || r.channel !== command.channel_id) {
          await respond({ response_type: 'ephemeral', text: `:x: No job \`${id ?? ''}\` in this channel.` });
          return;
        }
        const ok = pollers.fireRoutine(client, r);
        await respond({
          response_type: 'ephemeral',
          text: ok ? `:rocket: Running *${r.id}* now…` : `:hourglass_flowing_sand: *${r.id}* is already running.`,
        });
        return;
      }
      await respond({ response_type: 'ephemeral', ...handleRoutines(command.channel_id, cmdText) });
      return;
    }
    // `/aven dream [on|off|now]` → nightly memory consolidation (Dreaming) for this project.
    if (verb === 'dream') {
      const { project } = await channels.pickProject(client, command.channel_id, '');
      const sub = cmdText.split(/\s+/)[1]?.toLowerCase();
      if (sub === 'now') {
        const r = store.listRoutines({ channel: command.channel_id }).find((x) => x.kind === 'dream');
        if (!r) {
          await respond({ response_type: 'ephemeral', text: `:information_source: No dream here yet — \`${CMD} dream on\` first.` });
          return;
        }
        const ok = pollers.fireRoutine(client, r);
        await respond({
          response_type: 'ephemeral',
          text: ok
            ? ':crescent_moon: Dreaming now… (silent — check `' + CMD + ' dream` for the digest)'
            : ':hourglass_flowing_sand: A turn is in flight for this project — try again shortly.',
        });
        return;
      }
      await respond({ response_type: 'ephemeral', ...handleDream(command.channel_id, command.user_id, project?.slug, cmdText) });
      return;
    }
    // `/aven housekeeping [on|off|now]` → the nightly sandbox janitor (docs/housekeeping.md).
    if (verb === 'housekeeping' || verb === 'hk') {
      const { project } = await channels.pickProject(client, command.channel_id, '');
      const sub = cmdText.split(/\s+/)[1]?.toLowerCase();
      if (sub === 'now') {
        const r = store.listRoutines({ channel: command.channel_id }).find((x) => x.kind === 'housekeeping');
        if (!r) {
          await respond({ response_type: 'ephemeral', text: `:information_source: No housekeeping here yet — \`${CMD} housekeeping on\` first.` });
          return;
        }
        const ok = pollers.fireRoutine(client, r);
        await respond({
          response_type: 'ephemeral',
          text: ok
            ? ':broom: Housekeeping running… (silent — check `' + CMD + ' housekeeping` for the digest)'
            : ':hourglass_flowing_sand: A turn is in flight for this project — try again shortly.',
        });
        return;
      }
      await respond({ response_type: 'ephemeral', ...handleHousekeeping(command.channel_id, command.user_id, project?.slug, cmdText) });
      return;
    }

    // `/aven memory [topic|log|live]` → read the agent's learned memory (read-only, private).
    // Default reads the journaled host snapshot (no sandbox wake); `live` forces the sandbox's
    // current state, `log` shows the snapshot history. (`/aven prompt` shows the deliberate layer.)
    if (verb === 'memory') {
      const { project, error } = await channels.pickProject(client, command.channel_id, '');
      if (error || !project) {
        await respond({ response_type: 'ephemeral', text: info(error ?? 'No project bound to this channel.') });
        return;
      }
      const args = cmdText.split(/\s+/);
      const sub = args[1]?.toLowerCase();

      if (sub === 'log') {
        try {
          const lines = await snapshotLog(memoryRepoDir(project.slug));
          const body = lines.length
            ? lines.map((l) => `• ${l}`).join('\n')
            : '_No snapshots yet — memory is journaled after each dream (`' + CMD + ' dream`)._';
          await respond({
            response_type: 'ephemeral',
            text: `*Memory journal — ${project.slug}*\n${body}`.slice(0, MAX_SLACK_TEXT),
          });
        } catch (err) {
          await respond({ response_type: 'ephemeral', text: errText(err) });
        }
        return;
      }

      const liveRead = sub === 'live';
      const topic = liveRead ? args[2] : args[1];
      const file = memoryFilePath(projectCwd(cfg, project.slug, project.repos), topic);
      if (!file) {
        await respond({ response_type: 'ephemeral', text: ':x: Invalid topic name (use letters, digits, `_` or `-`).' });
        return;
      }
      const fileName = file.split('/').pop() as string;

      // Render: the index (no topic) gets a drill-down button per topic file it links; a
      // specific topic is just text. `note` is an optional footer (e.g. the snapshot caveat).
      const deliver = async (content: string, note: string) => {
        const topics = topic ? [] : parseTopics(content);
        if (topics.length) {
          await respond({
            response_type: 'ephemeral',
            replace_original: true,
            text: `Memory — ${project.slug}`,
            blocks: [
              { type: 'section', text: { type: 'mrkdwn', text: `${mdToMrkdwn(content)}${note}`.slice(0, 2900) } },
              ...topicButtons(project.slug, topics),
            ],
          });
        } else {
          await respond({
            response_type: 'ephemeral',
            replace_original: true,
            text: `${mdToMrkdwn(content)}${note}`.slice(0, MAX_SLACK_TEXT),
          });
        }
      };

      // Prefer the journaled host copy (no sandbox wake) unless `live` was requested.
      if (!liveRead) {
        try {
          const snap = await readSnapshotFile(memoryRepoDir(project.slug), fileName);
          if (snap) {
            await deliver(snap, `\n\n_(last dream snapshot — \`${CMD} memory live\` for the sandbox's current state)_`);
            return;
          }
        } catch {
          /* no journal yet → fall through to the live read */
        }
      }

      await respond({ response_type: 'ephemeral', text: ':brain: Reading memory…' });
      try {
        await deliver(await readMemory(cfg, project, file, liveRead), '');
      } catch (err) {
        await respond({ response_type: 'ephemeral', replace_original: true, text: errText(err) });
      }
      return;
    }

    // `/aven prompt` → show this project's system prompt (the deliberate layer). Read-only;
    // editing it from Slack is a separate runtime-config feature (see docs/runtime-config.md).
    if (verb === 'prompt') {
      const { project, error } = await channels.pickProject(client, command.channel_id, '');
      if (error || !project) {
        await respond({ response_type: 'ephemeral', text: info(error ?? 'No project bound to this channel.') });
        return;
      }
      const body = project.systemPrompt?.trim()
        ? project.systemPrompt.trim()
        : "_No project-specific prompt set — the orchestrator base prompt and each repo's CLAUDE.md still apply._";
      await respond({
        response_type: 'ephemeral',
        text: `*System prompt — ${project.slug}*\n\n${mdToMrkdwn(body)}`.slice(0, MAX_SLACK_TEXT),
      });
      return;
    }

    // `/aven review <PR url|#num>` → on-demand, read-only PR review. The PR's repo picks
    // the project, so this works in DMs and any channel (not just a project-bound one).
    if (verb === 'review') {
      const arg = cmdText.slice('review'.length).trim();

      // `/aven review auto [on|off]` → per-project auto-review toggle (channel-bound).
      if (arg.split(/\s+/)[0]?.toLowerCase() === 'auto') {
        const { project, error } = await channels.pickProject(client, command.channel_id, '');
        if (error || !project) {
          await respond({ response_type: 'ephemeral', text: info(error ?? 'Run `review auto` in a project channel.') });
          return;
        }
        const words = arg.split(/\s+/);
        const onoff = words[1]?.toLowerCase();
        if (onoff === 'on') {
          store.patchProjectSettings(project.slug, {
            autoReview: true,
            autoReviewSince: new Date().toISOString(),
            autoReviewChannel: command.channel_id,
            autoReviewEffort: parseEffort(words[2]) ?? 'med',
          });
          const eff = store.getProjectSettings(project.slug).autoReviewEffort;
          await respond({ response_type: 'ephemeral', text: `:white_check_mark: Auto-review *ON* (${eff}) for *${project.slug}* — I'll review new (non-bot) PRs here as they open.` });
        } else if (onoff === 'off') {
          store.patchProjectSettings(project.slug, { autoReview: false });
          await respond({ response_type: 'ephemeral', text: `:white_check_mark: Auto-review *OFF* for *${project.slug}*.` });
        } else {
          const s = store.getProjectSettings(project.slug);
          await respond({ response_type: 'ephemeral', text: `Auto-review for *${project.slug}*: ${s.autoReview ? `:large_green_circle: ON (${s.autoReviewEffort ?? 'med'})` : ':white_circle: OFF'}. Toggle: \`${CMD} review auto on|off [low|med|high]\`.` });
        }
        return;
      }

      if (!arg) {
        await respond({ response_type: 'ephemeral', text: `:information_source: Usage: \`${CMD} review <PR url or #number> [low|med|high]\` (or \`${CMD} review auto on|off\`)` });
        return;
      }
      // An optional trailing low|med|high token sets the effort; the rest is the PR ref.
      const tokens = arg.split(/\s+/);
      const effort: ReviewEffort = parseEffort(tokens[tokens.length - 1]) ?? 'med';
      const refText = parseEffort(tokens[tokens.length - 1]) ? tokens.slice(0, -1).join(' ') : arg;
      const channelSlug = (await channels.pickProject(client, command.channel_id, '')).project?.slug;
      const t = resolvePr(refText, reg.current.projects, channelSlug);
      if ('error' in t) {
        await respond({ response_type: 'ephemeral', text: `:x: ${t.error}` });
        return;
      }
      const project = resolveBySlug(reg.current, t.slug);
      if (!project) {
        await respond({ response_type: 'ephemeral', text: `:x: Unknown project ${t.slug}.` });
        return;
      }
      const fired = pollers.fireReview(client, project, t.repo, t.number, command.channel_id, effort);
      await respond({
        response_type: 'ephemeral',
        text: fired
          ? `:eyes: Reviewing ${shortRepo(t.repo)}#${t.number} (${effort})…`
          : `:hourglass_flowing_sand: Already reviewing ${shortRepo(t.repo)}#${t.number}.`,
      });
      return;
    }

    // `/aven autofix <PR>` → watch a PR's CI + reviews and ping here with a Fix button.
    //   `/aven autofix off <PR>` unsubscribes; `/aven autofix list` lists this channel's.
    if (verb === 'autofix') {
      const arg = cmdText.slice('autofix'.length).trim();
      const first = arg.split(/\s+/)[0]?.toLowerCase();

      if (first === 'list') {
        const ws = store.listPrWatches({ channel: command.channel_id });
        const body = ws.length
          ? ws.map((w) => `• *${shortRepo(w.repo)}#${w.number}*`).join('\n')
          : `_No PRs watched here._ Subscribe: \`${CMD} autofix <PR url or #number>\``;
        await respond({ response_type: 'ephemeral', text: `*Watched PRs*\n${body}` });
        return;
      }

      const channelSlug = (await channels.pickProject(client, command.channel_id, '')).project?.slug;
      const refText = first === 'off' ? arg.slice('off'.length).trim() : arg;
      if (!refText) {
        await respond({ response_type: 'ephemeral', text: `:information_source: Usage: \`${CMD} autofix <PR url or #number>\` (\`off <PR>\`, \`list\`)` });
        return;
      }
      const t = resolvePr(refText, reg.current.projects, channelSlug);
      if ('error' in t) {
        await respond({ response_type: 'ephemeral', text: `:x: ${t.error}` });
        return;
      }
      const watchKey = `${t.repo}#${t.number}`;

      if (first === 'off') {
        const removed = store.deletePrWatch(watchKey);
        await respond({
          response_type: 'ephemeral',
          text: removed ? `:white_check_mark: Stopped watching ${shortRepo(t.repo)}#${t.number}.` : `:information_source: Not watching ${shortRepo(t.repo)}#${t.number}.`,
        });
        return;
      }

      // Subscribe: baseline the cursors off the PR's current CI + reviews so only changes ping.
      const meta = await getPrMeta(cfg, t.repo, t.number);
      if (!meta) {
        await respond({ response_type: 'ephemeral', text: `:x: Couldn't read ${shortRepo(t.repo)}#${t.number} — check the number.` });
        return;
      }
      if (meta.state === 'closed') {
        await respond({ response_type: 'ephemeral', text: `:information_source: ${shortRepo(t.repo)}#${t.number} is already ${meta.merged ? 'merged' : 'closed'}.` });
        return;
      }
      const ci = await ciStatusForSha(cfg, t.repo, meta.headSha);
      const reviews = await listReviews(cfg, t.repo, t.number);
      store.setPrWatch(watchKey, {
        repo: t.repo,
        number: t.number,
        slug: t.slug,
        channel: command.channel_id,
        createdBy: command.user_id,
        createdAt: new Date().toISOString(),
        lastCiSha: meta.headSha,
        lastCiConclusion: ci,
        lastReviewId: reviews.reduce((m, r) => Math.max(m, r.id), 0),
      });
      await respond({
        response_type: 'ephemeral',
        text: `:eye: Watching *${shortRepo(t.repo)}#${t.number}* — I'll ping here on CI failures or new reviews, with a *Fix* button. (CI now: ${ci})`,
      });
      return;
    }

    const { project, question, error } = await channels.pickProject(client, command.channel_id, command.text ?? '');
    if (error) {
      await respond({ response_type: 'ephemeral', text: info(error) });
      return;
    }
    if (!question) {
      await respond({ response_type: 'ephemeral', text: `Ask me something: \`${CMD} <your question>\`` });
      return;
    }
    const key = `cmd:${command.user_id}:${project!.slug}`;
    let dm: string | undefined;
    try {
      const im = await client.conversations.open({ users: command.user_id });
      dm = im.channel?.id;
    } catch {
      dm = undefined; // no im:write — fall back to ephemeral below
    }

    if (dm) {
      await respond({ response_type: 'ephemeral', text: ':envelope_with_arrow: Answering you in DM…' });
      await engine.liveTurn(client, dm, undefined, undefined, key, project!, question);
      return;
    }
    // Fallback: private (ephemeral) answer right here in the channel. Sent as text (mrkdwn),
    // NOT answerBlocks — the ephemeral respond/response_url path rejects Slack `markdown` blocks
    // with a 500 (the same bug fixed for /aven memory & prompt).
    await respond({ response_type: 'ephemeral', text: THINKING });
    try {
      const answer = await engine.runAsk(key, project!, question);
      await respond({
        response_type: 'ephemeral',
        replace_original: true,
        text: mdToMrkdwn(answer).slice(0, MAX_SLACK_TEXT),
      });
    } catch (err) {
      await respond({ response_type: 'ephemeral', replace_original: true, text: errText(err) });
    }
  });
}
