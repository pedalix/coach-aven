import { test } from 'node:test';
import assert from 'node:assert/strict';
import { answerBlocks, type FollowUp, type TrailMeta } from './blocks.js';

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
