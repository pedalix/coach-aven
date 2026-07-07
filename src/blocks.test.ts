import { test } from 'node:test';
import assert from 'node:assert/strict';
import { answerBlocks, type FollowUp } from './blocks.js';

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
