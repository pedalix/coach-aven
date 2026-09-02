import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  answerBlocks,
  statusBlocks,
  backgroundBlocks,
  backgroundDoneBlocks,
  ticketCardBlocks,
  ticketModalView,
  trailModalView,
  textFromMarkdownBlocks,
  reportModalView,
  reportPromptModalView,
  reportPostedBlocks,
  feedbackModalView,
  FB_REASON,
  homeBlocks,
  onboardingHomeBlocks,
  sessionPanelBlocks,
  YT_SEND_CALLBACK,
  YT_SEND_INPUT,
  YT_PROMPT_CALLBACK,
  YT_PROMPT_INPUT,
  YT_PROMPT_NOW,
  type FollowUp,
  type TrailMeta,
  type SessionPanelInfo,
} from './blocks.js';
import type { YouTrackIssue, YouTrackComment } from './youtrack.js';
import type { ProjectConfig } from './projects.js';

// The action row is the last block; its button action_ids tell us which affordance rendered.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function actionIds(blocks: any[]): string[] {
  const row = blocks.find((b) => b.type === 'actions');
  return row ? row.elements.map((e: { action_id: string }) => e.action_id) : [];
}

const followUp: FollowUp = { key: 'thread:123', channel: 'C1', threadTs: '123' };
const PR = 'See https://github.com/Org/repo/pull/7 for the change.';

test('answerBlocks: no PR URL → no PR button of any kind (Open a PR is gone by design)', () => {
  // The "⚙️ Session" button stays — it's tied to followUp (a thread conversation exists).
  assert.deepEqual(actionIds(answerBlocks('done, nothing to link', { followUp })), ['session_panel']);
});

test('answerBlocks: a PR URL in the message shows "View PR"', () => {
  assert.deepEqual(actionIds(answerBlocks(PR, { followUp })), ['pr_link:0', 'session_panel']);
});

test('answerBlocks: rating buttons appear only where a verdict is allowed', () => {
  const rate = { turnId: 'tabc123-1', slug: 'caldora', key: 'thread:1.2' };
  // The answer of a turn: rateable.
  assert.deepEqual(actionIds(answerBlocks('the answer', { followUp, rate })), ['session_panel', 'fb_good', 'fb_bad']);
  // A background update carries no followUp but is still the turn's last word.
  assert.deepEqual(actionIds(answerBlocks('background update', { rate })), ['fb_good', 'fb_bad']);
  // Everything else a turn posts stays unrateable, so one turn yields one verdict.
  assert.deepEqual(actionIds(answerBlocks('the answer', { followUp })), ['session_panel']);
});

test('answerBlocks: a rating button carries the turn, project and conversation key', () => {
  const rate = { turnId: 'tabc123-1', slug: 'caldora', key: 'thread:1.2' };
  const row = answerBlocks('the answer', { rate }).find((b) => b.type === 'actions');
  const good = row.elements.find((e: { action_id: string }) => e.action_id === 'fb_good');
  assert.deepEqual(JSON.parse(good.value), { t: 'tabc123-1', s: 'caldora', k: 'thread:1.2' });
});

test('answerBlocks: a ticket draft offers Edit & send only — never a rating', () => {
  const ids = actionIds(answerBlocks('draft text', { followUp, rate: { turnId: 'tabc123-1', slug: 'c', key: 'k' }, ytDraft: { ticket: 'CG-1', draftId: 'tabc123-1' } }));
  assert.deepEqual(ids, ['yt_edit_send']);
});

test('feedbackModalView: radio options match the published taxonomy and carry the turn', () => {
  const view = feedbackModalView({ turnId: 'tabc123-1', slug: 'caldora', key: 'thread:1.2', channel: 'C1', ts: '1.1' });
  assert.deepEqual(JSON.parse(view.private_metadata), { t: 'tabc123-1', s: 'caldora', k: 'thread:1.2', c: 'C1', ts: '1.1' });
  const radio = view.blocks.find((b: { block_id?: string }) => b.block_id === FB_REASON.block).element;
  assert.equal(radio.type, 'radio_buttons'); // a group, not a select — the causes stay visible
  assert.equal(radio.options.length, 6);
  for (const o of radio.options) assert.ok(o.text.text.length <= 75, 'plain_text option over Slack cap');
});

test('answerBlocks: no followUp (DM/aven path) → no action row at all', () => {
  assert.deepEqual(actionIds(answerBlocks('plain answer', {})), []);
});

const trail: TrailMeta = { turnId: 't7', steps: 14, elapsedMs: 130_000 };

test('answerBlocks: trail adds the step-count context line and a "Show steps" button', () => {
  const blocks = answerBlocks('answer', { followUp, trail });
  const ctx = blocks.find((b) => b.type === 'context');
  assert.equal(ctx.elements[0].text, '🧭 14 steps · 2m10s');
  // Joins the same action row as the other follow-ups (one row, not two).
  assert.deepEqual(actionIds(blocks), ['show_trail', 'session_panel']);
  const btn = blocks.find((b) => b.type === 'actions').elements[0];
  assert.equal(btn.value, 't7'); // carries only the turnId — the trail stays server-side
});

test('answerBlocks: a zero-step trail (tool-less answer) renders nothing extra', () => {
  const blocks = answerBlocks('plain answer', { trail: { ...trail, steps: 0 } });
  assert.equal(blocks.find((b) => b.type === 'context'), undefined);
  assert.deepEqual(actionIds(blocks), []);
});

test('statusBlocks: carries Show steps + Cancel, both with the turnId', () => {
  const row = statusBlocks('working…', 't9').find((b) => b.type === 'actions');
  assert.deepEqual(
    row.elements.map((e: { action_id: string; value: string }) => [e.action_id, e.value]),
    [
      ['show_trail', 't9'],
      ['cancel_turn', 't9'],
    ],
  );
});

test('backgroundBlocks: same two live buttons as the status message, no ticking clock', () => {
  const blocks = backgroundBlocks('t9', 16 * 60_000);
  assert.deepEqual(actionIds(blocks), ['show_trail', 'cancel_turn']);
  const body = blocks[0].text.text;
  assert.match(body, /Working in the background/);
  assert.match(body, /16m00s/); // one frozen elapsed reading — nothing rewrites it after this
  assert.match(body, /new message/); // the promise the delivery path keeps
});

test('backgroundDoneBlocks: collapses to a pointer line, buttons gone', () => {
  const blocks = backgroundDoneBlocks('✅ Done — answer posted below', { steps: 198, elapsedMs: 24 * 60_000 });
  assert.deepEqual(actionIds(blocks), []);
  assert.equal(blocks[0].elements[0].text, '✅ Done — answer posted below · 🧭 198 steps · 24m00s');
});

// ── "⚙️ Session" panel ───────────────────────────────────────────────────────

const panelInfo = (over: Partial<SessionPanelInfo> = {}): SessionPanelInfo => ({
  slug: 'caldora',
  repos: ['Org/caldora'],
  mcp: ['github'],
  hasSession: false,
  turnInFlight: false,
  prCreated: false,
  ...over,
});

test('sessionPanelBlocks: no session yet → no restart button, says so', () => {
  const blocks = sessionPanelBlocks(panelInfo(), 'v1');
  assert.equal(actionIds(blocks).length, 0);
  assert.match(blocks[0].text.text, /none yet/);
});

test('sessionPanelBlocks: session bound → "Restart session" behind a confirm dialog, carrying the same value', () => {
  const blocks = sessionPanelBlocks(panelInfo({ hasSession: true, sessionSince: '2026-07-15T10:00:00.000Z' }), 'v1');
  assert.deepEqual(actionIds(blocks), ['session_restart']);
  const btn = blocks.find((b) => b.type === 'actions').elements[0];
  assert.equal(btn.value, 'v1'); // reuses the panel button's own value — no new shape
  assert.ok(btn.confirm); // destructive to conversation memory — explicit confirm
  assert.match(blocks[0].text.text, /active.*2026-07-15 10:00/);
});

test('sessionPanelBlocks: reflects turn-in-flight and prCreated in the summary text', () => {
  const blocks = sessionPanelBlocks(panelInfo({ hasSession: true, turnInFlight: true, prCreated: true }), 'v1');
  assert.match(blocks[0].text.text, /Turn running:\* yes/);
  assert.match(blocks[0].text.text, /PR:\* opened from this thread/);
});

// ── ticket card + full-ticket modal ─────────────────────────────────────────

const issue = (over: Partial<YouTrackIssue> = {}): YouTrackIssue => ({
  id: 'ENG-1',
  summary: 'Checkout broken',
  description: 'Steps to reproduce…',
  projectShortName: 'ENG',
  tags: [],
  createdAt: '2026-07-01T10:00:00.000Z',
  reporter: 'jdoe',
  fields: [{ name: 'Priority', value: 'Critical' }],
  links: [],
  ...over,
});
const comment = (i: number, text = `comment ${i}`): YouTrackComment => ({ author: `u${i}`, createdAt: '2026-07-02T00:00:00.000Z', text });
const URL = 'https://yt.example/issue/ENG-1';

test('ticketCardBlocks: offers the "🔍 Full ticket" modal button carrying the ticket id', () => {
  const blocks = ticketCardBlocks(issue(), URL, []);
  const row = blocks.find((b) => b.type === 'actions');
  assert.equal(row.elements[0].action_id, 'ticket_modal');
  assert.equal(row.elements[0].value, 'ENG-1');
});

test('ticketModalView: title/summary/fields/comments all present, every mrkdwn under the 3000 cap', () => {
  const view = ticketModalView(issue(), URL, [comment(1)], ['crash.png']);
  assert.equal(view.type, 'modal');
  assert.equal(view.title.text, 'ENG-1');
  const texts = view.blocks.flatMap((b: { text?: { text?: string }; elements?: { text: string }[] }) =>
    [b.text?.text, ...(b.elements ?? []).map((e) => e.text)].filter(Boolean),
  ) as string[];
  assert.ok(texts.some((t) => t.includes('Checkout broken')));
  assert.ok(texts.some((t) => t.includes('Priority: Critical')));
  assert.ok(texts.some((t) => t.includes('comment 1')));
  assert.ok(texts.some((t) => t.includes('📎 crash.png')));
  for (const t of texts) assert.ok(t.length <= 3000);
});

test('ticketModalView: huge ticket stays under Slack limits, keeps the NEWEST comments', () => {
  const comments = Array.from({ length: 200 }, (_, i) => comment(i, `comment ${i} ${'x'.repeat(500)}`));
  const view = ticketModalView(issue({ description: 'd'.repeat(20000) }), URL, comments, []);
  assert.ok(view.blocks.length <= 100, `blocks: ${view.blocks.length}`);
  const all = JSON.stringify(view.blocks);
  assert.ok(all.includes('comment 199')); // newest kept
  assert.ok(!all.includes('comment 0 ')); // oldest dropped…
  assert.ok(all.includes('earlier comments')); // …and said so
  assert.ok(all.includes('description continues')); // over-long description hands over to YouTrack
});

// ── App Home tab ─────────────────────────────────────────────────────────────
// A section over Slack's 3000-char mrkdwn cap makes views.publish reject the WHOLE
// payload — the Home tab is then stuck on Slack's own "loading" spinner forever,
// since no view ever gets published. Guard every block, not just the "how to use
// me" copy that has blown past the cap before.

test('homeBlocks: every mrkdwn text block stays under Slack\'s 3000-char section cap', () => {
  const projects: ProjectConfig[] = Array.from({ length: 5 }, (_, i) => ({
    slug: `proj-${i}`,
    repos: [`Org/repo-${i}`, `Org/repo-${i}-infra`],
    youtrackProjects: [`PRJ${i}`],
  }));
  const texts = homeBlocks(projects, 'aven-')
    .flatMap((b) => [b.text?.text, ...(b.elements ?? []).map((e: { text: string }) => e.text)])
    .filter(Boolean) as string[];
  assert.ok(texts.length > 0);
  for (const t of texts) assert.ok(t.length <= 3000, `block over Slack's cap: ${t.length} chars`);
});

test('onboardingHomeBlocks: stays under Slack\'s 3000-char section cap', () => {
  const texts = onboardingHomeBlocks()
    .flatMap((b) => [b.text?.text, ...(b.elements ?? []).map((e: { text: string }) => e.text)])
    .filter(Boolean) as string[];
  for (const t of texts) assert.ok(t.length <= 3000);
});

// ── trail modal ─────────────────────────────────────────────────────────────

test('trailModalView: live trail says "still running" + elapsed "so far"; settled says neither', () => {
  const live = JSON.stringify(trailModalView({ steps: ['🔧 step 1'], elapsedMs: 5000, done: false }).blocks);
  assert.ok(live.includes('step 1') && live.includes('Still running') && live.includes('so far'));
  const done = JSON.stringify(trailModalView({ steps: ['🔧 step 1'], elapsedMs: 5000, done: true }).blocks);
  assert.ok(done.includes('step 1') && !done.includes('Still running') && !done.includes('so far'));
});

test('trailModalView: queued (no steps yet) and lost (restart) both explain themselves', () => {
  assert.ok(JSON.stringify(trailModalView({ steps: [], elapsedMs: 0, done: false }).blocks).includes('No steps yet'));
  assert.ok(JSON.stringify(trailModalView(undefined).blocks).includes('no longer available'));
});

test('trailModalView: a huge trail keeps the tail within Slack limits and notes the cut', () => {
  const steps = Array.from({ length: 20000 }, (_, i) => `🔧 step ${i} ${'x'.repeat(20)}`);
  const view = trailModalView({ steps, elapsedMs: 60_000, done: true });
  assert.ok(view.blocks.length <= 100, `blocks: ${view.blocks.length}`);
  const all = JSON.stringify(view.blocks);
  assert.ok(all.includes('step 19999') && all.includes('trimmed')); // tail kept, cut announced
});

// ── the "📝 Report to YouTrack" flow ─────────────────────────────────────────

test('answerBlocks: investigation thread (ytReport) appends "Report to YouTrack"', () => {
  assert.deepEqual(actionIds(answerBlocks('findings…', { followUp, ytReport: 'CG-50' })), ['yt_report', 'session_panel']);
  // …also alongside a PR link, and never without followUp coordinates (nowhere to run the turn).
  assert.deepEqual(actionIds(answerBlocks(PR, { followUp, ytReport: 'CG-50' })), ['pr_link:0', 'yt_report', 'session_panel']);
  assert.deepEqual(actionIds(answerBlocks('findings…', { ytReport: 'CG-50' })), []);
});

test('answerBlocks: draft mode (ytDraft) renders ONLY Edit & send + the privacy note', () => {
  const blocks = answerBlocks('the draft text', { followUp, trail, ytReport: 'CG-50', ytDraft: { ticket: 'CG-50', draftId: 't42' } });
  assert.deepEqual(actionIds(blocks), ['yt_edit_send']);
  const ctx = blocks.find((b) => b.type === 'context');
  assert.match(ctx.elements[0].text, /internal comment/i);
  // The button carries ONLY ids (ticket + server-side draft key) — never the text: Slack
  // rewrites markdown blocks to rich_text, so the message can't round-trip the draft.
  const btn = blocks.find((b) => b.type === 'actions').elements[0];
  assert.deepEqual(JSON.parse(btn.value), { t: 'CG-50', d: 't42' });
});

test('textFromMarkdownBlocks: reassembles chunked markdown, ignores other blocks', () => {
  const blocks = [
    { type: 'markdown', text: 'part one ' },
    { type: 'context', elements: [] },
    { type: 'markdown', text: 'part two' },
    { type: 'actions', elements: [] },
  ];
  assert.equal(textFromMarkdownBlocks(blocks), 'part one part two');
  assert.equal(textFromMarkdownBlocks([]), '');
});

test('answerBlocks draft → textFromMarkdownBlocks recovers the text (pre-delivery fallback)', () => {
  const draft = 'Conclusion.\n\nWhat was checked:\n- logs\n- metrics';
  assert.equal(textFromMarkdownBlocks(answerBlocks(draft, { ytDraft: { ticket: 'CG-50', draftId: 't1' } })), draft);
});

test('reportModalView: meta in private_metadata, pre-filled input, hard length cap', () => {
  const view = reportModalView('CG-50', 'draft body', { channel: 'C1', ts: '111.222', threadTs: '111.000' });
  assert.equal(view.callback_id, YT_SEND_CALLBACK);
  assert.deepEqual(JSON.parse(view.private_metadata), { t: 'CG-50', channel: 'C1', ts: '111.222', threadTs: '111.000' });
  const input = view.blocks.find((b: { block_id?: string }) => b.block_id === YT_SEND_INPUT.block);
  assert.equal(input.element.action_id, YT_SEND_INPUT.action);
  assert.equal(input.element.initial_value, 'draft body');
  // Slack caps inputs ~3000 chars — the view must survive an oversized draft.
  const long = reportModalView('CG-50', 'x'.repeat(5000), { channel: 'C1', ts: '1' });
  assert.equal(long.blocks[0].element.initial_value.length, 2900);
});

test('reportPromptModalView: editable instructions + read-only contract + the skip-preview checkbox', () => {
  const view = reportPromptModalView('CG-50', 'the editable instructions', 'the fixed delivery contract', { key: 'thread:1', channel: 'C1', threadTs: '1' });
  assert.equal(view.callback_id, YT_PROMPT_CALLBACK);
  assert.deepEqual(JSON.parse(view.private_metadata), { t: 'CG-50', key: 'thread:1', channel: 'C1', threadTs: '1' });
  const input = view.blocks.find((b: { block_id?: string }) => b.block_id === YT_PROMPT_INPUT.block);
  assert.equal(input.element.initial_value, 'the editable instructions'); // WYSIWYG: instructions + contract run
  // The contract is DISPLAYED (transparency) but not editable — it lives in a context block,
  // not an input, so a user rewriting the instructions can't delete it.
  const ctx = view.blocks.find((b: { type?: string }) => b.type === 'context');
  assert.match(ctx.elements[0].text, /the fixed delivery contract/);
  const now = view.blocks.find((b: { block_id?: string }) => b.block_id === YT_PROMPT_NOW.block);
  assert.equal(now.optional, true); // unchecked by default → preview flow is the default
  assert.equal(now.element.options[0].value, YT_PROMPT_NOW.value);
});

test('reportPostedBlocks: the shared ✅ confirmation keeps the text and deep-links the comment', () => {
  const blocks = reportPostedBlocks('what was posted', 'CG-50', 'https://yt/issue/CG-50#focus=Comments-4-1.0-0', 'Caldora Team');
  assert.equal(blocks[0].text, 'what was posted');
  assert.match(blocks[1].elements[0].text, /Posted to \*CG-50\*.*open in YouTrack/);
});
