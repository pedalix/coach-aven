// Slack presentation layer: every Block Kit renderer plus the shared user-facing text
// helpers (info/errText) and the CMD constant they embed. No Bolt handlers, no Daytona,
// no state mutation (except the alert sink hook) — just payload shaping, so the Slack
// wiring in events.ts/commands.ts stays thin.

import type { RoutineRecord, PrWatch } from './state.js';
import type { ProjectConfig, ProjectsRegistry } from './projects.js';
import type { AskQuestion } from './claudeSession.js';
import type { YouTrackIssue, YouTrackComment } from './youtrack.js';
import { prUrls, mdToMrkdwn, fmtElapsed } from './format.js';
import { trailView } from './steps.js';
import { BAD_REASONS, type Tally } from './feedback.js';
import { log } from './log.js';
import { captureError } from './sentry.js';
import { stackHead } from './netretry.js';

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

// Context a completed answer needs for its follow-up buttons (Report to YouTrack, session
// panel): which conversation to enqueue a turn under, and where to post it.
export interface FollowUp {
  key: string;
  channel: string;
  threadTs?: string;
}

// The "how did I get here" affordance on a finished answer: a compact step-count/duration
// context line plus a "🧭 Show steps" button. The button carries ONLY the turnId — the trail
// itself lives in the engine's in-memory registry (events.ts fetches it on click and shows it
// ephemerally), so nothing heavy rides the message payload.
export interface TrailMeta {
  turnId: string;
  steps: number;
  elapsedMs: number;
}

// Render the answer as markdown block(s), then an action row: link buttons to any PR(s)
// the agent opened (there is deliberately NO "Open a PR" button — always-visible action
// buttons scared non-dev users into thinking code changes were one mis-click away; asking
// the agent in the thread is the way to turn a discussion into a PR).
// With `trail`, a step-count context line + "🧭 Show steps" button join the row.
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

// Everything a finished answer may decorate itself with. `ytReport` (the investigated ticket
// id) offers the "📝 Report to YouTrack" button; `ytDraft` marks this answer as a report
// DRAFT — it renders the "✏️ Edit & send" button instead of the usual follow-ups (a draft
// asking to be PR'd or re-reported would be noise). The draft TEXT lives server-side under
// `draftId` (turn.ts keeps it): Slack converts `markdown` blocks to `rich_text` on delivery,
// so the message's own blocks canNOT round-trip the draft — the button only carries the id.
export interface AnswerOpts {
  followUp?: FollowUp;
  trail?: TrailMeta;
  ytReport?: string;
  ytDraft?: { ticket: string; draftId: string };
  // Present on the messages a person is allowed to rate: a turn's answer, and any
  // background update belonging to it. Everything else a turn posts (status card, skip
  // notices, agent questions, ticket drafts) deliberately carries no rating control, so a
  // person has exactly one verdict to give per turn — see feedback.ts.
  rate?: RateMeta;
}

// What a rating click has to carry back: the turn it judges, plus the project and
// conversation key the record is attributed to. Rides in the button value as JSON.
export interface RateMeta {
  turnId: string;
  slug: string;
  key: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Slack 'markdown' block not yet in SDK block union
export function answerBlocks(answer: string, opts: AnswerOpts = {}): any[] {
  const { followUp, trail, ytReport, ytDraft, rate } = opts;
  const blocks = markdownBlocks(answer);
  if (ytDraft) {
    // Draft mode: the whole message IS the proposed ticket comment. One button, one job.
    blocks.push(
      {
        type: 'context',
        elements: [
          { type: 'mrkdwn', text: `📝 Draft internal comment for *${ytDraft.ticket}* — the customer will NOT see it. Nothing is posted until you send.` },
        ],
      },
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            text: { type: 'plain_text', text: '✏️ Edit & send' },
            style: 'primary',
            action_id: 'yt_edit_send',
            value: JSON.stringify({ t: ytDraft.ticket, d: ytDraft.draftId }),
          },
        ],
      },
    );
    return blocks;
  }
  if (trail && trail.steps > 0) {
    // Quiet transparency line: how much work produced this answer. The full trail is a click away.
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `🧭 ${plural(trail.steps, 'step')} · ${fmtElapsed(trail.elapsedMs)}` }],
    });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const actions: any[] = [];
  const prs = prUrls(answer);
  if (prs.length) {
    // A PR URL in this message → link straight to it.
    actions.push(
      ...prs.slice(0, 5).map((url, i) => ({
        type: 'button',
        text: { type: 'plain_text', text: prs.length === 1 ? '🔗 View PR' : `🔗 PR #${url.split('/').pop()}` },
        url,
        action_id: `pr_link:${i}`,
      })),
    );
  }
  if (ytReport && followUp) {
    // Investigation thread → offer posting the findings back to the ticket. The click starts
    // a DRAFT turn (nothing reaches YouTrack until a human approves it in the edit modal).
    actions.push({
      type: 'button',
      text: { type: 'plain_text', text: '📝 Report to YouTrack' },
      action_id: 'yt_report',
      value: JSON.stringify({ t: ytReport, key: followUp.key, channel: followUp.channel, threadTs: followUp.threadTs }),
    });
  }
  if (trail && trail.steps > 0) {
    actions.push({
      type: 'button',
      text: { type: 'plain_text', text: '🧭 Show steps' },
      action_id: 'show_trail',
      value: trail.turnId,
    });
  }
  if (followUp) {
    // Thread-scoped session status + restart, ephemeral (only the clicker sees it) — see
    // sessionPanelBlocks. Carries the same {key,channel,threadTs} shape as make_pr's value.
    actions.push({
      type: 'button',
      text: { type: 'plain_text', text: '⚙️ Session' },
      action_id: 'session_panel',
      value: JSON.stringify({ key: followUp.key, channel: followUp.channel, threadTs: followUp.threadTs }),
    });
  }
  if (rate) {
    // Last in the row: rating is a quiet afterthought next to the actions that DO something.
    // Both buttons write a verdict on click; the thumbs-down additionally opens the reason
    // modal, so an abandoned modal still leaves the signal behind.
    actions.push(...ratingButtons(rate));
  }
  if (actions.length) blocks.push({ type: 'actions', elements: actions });
  return blocks;
}

// The two rating buttons. With a tally the labels carry the per-turn vote count
// ("👍 Helped · 2") — that count IS the click's confirmation: it changes under the
// cursor, on the message itself, for everyone. Zero counts stay unlabelled so a fresh
// answer doesn't advertise "· 0".
const RATING_LABEL = { fb_good: '\u{1F44D} Helped', fb_bad: '\u{1F44E} Missed' } as const;
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Slack button elements
export function ratingButtons(rate: RateMeta, tally: Tally = { good: 0, bad: 0 }): any[] {
  const value = JSON.stringify({ t: rate.turnId, s: rate.slug, k: rate.key });
  const label = (id: keyof typeof RATING_LABEL, n: number) => (n > 0 ? `${RATING_LABEL[id]} \u00b7 ${n}` : RATING_LABEL[id]);
  return [
    { type: 'button', text: { type: 'plain_text', text: label('fb_good', tally.good) }, action_id: 'fb_good', value },
    { type: 'button', text: { type: 'plain_text', text: label('fb_bad', tally.bad) }, action_id: 'fb_bad', value },
  ];
}

// Pure: the clicked message's own blocks with ONLY the rating labels rewritten. Everything
// else — the answer text (which Slack has by now rewritten from `markdown` to `rich_text`),
// the context line, the other buttons — passes through exactly as the click payload
// delivered it, so chat.update re-posts what is already there. Returns undefined when the
// blocks carry no rating row, so the caller knows not to call chat.update at all.
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Slack block payloads
export function withRatingTally(blocks: any[] | undefined, tally: Tally): any[] | undefined {
  if (!Array.isArray(blocks)) return undefined;
  let touched = false;
  const out = blocks.map((b) => {
    if (b?.type !== 'actions' || !Array.isArray(b.elements)) return b;
    const elements = b.elements.map((e: { action_id?: string; text?: { text?: string } }) => {
      if (e?.action_id !== 'fb_good' && e?.action_id !== 'fb_bad') return e;
      touched = true;
      const n = e.action_id === 'fb_good' ? tally.good : tally.bad;
      const base = RATING_LABEL[e.action_id];
      return { ...e, text: { type: 'plain_text', text: n > 0 ? `${base} \u00b7 ${n}` : base } };
    });
    return { ...b, elements };
  });
  return touched ? out : undefined;
}

// The thumbs-down follow-up. A radio group, not a select: the six causes are the point —
// showing them all teaches what we can actually act on, where a dropdown hides them and
// biases every answer toward the first option. The note is optional and prompted with a
// concrete example, because "bad" without a specific is not actionable.
export const FB_CALLBACK = 'fb_reason_modal';
export const FB_REASON = { block: 'fb_reason', action: 'reason' } as const;
export const FB_NOTE = { block: 'fb_note', action: 'note' } as const;
export function feedbackModalView(
  meta: { turnId: string; slug: string; key: string; channel?: string; ts?: string },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Slack view object
): any {
  return {
    type: 'modal',
    callback_id: FB_CALLBACK,
    private_metadata: JSON.stringify({ t: meta.turnId, s: meta.slug, k: meta.key, c: meta.channel, ts: meta.ts }),
    title: { type: 'plain_text', text: 'What went wrong?' },
    submit: { type: 'plain_text', text: 'Send' },
    close: { type: 'plain_text', text: 'Skip' },
    blocks: [
      {
        type: 'input',
        block_id: FB_REASON.block,
        label: { type: 'plain_text', text: 'Closest cause' },
        element: {
          type: 'radio_buttons',
          action_id: FB_REASON.action,
          options: BAD_REASONS.map((r) => ({ text: { type: 'plain_text', text: r.label }, value: r.value })),
        },
      },
      {
        type: 'input',
        block_id: FB_NOTE.block,
        optional: true,
        label: { type: 'plain_text', text: 'What would a good answer have looked like?' },
        element: { type: 'plain_text_input', action_id: FB_NOTE.action, multiline: true },
      },
      {
        // Examples sit UNDER the field as readable lines rather than inside a grey
        // placeholder that vanishes the moment you start typing — the point is to show what
        // a specific, actionable note looks like, and a placeholder can't do that while you
        // write one.
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text:
              '*Useful notes look like:*\n' +
              '\u2022 "said a deploy caused it but never which one, so I couldn\u2019t check"\n' +
              '\u2022 "the numbers were for staging, I asked about production"\n' +
              '\u2022 "correct, but I had to ask three times to get it"',
          },
        ],
      },
      {
        type: 'context',
        elements: [{ type: 'mrkdwn', text: 'Recorded against this answer only \u2014 nothing is posted in the thread.' }],
      },
    ],
  };
}

// Reassemble an answer's full text from its Slack message blocks (the markdown chunks laid
// down by markdownBlocks). Lets the "✏️ Edit & send" click recover the draft from the message
// itself — no server-side draft store, so the flow survives bot restarts.
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Slack block union
export function textFromMarkdownBlocks(blocks: any[]): string {
  return (blocks ?? [])
    .filter((b) => b?.type === 'markdown' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('');
}

// The "✏️ Edit & send" modal: the draft in a multiline input, submit posts it to the ticket.
// `meta` (draft message coordinates + ticket) rides in private_metadata so the view_submission
// handler can post the comment and rewrite the draft message. Slack caps inputs around 3000
// chars — the draft prompt demands ≤2500, and we hard-trim here so views.open never 500s.
export const YT_SEND_CALLBACK = 'yt_send_modal';
export const YT_SEND_INPUT = { block: 'yt_report_text', action: 'text' } as const;
export function reportModalView(
  ticketId: string,
  draft: string,
  meta: { channel: string; ts: string; threadTs?: string },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Slack view object
): any {
  return {
    type: 'modal',
    callback_id: YT_SEND_CALLBACK,
    private_metadata: JSON.stringify({ t: ticketId, ...meta }),
    title: { type: 'plain_text', text: `Report to ${ticketId}`.slice(0, 24) },
    submit: { type: 'plain_text', text: 'Post internal comment' },
    close: { type: 'plain_text', text: 'Cancel' },
    blocks: [
      {
        type: 'input',
        block_id: YT_SEND_INPUT.block,
        label: { type: 'plain_text', text: 'Internal comment (Markdown) — visible to the support team only' },
        element: {
          type: 'plain_text_input',
          action_id: YT_SEND_INPUT.action,
          multiline: true,
          initial_value: draft.slice(0, 2900),
        },
      },
    ],
  };
}

// Shown when an "✏️ Edit & send" click can't find its draft (the bot restarted since the
// draft was generated — the store is in-memory). Honest dead end with the way out.
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Slack view object
export function reportExpiredView(ticketId: string): any {
  return {
    type: 'modal',
    title: { type: 'plain_text', text: 'Draft expired' },
    close: { type: 'plain_text', text: 'Close' },
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `This draft for *${ticketId}* is gone (the bot restarted since it was generated). Hit *📝 Report to YouTrack* on the thread again to regenerate it.`,
        },
      },
    ],
  };
}

// The "📝 Report to YouTrack" first pop-up: the editable report instructions plus the fixed
// delivery contract shown read-only underneath — full transparency (the prompt that runs is
// exactly instructions + contract, nothing hidden), but users rewriting the instructions with
// a one-liner can no longer delete the rules that keep auto-post safe. An optional checkbox
// skips the preview and posts the result straight to the ticket (safe to offer only because
// the comment is internal and the post is fail-closed). Thread coordinates ride in
// private_metadata; the edited instructions and the checkbox come back through
// view_submission state — the contract is re-appended server-side, never round-tripped.
export const YT_PROMPT_CALLBACK = 'yt_prompt_modal';
export const YT_PROMPT_INPUT = { block: 'yt_prompt_text', action: 'text' } as const;
export const YT_PROMPT_NOW = { block: 'yt_prompt_now', action: 'now', value: 'now' } as const;
export function reportPromptModalView(
  ticketId: string,
  defaultPrompt: string,
  deliveryContract: string,
  meta: { key: string; channel: string; threadTs?: string },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Slack view object
): any {
  return {
    type: 'modal',
    callback_id: YT_PROMPT_CALLBACK,
    private_metadata: JSON.stringify({ t: ticketId, ...meta }),
    title: { type: 'plain_text', text: `Report to ${ticketId}`.slice(0, 24) },
    submit: { type: 'plain_text', text: 'Generate report' },
    close: { type: 'plain_text', text: 'Cancel' },
    blocks: [
      {
        type: 'input',
        block_id: YT_PROMPT_INPUT.block,
        label: { type: 'plain_text', text: 'Instructions for the report (edit freely — even a one-liner works)' },
        element: {
          type: 'plain_text_input',
          action_id: YT_PROMPT_INPUT.action,
          multiline: true,
          initial_value: defaultPrompt.slice(0, 2900),
        },
      },
      {
        type: 'context',
        elements: [{ type: 'mrkdwn', text: `🔒 Always appended to your instructions:\n${deliveryContract}`.slice(0, 3000) }],
      },
      {
        type: 'input',
        block_id: YT_PROMPT_NOW.block,
        optional: true,
        label: { type: 'plain_text', text: 'Delivery' },
        element: {
          type: 'checkboxes',
          action_id: YT_PROMPT_NOW.action,
          options: [
            {
              text: { type: 'plain_text', text: 'Post to the ticket immediately (skip the preview)' },
              description: { type: 'plain_text', text: 'Internal comment, team-only — the answer is posted word-for-word.' },
              value: YT_PROMPT_NOW.value,
            },
          ],
        },
      },
    ],
  };
}

// The "✅ Posted" rewrite of a draft/answer message once the comment landed on the ticket —
// shared by the manual send (modal submit) and the skip-preview auto-post.
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Slack block union
export function reportPostedBlocks(text: string, ticketId: string, url: string, group: string): any[] {
  return [
    { type: 'markdown', text: text.slice(0, MAX_SLACK_TEXT) },
    {
      type: 'context',
      elements: [
        { type: 'mrkdwn', text: `✅ Posted to *${ticketId}* as an internal comment (${group}) — <${url}|open in YouTrack>` },
      ],
    },
  ];
}

// The two things you can do to a turn that is still running: look at what it's doing, or
// stop it. Shared by the live status message and the background card below.
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Slack block union
function liveTurnActions(turnId: string): any {
  return {
    type: 'actions',
    elements: [
      {
        // The live trail so far, in a pop-up — the status text streams only a 6-line tail.
        type: 'button',
        text: { type: 'plain_text', text: '🧭 Show steps' },
        action_id: 'show_trail',
        value: turnId,
      },
      {
        type: 'button',
        text: { type: 'plain_text', text: '✖ Cancel' },
        action_id: 'cancel_turn',
        value: turnId,
      },
    ],
  };
}

// Live status as a section + a "✖ Cancel" button carrying the turnId. Used while a turn
// runs; replaced by the answer (markdown blocks) or a plain status on cancel/error.
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Slack block union
export function statusBlocks(text: string, turnId: string): any[] {
  return [{ type: 'section', text: { type: 'mrkdwn', text: text || '…' } }, liveTurnActions(turnId)];
}

// A turn that outlived the SOFT deadline freezes its working message into this card. The
// live status rewrites itself every few seconds; keeping that up for another 45 minutes is
// pure channel noise once we've stopped promising an imminent answer — so the clock stops
// here and the message goes static, with the two buttons that still do something. The
// answer arrives as a NEW message in the thread (chat.update is silent — after this long
// the user is elsewhere and needs the ping).
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Slack block union
export function backgroundBlocks(turnId: string, elapsedMs: number): any[] {
  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text:
          `🌙 *Working in the background* — running for ${fmtElapsed(elapsedMs)}, longer than usual.\n` +
          `I'll post the answer here as a new message when it's done. *🧭 Show steps* stays live; ` +
          `*✖ Cancel* stops me.`,
      },
    },
    liveTurnActions(turnId),
  ];
}

// The background card's epitaph: once the answer has been posted as its own message, the
// card collapses to a one-liner pointing at it (buttons gone — the answer carries its own
// "🧭 Show steps").
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Slack block union
export function backgroundDoneBlocks(label: string, t: { steps: number; elapsedMs: number }): any[] {
  const meta = t.steps > 0 ? ` · 🧭 ${plural(t.steps, 'step')} · ${fmtElapsed(t.elapsedMs)}` : ` · ${fmtElapsed(t.elapsedMs)}`;
  return [{ type: 'context', elements: [{ type: 'mrkdwn', text: `${label}${meta}` }] }];
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

// ── YouTrack ticket card ────────────────────────────────────────────────────
// First reply in an investigation thread: the ticket itself — description excerpt, fields,
// linked issues, attached files — so nobody has to open YouTrack to see what the thread is
// about. Longer descriptions are cut with a link to the full ticket.
const TICKET_EXCERPT = 600;
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Slack block union
export function ticketCardBlocks(
  t: YouTrackIssue,
  ticketUrl: string,
  attachmentNames: string[],
  // Who applied the trigger tag, when we could read it — transparency about what started this
  // (and, for an englishTaggers match, why the writeup came back in English).
  flaggedBy?: string,
): any[] {
  const desc = t.description.trim();
  const excerpt =
    desc.length > TICKET_EXCERPT
      ? `${mdToMrkdwn(desc.slice(0, TICKET_EXCERPT))}… <${ticketUrl}|full ticket>`
      : mdToMrkdwn(desc) || '_(no description)_';
  const meta = [
    t.reporter ? `👤 ${t.reporter}` : '',
    t.createdAt ? `created ${t.createdAt.slice(0, 10)}` : '',
    flaggedBy ? `🏷 flagged by ${flaggedBy}` : '',
    ...t.fields.map((f) => `${f.name}: ${f.value}`),
  ]
    .filter(Boolean)
    .join('  ·  ');
  const links = t.links
    .map((l) => `🔗 ${l.type} *${l.id}* — ${l.summary}${l.resolved ? ' _(resolved)_' : ''}`)
    .join('\n');
  const files = attachmentNames.length ? `📎 ${attachmentNames.join(', ')}` : '';
  const context = [meta, links, files].filter(Boolean).join('\n');
  return [
    { type: 'section', text: { type: 'mrkdwn', text: excerpt.slice(0, 2900) } },
    ...(context ? [{ type: 'context', elements: [{ type: 'mrkdwn', text: context.slice(0, 2900) }] }] : []),
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: '🔍 Full ticket' },
          action_id: 'ticket_modal',
          value: t.id, // the handler re-fetches everything fresh by id
        },
      ],
    },
  ];
}

// ── Modals ──────────────────────────────────────────────────────────────────
// Slack caps a modal at 100 blocks and a mrkdwn section at 3000 chars, so long text is
// chunked and the least-valuable end is dropped first (a note says so).
const MODAL_TEXT = 2900; // per-section mrkdwn budget (3000 hard cap, headroom for the "…" tail)
const MODAL_BLOCKS = 95; // total block budget (100 hard cap)
const COMMENT_TEXT = 1800; // per-comment budget — keeps a long thread scannable

function chunkText(s: string, size: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < s.length; i += size) out.push(s.slice(i, i + size));
  return out;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Slack view union
const modalShell = (title: string, blocks: any[]): any => ({
  type: 'modal',
  title: { type: 'plain_text', text: title.slice(0, 24) },
  close: { type: 'plain_text', text: 'Close' },
  blocks,
});

// ── Full-ticket modal ───────────────────────────────────────────────────────
// Everything the card excerpts: full description, every field, links, file names, and the
// whole comment thread — fetched fresh when the button is clicked, so the OLDEST comments
// are dropped first (the newest carry the state of the conversation).

// Placeholder shown immediately on click: `trigger_id` expires in 3 seconds, so we open
// first and swap the content in via views.update once YouTrack answers.
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Slack view union
export function ticketLoadingView(id: string): any {
  return modalShell(id, [{ type: 'section', text: { type: 'mrkdwn', text: '⏳ Loading the ticket…' } }]);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Slack view union
export function ticketUnavailableView(id: string, ticketUrl: string): any {
  return modalShell(id, [
    { type: 'section', text: { type: 'mrkdwn', text: `⚠️ Couldn't load *${id}* from YouTrack right now — <${ticketUrl}|open it there>.` } },
  ]);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Slack view union
export function ticketModalView(t: YouTrackIssue, ticketUrl: string, comments: YouTrackComment[], attachmentNames: string[]): any {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const blocks: any[] = [{ type: 'section', text: { type: 'mrkdwn', text: `*<${ticketUrl}|${t.id}> — ${t.summary}*`.slice(0, MODAL_TEXT) } }];
  const meta = [
    t.reporter ? `👤 ${t.reporter}` : '',
    t.createdAt ? `created ${t.createdAt.slice(0, 10)}` : '',
    ...t.fields.map((f) => `${f.name}: ${f.value}`),
  ]
    .filter(Boolean)
    .join('  ·  ');
  if (meta) blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: meta.slice(0, MODAL_TEXT) }] });
  blocks.push({ type: 'divider' });

  // Full description — chunked, but still bounded (a pathological ticket shouldn't eat the
  // whole comment budget). Past 3 chunks we hand over to YouTrack itself.
  const desc = mdToMrkdwn(t.description.trim()) || '_(no description)_';
  const descChunks = chunkText(desc, MODAL_TEXT);
  for (const c of descChunks.slice(0, 3)) blocks.push({ type: 'section', text: { type: 'mrkdwn', text: c } });
  if (descChunks.length > 3) blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `… <${ticketUrl}|description continues in YouTrack>` }] });

  const links = t.links
    .map((l) => `🔗 ${l.type} *${l.id}* — ${l.summary}${l.resolved ? ' _(resolved)_' : ''}`)
    .join('\n');
  if (links) blocks.push({ type: 'section', text: { type: 'mrkdwn', text: links.slice(0, MODAL_TEXT) } });
  // File names only — we deliberately don't mirror the bytes into Slack (the agent gets
  // them in its sandbox; humans have the YouTrack link).
  if (attachmentNames.length) blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `📎 ${attachmentNames.join(', ')}`.slice(0, MODAL_TEXT) }] });

  if (comments.length) {
    blocks.push({ type: 'divider' }, { type: 'section', text: { type: 'mrkdwn', text: `*💬 Comments (${comments.length})*` } });
    // 2 blocks per comment (byline + text); keep the NEWEST ones that fit the block budget.
    const room = Math.floor((MODAL_BLOCKS - blocks.length - 1) / 2);
    const shown = comments.slice(-room);
    if (shown.length < comments.length) {
      blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `_… ${comments.length - shown.length} earlier ${comments.length - shown.length === 1 ? 'comment' : 'comments'} — <${ticketUrl}|full ticket>_` }] });
    }
    for (const c of shown) {
      const byline = `*${c.author || 'unknown'}*${c.createdAt ? `  ·  ${c.createdAt.slice(0, 10)}` : ''}`;
      const text = mdToMrkdwn(c.text.trim());
      blocks.push(
        { type: 'context', elements: [{ type: 'mrkdwn', text: byline.slice(0, MODAL_TEXT) }] },
        { type: 'section', text: { type: 'mrkdwn', text: text.length > COMMENT_TEXT ? `${text.slice(0, COMMENT_TEXT)}… <${ticketUrl}|more>` : text || '_(empty)_' } },
      );
    }
  }
  return modalShell(t.id, blocks);
}

// ── Trail modal ─────────────────────────────────────────────────────────────
// The full step-by-step trail of a turn in a pop-up — richer than the 6-line tail the live
// status streams, and readable mid-run (the status message carries the button too, and the
// registry entry is live from the moment the turn is queued). `undefined` = evicted or the
// bot restarted; the view says so instead of showing nothing.
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Slack view union
export function trailModalView(t: { steps: string[]; elapsedMs: number; done: boolean } | undefined): any {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const blocks: any[] = [];
  if (!t) {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: "_This turn's step-by-step trail is no longer available (I've been restarted since it ran)._" } });
  } else if (!t.steps.length) {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: '_No steps yet — still preparing._' } });
  } else {
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `🧭 ${plural(t.steps.length, 'step')} · ${fmtElapsed(t.elapsedMs)}${t.done ? '' : ' so far'}` }],
    });
    // trailView folds repeats and elides the middle so the payload stays well under Slack's
    // ~250 KB view limit — the block cap alone did NOT (95 × 2900 ≈ 267 KB), which is how this
    // modal died on long turns in prod. The slice below is now unreachable and stays as a
    // second floor: nothing here may ever hand Slack an oversized view again.
    let chunks = chunkText(trailView(t.steps).join('\n'), MODAL_TEXT);
    const cap = MODAL_BLOCKS - 3; // headroom for the header + "trimmed" + "still running" notes
    if (chunks.length > cap) chunks = chunks.slice(-cap);
    for (const c of chunks) blocks.push({ type: 'section', text: { type: 'mrkdwn', text: c } });
  }
  if (t && !t.done) blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: '⏳ Still running — close and reopen to catch up.' }] });
  return modalShell('🧭 Steps', blocks);
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
  // Subscription quota line (ratelimit.ts) — operator info about OUR one Claude plan, so
  // only the home workspace's report carries it.
  claudeQuota?: string;
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
  const quota = r.claudeQuota ? `\n_${r.claudeQuota}_` : '';
  return [{ type: 'section', text: { type: 'mrkdwn', text: `${head}\n\n${lines.join('\n')}\n\n${health}${quota}` } }];
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

// ── "⚙️ Session" panel ───────────────────────────────────────────────────────
// The thread-scoped sibling of accessBlocks + statusReportBlocks: what this ONE thread's
// session looks like (bound or not, a turn running, a PR already opened) plus the project's
// repos/MCP — ephemeral, so only the clicker sees it. `value` is the JSON the panel button
// itself carried, reused unchanged on the restart button so its handler needs no new shape.
export interface SessionPanelInfo {
  slug: string;
  repos: string[];
  mcp?: string[]; // MCP tool names
  hasSession: boolean;
  sessionSince?: string; // ChatRecord.updatedAt, ISO
  turnInFlight: boolean;
  prCreated: boolean;
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Slack block union
export function sessionPanelBlocks(info: SessionPanelInfo, value: string): any[] {
  const repos = info.repos.map((r) => `\`${shortRepo(r)}\``).join(', ');
  const mcp = info.mcp?.length ? info.mcp.map((m) => `\`${m}\``).join(', ') : '_none_';
  const session = info.hasSession
    ? `active${info.sessionSince ? ` _(since ${info.sessionSince.slice(0, 16).replace('T', ' ')})_` : ''}`
    : '_none yet — the next message starts one_';
  const lines = [
    `*${info.slug}* — this thread's session`,
    `*Repos:* ${repos}`,
    `*Tools (MCP):* ${mcp}`,
    `*Session:* ${session}`,
    `*Turn running:* ${info.turnInFlight ? 'yes' : 'no'}`,
    info.prCreated ? `*PR:* opened from this thread` : '',
  ]
    .filter(Boolean)
    .join('\n');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const blocks: any[] = [{ type: 'section', text: { type: 'mrkdwn', text: lines } }];
  if (info.hasSession) {
    blocks.push({
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: '🔄 Restart session' },
          style: 'danger',
          action_id: 'session_restart',
          value,
          // Destructive to conversation memory — same explicit-confirm treatment as make_pr.
          confirm: {
            title: { type: 'plain_text', text: "Restart this thread's session?" },
            text: {
              type: 'mrkdwn',
              text: 'This forgets the conversation so far — the next message starts a brand-new session. The thread history in Slack is untouched.',
            },
            confirm: { type: 'plain_text', text: 'Restart' },
            deny: { type: 'plain_text', text: 'Cancel' },
          },
        },
      ],
    });
  }
  return blocks;
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

// The Home tab: what I am, the VIEWER TENANT's projects + the channels that drive them,
// and a usage cheat-sheet. Takes the tenant's subset (teamProjects), never the whole
// registry — a client workspace must not see the fleet. The empty subset renders
// onboardingHomeBlocks instead (see events.ts).
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Slack block union
export function homeBlocks(projects: ProjectConfig[], prefix: string): any[] {
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
    { type: 'section', text: { type: 'mrkdwn', text: `*Projects* (${projects.length})` } },
  ];
  for (const p of projects) {
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
      // Split across two blocks: a section's mrkdwn text is capped at 3000 chars by the
      // Slack API, and this list alone runs to ~3600 — one block over the limit makes
      // views.publish reject the WHOLE payload (invalid_blocks), which leaves the Home
      // tab spinning forever since no view ever gets published for anyone.
      type: 'section',
      text: {
        type: 'mrkdwn',
        text:
          '• *Build / collaborate* — @-mention me with a task in a project channel. I reply in a thread; keep replying (no need to re-mention) and I remember the conversation.\n' +
          `• *Quick private answer* — \`${CMD} <question>\` in a project channel. I answer privately in our DM.\n` +
          "• *DM me directly* — just message me in a DM; if it's not clear which project you mean, I'll show a picker.\n" +
          `• *Schedule a digest* — \`${CMD} schedule weekdays 9:00 | what to report\` posts a recurring read-only summary here; manage with \`${CMD} routines\` (\`${CMD} routines all\` lists every job across this workspace's projects).\n` +
          "• *Share files* — drop screenshots, PDFs, or docs into a thread or DM (with or without a note) and I'll read them as part of the task; works in Slack Connect channels too. If I can't use a file, I'll reply saying which one and why. _(Voice/video not supported yet.)_\n" +
          "• *Jot a note* — start a message with `!` and I'll stay out of it (no agent run).\n" +
          '• *Stop me* — hit *✖ Cancel* on any working message.\n' +
          '• *See how I got there* — hit *🧭 Show steps* on a working message (live) or a finished answer for the tool-by-tool trail in a pop-up; a very long run comes condensed.\n' +
          "• *Background agents* — if I kick off a background subagent that's still running when I reply, I'll follow up with a new *🔔 Background update* message in the thread once it finishes.\n" +
          "• *Long tasks* — if a task runs long I won't cut it off: past ~15 minutes the working message stops ticking and turns into a *🌙 Working in the background* card (*🧭 Show steps* still live, *✖ Cancel* still stops me), and the answer arrives as a *new message* in the thread when it's done.\n" +
          `• *Review a PR* — \`${CMD} review <PR url or #number> [low|med|high]\` posts a read-only review here (works in DMs too). \`${CMD} review auto on|off [effort]\` reviews new PRs automatically _(managed from the project's owner workspace)_.\n` +
          `• *Watch a PR* — \`${CMD} autofix <PR>\` pings here on CI failures / new reviews with a *Fix* button (\`${CMD} autofix off <PR>\` / \`list\`).\n` +
          '• *Auto-investigate support tickets* — tag a YouTrack ticket with the agreed label and I open a thread in the matching project channel: the ticket card (description, priority, links, files — *🔍 Full ticket* pops up the whole thing, comments included) followed by a read-only investigation, then I ping the owners. Reply in that thread to dig deeper (I keep the context) or ask me there to implement the fix and open a pull request, or hit *📝 Report to YouTrack* to post an internal comment back to the ticket — a pop-up takes your instructions (a one-liner is fine; fixed delivery rules are always appended), then the draft comes back for review/edit before posting (or tick _post immediately_ to send the answer word-for-word) (pilot; only for projects with a YouTrack mapping above). The card shows *who* flagged the ticket, and the writeup follows the ticket\'s own language so support can relay it — except when one of the team\'s own accounts applies the tag, which gets you the answer in English.',
      },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text:
          `• *What's here* — \`${CMD} access\` shows this channel's repos + tools.\n` +
          `• *Inspect my context* — \`${CMD} memory\` shows what I've learned, with a button per topic to drill in (\`${CMD} memory <topic>\` also works, \`${CMD} memory live\` reads the sandbox now, \`${CMD} memory log\` shows snapshot history); \`${CMD} prompt\` shows my system prompt.\n` +
          `• *Memory upkeep* — \`${CMD} dream on\`/\`off\` schedules (or pauses) nightly memory consolidation; \`${CMD} dream\` for status, \`${CMD} dream now\` to run it once.\n` +
          `• *Sandbox upkeep* — \`${CMD} housekeeping on\`/\`off\` schedules (or pauses) the nightly janitor (dockerd guard, docker prune when disk runs high, stale-worktree reap); \`${CMD} housekeeping\` for the last run, \`${CMD} housekeeping now\` to run it once.\n` +
          `• *Status* — \`${CMD} status\` for a live view of sandboxes, sessions, open PRs — and (operators) the Claude subscription quota.\n` +
          '• *Check or restart a thread* — hit *⚙️ Session* on any finished answer for a private status card (session, repos/tools, running turn, PR) and a *🔄 Restart session* control if you want the next message to start a brand-new conversation.\n' +
          '• *Tell me if it landed* — every answer carries *👍 Helped* / *👎 Missed*. One click is enough; the count on the button updates so you see it registered, and a thumbs-down asks what went wrong in a short pop-up. Nothing is posted in the thread; click the other button to change your mind.\n' +
          `• *Usage* — \`${CMD} usage [days]\` for token/cost/turn totals per project, plus how many answers people rated as helpful and what those cost (last 30d by default). _(Operators' home workspace only.)_\n` +
          `• *Who may drive me* — \`${CMD} users\` shows this workspace's access (everyone, by default); admins can \`restrict\` to an allowlist and manage it with \`allow @user\` / \`deny @user\` / \`open\`.\n` +
          `• *Reload config* — \`${CMD} reload\` re-reads the project registry (projects.config.json + projects.d/*.md prompts) without a restart; applies to new sessions. _(Operators' home workspace only.)_`,
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

// The one "installed but not configured" sentence, shared by the gate middleware's
// polite reply, the /aven guard, and the onboarding Home view — one string to edit.
export function notConfiguredText(): string {
  const contact = process.env.AVEN_CONTACT || 'the CoachAven team';
  return `ℹ️ CoachAven is installed but no projects are configured for this workspace yet. Contact ${contact} to get set up.`;
}

// The Home tab for a workspace that installed the app but has no projects mapped yet —
// the onboarding view of the tenant gate (never the fleet's project list).
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Slack block union
export function onboardingHomeBlocks(): any[] {
  const contact = process.env.AVEN_CONTACT || 'the CoachAven team';
  return [
    { type: 'header', text: { type: 'plain_text', text: '🧭 CoachAven' } },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text:
          "I'm a coding agent that lives in project channels — I investigate, build, and open PRs without leaving Slack.\n\n" +
          `*You're almost there.* CoachAven is installed in this workspace, but no projects are configured for it yet. ` +
          `Contact ${contact} to connect your repositories — once a project is set up, a channel here starts driving it.`,
      },
    },
    {
      type: 'context',
      elements: [{ type: 'mrkdwn', text: 'Nothing runs and no data is read until a project is explicitly configured for this workspace.' }],
    },
  ];
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
export type AlertLevel = 'error' | 'warning' | 'info';
let alertSink: ((text: string, level: AlertLevel) => void) | undefined;
export function setAlertSink(fn: (text: string, level: AlertLevel) => void): void {
  alertSink = fn;
}
// Operator notice that is NOT an error (quota warnings, recoveries): logged, mirrored to
// the alert channel at its level, no Sentry issue — Sentry is for things with a stack.
export function alertOps(text: string, level: Exclude<AlertLevel, 'error'> = 'warning'): void {
  if (level === 'warning') log.warn(text);
  else log.info(text);
  alertSink?.(text, level);
}
export function errText(err: unknown): string {
  const m = err instanceof Error ? err.message : String(err);
  // The journal keeps where it failed too (Sentry has the full stack; this is for grep on the box).
  const where = stackHead(err, 4);
  log.error(where ? `${m} [${where}]` : m);
  captureError(err); // central error formatter → Sentry issue (with stack), no-op if Sentry off
  alertSink?.(m, 'error'); // mirror to the alert channel if configured (no-op otherwise)
  return `:x: ${m}`.slice(0, MAX_SLACK_TEXT);
}

export function summary(reg: ProjectsRegistry): string {
  const bound = reg.projects.filter((p) => p.slackChannel).length;
  return `${reg.projects.length} project(s), ${bound} channel-bound`;
}
