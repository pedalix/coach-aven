// Slack presentation layer: every Block Kit renderer plus the shared user-facing text
// helpers (info/errText) and the CMD constant they embed. No Bolt handlers, no Daytona,
// no state mutation (except the alert sink hook) — just payload shaping, so the Slack
// wiring in events.ts/commands.ts stays thin.

import type { RoutineRecord, PrWatch } from './state.js';
import type { ProjectConfig, ProjectsRegistry } from './projects.js';
import type { AskQuestion } from './claudeSession.js';
import { prUrls } from './format.js';
import { log } from './log.js';
import { captureError } from './sentry.js';

// Slack hard-caps a single message at 40k chars; leave headroom.
export const MAX_SLACK_TEXT = 39000;

// The slash command this bot answers to. DEV runs a SEPARATE Slack app in the same
// workspace (e.g. devcoachaven), and Slack forbids two apps owning the same command — so
// dev sets SLACK_COMMAND (e.g. /dev-aven) to match its app's manifest. Default: /aven.
// Used for both the Bolt registration and every user-facing help string.
export const CMD = ((c) => (c.startsWith('/') ? c : `/${c}`))((process.env.SLACK_COMMAND || '/aven').trim());

// Slack's `markdown` block renders standard Markdown (bold, headers, lists, links,
// tables) natively — so we send Claude's output verbatim instead of converting to
// the lossy legacy mrkdwn. Each markdown block caps ~12k chars; chunk longer answers.
const SLACK_MD_BLOCK_LIMIT = 11900;

// Context a completed answer needs to offer a one-click "Open a PR" follow-up: which
// conversation to enqueue the turn under, and where to post it.
export interface FollowUp {
  key: string;
  channel: string;
  threadTs?: string;
}

// Render the answer as markdown block(s), then an action row: link buttons to any PR(s)
// the agent opened, or — if it didn't open one — an "Open a PR" button that enqueues a
// follow-up turn (only when `followUp` context is supplied, i.e. a live thread/DM turn).
// Chunk text into Slack `markdown` blocks (each caps ~12k chars). Used by answerBlocks for the
// bot's answers (delivered via chat.update, which accepts `markdown` blocks). NOT for the
// ephemeral `respond` path — that rejects `markdown` blocks, so /aven memory|prompt use text.
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Slack 'markdown' block not yet in SDK block union
function markdownBlocks(text: string): any[] {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const blocks: any[] = [];
  for (let i = 0; i < text.length; i += SLACK_MD_BLOCK_LIMIT) {
    blocks.push({ type: 'markdown', text: text.slice(i, i + SLACK_MD_BLOCK_LIMIT) });
  }
  if (!blocks.length) blocks.push({ type: 'markdown', text: '(no output)' });
  return blocks;
}

// Drill-down buttons for a memory index: one button per topic file, carrying {s:slug, f:file}
// for the `mem_open:` handler. Capped at 24 (Slack's 25-element actions-block limit). `actions`
// buttons — unlike the `markdown` block — render fine over the ephemeral respond path.
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Slack block union
export function topicButtons(slug: string, topics: { title: string; file: string }[]): any[] {
  return [
    {
      type: 'actions',
      elements: topics.slice(0, 24).map((t, i) => ({
        type: 'button',
        text: { type: 'plain_text', text: (t.title || t.file).slice(0, 75) },
        action_id: `mem_open:${i}`,
        value: JSON.stringify({ s: slug, f: t.file }),
      })),
    },
  ];
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Slack 'markdown' block not yet in SDK block union
export function answerBlocks(answer: string, followUp?: FollowUp): any[] {
  const blocks = markdownBlocks(answer);

  const prs = prUrls(answer);
  if (prs.length) {
    blocks.push({
      type: 'actions',
      elements: prs.slice(0, 5).map((url, i) => ({
        type: 'button',
        text: { type: 'plain_text', text: prs.length === 1 ? '🔗 View PR' : `🔗 PR #${url.split('/').pop()}` },
        url,
        action_id: `pr_link:${i}`,
      })),
    });
  } else if (followUp) {
    blocks.push({
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: '🔀 Open a PR' },
          action_id: 'make_pr',
          value: JSON.stringify({ key: followUp.key, channel: followUp.channel, threadTs: followUp.threadTs }),
          // Native Slack confirm dialog — "Open a PR" turns discussion into code changes, so
          // gate it behind an explicit OK. Cancel just dismisses (nothing runs).
          confirm: {
            title: { type: 'plain_text', text: 'Start coding on this thread?' },
            text: { type: 'mrkdwn', text: "I'll start working in this project's sandbox and open a pull request with the changes for review. Proceed?" },
            confirm: { type: 'plain_text', text: 'Start' },
            deny: { type: 'plain_text', text: 'Cancel' },
          },
        },
      ],
    });
  }
  return blocks;
}

// Live status as a section + a "✖ Cancel" button carrying the turnId. Used while a turn
// runs; replaced by the answer (markdown blocks) or a plain status on cancel/error.
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Slack block union
export function statusBlocks(text: string, turnId: string): any[] {
  return [
    { type: 'section', text: { type: 'mrkdwn', text: text || '…' } },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: '✖ Cancel' },
          action_id: 'cancel_turn',
          value: turnId,
        },
      ],
    },
  ];
}

// Render an AskUserQuestion prompt as Slack blocks. `picks` = chosen option indices per
// question (selected options get a ✓). When `done`, render a buttonless summary. For
// multi-select questions a single "Submit" button finalizes. Button `value` carries ONLY
// indices {qid,qi,oi} (never the label) so it can't blow Slack's 2000-char value cap.
// Slack allows max 25 elements per actions block; we cap options at 24 and note any drop.
const MAX_OPTION_BUTTONS = 24;
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Slack block union
export function questionBlocks(
  questions: AskQuestion[],
  picks: Map<number, Set<number>>,
  multi: boolean,
  qid: string,
  done: boolean,
): any[] {
  const intro = done
    ? '✅ *Answered*'
    : `❓ *The agent needs your input*${multi ? '  _(pick one or more, then Submit)_' : ''}`;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const blocks: any[] = [{ type: 'section', text: { type: 'mrkdwn', text: intro } }];

  questions.forEach((q, qi) => {
    const set = picks.get(qi) ?? new Set<number>();
    const head = `*${q.header ? `${q.header}: ` : ''}${q.question}*`;
    const shown = q.options.slice(0, MAX_OPTION_BUTTONS);
    const dropped = q.options.length - shown.length;
    const optLines = shown
      .map((o, oi) => `${set.has(oi) ? '✅' : '•'} *${o.label}*${o.description ? ` — ${o.description}` : ''}`)
      .join('\n');
    const note = dropped > 0 ? `\n_(+${dropped} more not shown — reply in thread to pick)_` : '';
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `${head}\n${optLines}${note}` } });
    if (!done) {
      blocks.push({
        type: 'actions',
        block_id: `${qid}:${qi}`,
        // action_id must be UNIQUE within a message — Slack rejects duplicates. Routed via
        // the `answer_q:` regex handler; value carries only indices (label-length-safe).
        elements: shown.map((o, oi) => ({
          type: 'button',
          text: { type: 'plain_text', text: o.label.slice(0, 75) },
          action_id: `answer_q:${qid}:${qi}:${oi}`,
          value: JSON.stringify({ qid, qi, oi }),
        })),
      });
    }
  });

  if (multi && !done) {
    blocks.push({
      type: 'actions',
      block_id: `${qid}:submit`,
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Submit' },
          style: 'primary',
          action_id: `submit_q:${qid}`,
          value: JSON.stringify({ qid }),
        },
      ],
    });
  }
  return blocks;
}

// ── `/aven status` rendering ────────────────────────────────────────────────
export interface ProjectStatus {
  slug: string;
  repos: number;
  state?: string; // Daytona sandbox state; undefined = sandbox never created
  sessions: number; // conversations bound to this project in state.json
  active: number; // conversations with a turn in flight right now
  openPRs?: number; // undefined = couldn't be determined
  jobs: number; // scheduled report routines
  dreams: number; // scheduled dream routines
  hk: number; // scheduled housekeeping routines
}
export interface StatusReport {
  projects: ProjectStatus[];
  turnsInFlight: number;
  daytonaOk: boolean;
  githubOk: boolean;
}

function stateLabel(state?: string): string {
  if (!state) return '🌑 not created';
  if (state === 'started') return '✅ started';
  if (state === 'stopped') return '💤 stopped';
  return `⚠️ ${state}`;
}
export const plural = (n: number, w: string): string => `${n} ${w}${n === 1 ? '' : 's'}`;

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Slack block union
export function statusReportBlocks(r: StatusReport): any[] {
  const head = `*CoachAven — live*  ·  ${plural(r.projects.length, 'project')} · ${plural(r.turnsInFlight, 'turn')} in flight`;
  const lines = r.projects.map((p) => {
    const bits = [stateLabel(p.state), plural(p.repos, 'repo'), plural(p.sessions, 'session'), `${p.active} active`];
    if (p.openPRs !== undefined) bits.push(plural(p.openPRs, 'open PR'));
    if (p.jobs) bits.push(plural(p.jobs, 'job'));
    if (p.dreams) bits.push(`${p.dreams} 🌙`);
    if (p.hk) bits.push(`${p.hk} 🧹`);
    return `• *${p.slug}* — ${bits.join(' · ')}`;
  });
  const health = `_Daytona ${r.daytonaOk ? '✅' : '⚠️'} · GitHub ${r.githubOk ? '✅' : '⚠️'} · Slack ✅_`;
  return [{ type: 'section', text: { type: 'mrkdwn', text: `${head}\n\n${lines.join('\n')}\n\n${health}` } }];
}

// "Org/name" → "name", for compact display.
export const shortRepo = (full: string): string => full.split('/').pop() ?? full;

// ── /aven access ────────────────────────────────────────────────────────────
// What a channel's project exposes: its repos and MCP tools (Claude Tag's "what can you
// access here?"). Transparency for onboarding — read-only.
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Slack block union
export function accessBlocks(project: ProjectConfig): any[] {
  const repos = project.repos.map((r) => `\`${shortRepo(r)}\``).join(', ');
  const mcp = project.mcp?.length ? project.mcp.map((m) => `\`${m.name}\``).join(', ') : '_none_';
  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text:
          `*${project.slug}* — this channel's project\n` +
          `*Repos:* ${repos}\n` +
          `*Tools (MCP):* ${mcp}\n\n` +
          '_I work in a dedicated branch and open a PR for review — never pushing straight to the default branch._',
      },
    },
  ];
}

// ── DM project picker ───────────────────────────────────────────────────────
// Dropdown of projects for a DM with no slug hint. Each option carries the parked
// question's id so the handler can run it: value = "<pid>:<slug>".
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Slack block union
export function dmPickerBlocks(pid: string, projects: ProjectConfig[]): any[] {
  return [
    { type: 'section', text: { type: 'mrkdwn', text: "Which project should I work on? _(DMs aren't tied to a channel.)_" } },
    {
      type: 'actions',
      elements: [
        {
          type: 'static_select',
          action_id: 'dm_pick_project',
          placeholder: { type: 'plain_text', text: 'Pick a project' },
          options: projects.slice(0, 100).map((p) => ({
            text: { type: 'plain_text', text: p.slug },
            value: `${pid}:${p.slug}`,
          })),
        },
      ],
    },
  ];
}

// ── App Home tab ────────────────────────────────────────────────────────────

// The Home tab: what I am, every project + the channel that drives it, and a usage
// cheat-sheet. Self-serve onboarding so colleagues don't have to read the README.
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Slack block union
export function homeBlocks(reg: ProjectsRegistry, prefix: string): any[] {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const blocks: any[] = [
    { type: 'header', text: { type: 'plain_text', text: '🧭 CoachAven' } },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: "I'm a coding agent living in your project channels — mention me to investigate, build, and open PRs without leaving Slack.",
      },
    },
    { type: 'divider' },
    { type: 'section', text: { type: 'mrkdwn', text: `*Projects* (${reg.projects.length})` } },
  ];
  for (const p of reg.projects) {
    const channel = p.slackChannel ? '_(custom channel)_' : `#${prefix}${p.slug}`;
    const repos = p.repos.map((r) => `\`${shortRepo(r)}\``).join(', ');
    const yt = p.youtrackProjects?.length ? `\n   YouTrack: ${p.youtrackProjects.map((x) => `\`${x}\``).join(', ')}` : '';
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `• *${p.slug}* — ${channel}\n   ${plural(p.repos.length, 'repo')}: ${repos}${yt}` },
    });
  }
  blocks.push(
    { type: 'divider' },
    { type: 'section', text: { type: 'mrkdwn', text: '*How to use me*' } },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text:
          '• *Build / collaborate* — @-mention me with a task in a project channel. I reply in a thread; keep replying (no need to re-mention) and I remember the conversation.\n' +
          `• *Quick private answer* — \`${CMD} <question>\` in a project channel. I answer privately in our DM.\n` +
          "• *DM me directly* — just message me in a DM; if it's not clear which project you mean, I'll show a picker.\n" +
          `• *Schedule a digest* — \`${CMD} schedule weekdays 9:00 | what to report\` posts a recurring read-only summary here; manage with \`${CMD} routines\` (\`${CMD} routines all\` lists every project's jobs).\n` +
          "• *Share files* — drop screenshots, PDFs, or docs into a thread or DM (with or without a note) and I'll read them as part of the task. _(Voice/video not supported yet.)_\n" +
          "• *Jot a note* — start a message with `!` and I'll stay out of it (no agent run).\n" +
          '• *Stop me* — hit *✖ Cancel* on any working message.\n' +
          `• *Review a PR* — \`${CMD} review <PR url or #number> [low|med|high]\` posts a read-only review here (works in DMs too). \`${CMD} review auto on|off [effort]\` reviews new PRs automatically.\n` +
          `• *Watch a PR* — \`${CMD} autofix <PR>\` pings here on CI failures / new reviews with a *Fix* button (\`${CMD} autofix off <PR>\` / \`list\`).\n` +
          '• *Auto-investigate support tickets* — tag a YouTrack ticket with the agreed label and I open a read-only investigation in a thread in the matching project channel, then ping the owners. Reply in that thread to dig deeper (I keep the context), and hit *🔀 Open a PR* to turn the fix into a pull request (pilot; only for projects with a YouTrack mapping above).\n' +
          `• *What's here* — \`${CMD} access\` shows this channel's repos + tools.\n` +
          `• *Inspect my context* — \`${CMD} memory\` shows what I've learned, with a button per topic to drill in (\`${CMD} memory <topic>\` also works, \`${CMD} memory live\` reads the sandbox now, \`${CMD} memory log\` shows snapshot history); \`${CMD} prompt\` shows my system prompt.\n` +
          `• *Memory upkeep* — \`${CMD} dream on\`/\`off\` schedules (or pauses) nightly memory consolidation; \`${CMD} dream\` for status, \`${CMD} dream now\` to run it once.\n` +
          `• *Sandbox upkeep* — \`${CMD} housekeeping on\`/\`off\` schedules (or pauses) the nightly janitor (dockerd guard, docker prune when disk runs high, stale-worktree reap); \`${CMD} housekeeping\` for the last run, \`${CMD} housekeeping now\` to run it once.\n` +
          `• *Status* — \`${CMD} status\` for a live view of sandboxes, sessions, and open PRs.`,
      },
    },
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: "I work on a dedicated branch and open a PR for review — I never push straight to the default branch. _(Voice/video clips aren't supported yet — paste text or a link for those.)_",
        },
      ],
    },
  );
  return blocks;
}

// Slack notification for an autofix watch event: what changed + a "Fix it" button that
// enqueues the write-turn (the button value carries everything the action handler needs).
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Slack block union
export function autofixNotifyBlocks(w: PrWatch, notes: string[]): any[] {
  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `:wrench: *${w.repo.split('/')[1] ?? w.repo}#${w.number}* — ${notes.join('; ')}\n<https://github.com/${w.repo}/pull/${w.number}|View PR>`,
      },
    },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: '🔧 Fix it' },
          style: 'primary',
          action_id: 'autofix_apply',
          value: JSON.stringify({ slug: w.slug, repo: w.repo, number: w.number, channel: w.channel }),
        },
      ],
    },
  ];
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Slack block union
export function routineListBlocks(rs: RoutineRecord[]): any[] {
  if (!rs.length) {
    return [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `_No scheduled jobs in this channel._\nCreate one: \`${CMD} schedule weekdays 9:00 | one-line status on open PRs and active threads\``,
        },
      },
    ];
  }
  const lines = rs.map((r) => {
    const dot = r.enabled ? '🟢' : '⚪️';
    const last = r.lastRunAt ? ` · last ${r.lastRunAt.slice(0, 16).replace('T', ' ')}` : '';
    if (r.kind === 'dream' || r.kind === 'housekeeping') {
      const label = r.kind === 'dream' ? '🌙 dream' : '🧹 housekeeping';
      const s = r.lastSummary ? `\n   _${r.lastSummary}_` : '';
      return `${dot} *${r.id}* ${label} — \`${r.spec}\` (${r.tz})${last}${s}`;
    }
    const p = r.prompt.length > 90 ? `${r.prompt.slice(0, 87)}…` : r.prompt;
    return `${dot} *${r.id}* — \`${r.spec}\` (${r.tz})${last}\n   ${p}`;
  });
  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Scheduled jobs*\n${lines.join('\n')}\n\n_Manage:_ \`${CMD} routines run|off|on|rm <id>\` (\`run\` = fire now) · \`${CMD} routines all\` for every project`,
      },
    },
  ];
}

// Fleet-wide view: every project's scheduled jobs, grouped by project, one section per project
// (avoids the 3000-char section cap when there are many). Channel shown as <#id> so it links.
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Slack block union
export function allRoutinesBlocks(groups: { slug: string; routines: RoutineRecord[] }[]): any[] {
  const total = groups.reduce((n, g) => n + g.routines.length, 0);
  if (!total) {
    return [{ type: 'section', text: { type: 'mrkdwn', text: `_No scheduled jobs in any project yet._` } }];
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const blocks: any[] = [
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `*All scheduled jobs* · ${plural(total, 'job')} across ${plural(groups.length, 'project')}` },
    },
  ];
  for (const { slug, routines } of groups) {
    const lines = routines.map((r) => {
      const dot = r.enabled ? '🟢' : '⚪️';
      const kind = r.kind === 'dream' ? '🌙 dream' : r.kind === 'housekeeping' ? '🧹 housekeeping' : 'digest';
      const last = r.lastRunAt ? ` · last ${r.lastRunAt.slice(0, 16).replace('T', ' ')}` : '';
      return `   ${dot} *${r.id}* ${kind} — \`${r.spec}\` in <#${r.channel}>${last}`;
    });
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `*${slug}*\n${lines.join('\n')}`.slice(0, 2900) } });
  }
  return blocks;
}

export function info(msg: string): string {
  return `:information_source: ${msg}`;
}

// Set by runSlack when AVEN_ALERT_CHANNEL is configured: mirror operator-visible errors to a
// Slack channel (free-tier alerting that Sentry's free plan can't do). errText is the central
// error formatter, so every turn/command failure flows through here.
let alertSink: ((text: string) => void) | undefined;
export function setAlertSink(fn: (text: string) => void): void {
  alertSink = fn;
}
export function errText(err: unknown): string {
  const m = err instanceof Error ? err.message : String(err);
  log.error(m);
  captureError(err); // central error formatter → Sentry issue (with stack), no-op if Sentry off
  alertSink?.(m); // mirror to the alert channel if configured (no-op otherwise)
  return `:x: ${m}`.slice(0, MAX_SLACK_TEXT);
}

export function summary(reg: ProjectsRegistry): string {
  const bound = reg.projects.filter((p) => p.slackChannel).length;
  return `${reg.projects.length} project(s), ${bound} channel-bound`;
}
