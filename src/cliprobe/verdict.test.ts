import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { RunOutcome, RunVerdict } from './types.js';
import { settle, wantsAnotherRun } from './verdict.js';

const runs = (...v: RunVerdict[]): RunOutcome[] => v.map((verdict) => ({ verdict, observations: {}, costUsd: 0, durationMs: 0 }));

test('settle — the model does not follow the script: an inconclusive run does not count', () => {
  assert.equal(settle(runs('inconclusive'), 1).verdict, 'inconclusive');
  assert.equal(settle(runs('inconclusive', 'holds'), 1).verdict, 'holds');
});

test('settle — a predicted event never comes: a failed run settles as fails', () => {
  assert.deepEqual(settle(runs('fails'), 1), { verdict: 'fails', holds: 0, fails: 1, inconclusive: 0 });
});

test('settle — runs disagree: flaky, even with fewer conclusive runs than declared', () => {
  assert.equal(settle(runs('holds', 'fails'), 3).verdict, 'flaky');
  assert.equal(settle(runs('fails', 'inconclusive', 'holds'), 3).verdict, 'flaky');
});

test('settle — not enough conclusive runs: two holding runs of three declared stay inconclusive', () => {
  assert.equal(settle(runs('holds', 'inconclusive', 'holds'), 3).verdict, 'inconclusive');
  assert.equal(settle(runs('holds', 'holds', 'holds'), 3).verdict, 'holds');
});

test('wantsAnotherRun — until settled or flaky, within the extra attempts for inconclusive runs', () => {
  assert.equal(wantsAnotherRun(runs(), 3), true);
  assert.equal(wantsAnotherRun(runs('holds', 'holds'), 3), true);
  assert.equal(wantsAnotherRun(runs('holds', 'holds', 'holds'), 3), false);
  assert.equal(wantsAnotherRun(runs('holds', 'fails'), 3), false);
  assert.equal(wantsAnotherRun(runs('inconclusive', 'inconclusive', 'inconclusive'), 1), false);
  assert.equal(wantsAnotherRun(runs('inconclusive', 'inconclusive'), 1), true);
});
