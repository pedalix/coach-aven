import { test } from 'node:test';
import assert from 'node:assert/strict';
import { answerBlocks, statusBlocks, ticketCardBlocks, ticketModalView, trailModalView, type FollowUp, type TrailMeta } from './blocks.js';
import type { YouTrackIssue, YouTrackComment } from './youtrack.js';

// The action row is the last block; its button action_ids tell us which affordance rendered.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function actionIds(blocks: any[]): string[] {
  const row = blocks.find((b) => b.type === 'actions');
  return row ? row.elements.map((e: { action_id: string }) => e.action_id) : [];
}

const followUp: FollowUp = { key: 'thread:123', channel: 'C1', threadTs: '123' };
const PR = 'See https://github.com/Org/repo/pull/7 for the change.';

test('answerBlocks: no PR URL + followUp + not created → offers "Open a PR"', () => {
  assert.deepEqual(actionIds(answerBlocks('done, nothing to link', followUp, false)), ['make_pr']);
});

test('answerBlocks: prCreated latch hides "Open a PR" even without a URL in this message', () => {
  assert.deepEqual(actionIds(answerBlocks('follow-up answer, no link here', followUp, true)), []);
});

test('answerBlocks: a PR URL in the message always shows "View PR" (independent of latch)', () => {
  assert.deepEqual(actionIds(answerBlocks(PR, followUp, false)), ['pr_link:0']);
  // Even with the latch set, a fresh URL still links.
  assert.deepEqual(actionIds(answerBlocks(PR, followUp, true)), ['pr_link:0']);
});

test('answerBlocks: no followUp (DM/aven path) never offers "Open a PR"', () => {
  assert.deepEqual(actionIds(answerBlocks('plain answer', undefined, false)), []);
});

const trail: TrailMeta = { turnId: 't7', steps: 14, elapsedMs: 130_000 };

test('answerBlocks: trail adds the step-count context line and a "Show steps" button', () => {
  const blocks = answerBlocks('answer', followUp, false, trail);
  const ctx = blocks.find((b) => b.type === 'context');
  assert.equal(ctx.elements[0].text, '🧭 14 steps · 2m10s');
  // Joins the same action row as "Open a PR" (one row, not two).
  assert.deepEqual(actionIds(blocks), ['make_pr', 'show_trail']);
  const btn = blocks.find((b) => b.type === 'actions').elements[1];
  assert.equal(btn.value, 't7'); // carries only the turnId — the trail stays server-side
});

test('answerBlocks: a zero-step trail (tool-less answer) renders nothing extra', () => {
  const blocks = answerBlocks('plain answer', undefined, false, { ...trail, steps: 0 });
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
