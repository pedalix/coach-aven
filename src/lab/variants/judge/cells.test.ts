import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Cells, cellConf, PRIOR_MEAN } from './cells.js';

test('a fresh table sits on the design priors (static mode)', () => {
  const c = new Cells();
  assert.equal(c.mean('call', 'AA+g'), PRIOR_MEAN['AA+g']);
  assert.equal(c.mean('item-bot', 'XX'), 0.3);
  assert.equal(cellConf(c, 'call', 'AA+g'), 0.93);
});

test('answers move a cell; a kind borrows from the pooled cell', () => {
  const c = new Cells();
  for (let i = 0; i < 10; i++) c.observe('call', 'AA+g', 1);
  // pooled: (10·.93 + 10) / 20 = .965; call: (10·.965 + 10) / 20 = .9825
  assert.ok(Math.abs(c.pooled('AA+g') - 0.965) < 1e-9);
  assert.ok(Math.abs(c.mean('call', 'AA+g') - 0.9825) < 1e-9);
  // a kind without answers of its own sits on the pooled value, not the bare prior
  assert.ok(Math.abs(c.mean('thread', 'AA+g') - 0.965) < 1e-9);
  // wrong answers pull it under τ
  for (let i = 0; i < 6; i++) c.observe('thread', 'AA+g', 0);
  assert.ok(c.mean('thread', 'AA+g') < 0.95);
});

test('one answer = one observation, split by the share it got right', () => {
  const c = new Cells();
  c.observe('item-bot', 'AA', 0.5);
  assert.equal(c.n('item-bot', 'AA'), 1);
  assert.deepEqual(
    c.table().map(({ kind, cell, a, b }) => ({ kind, cell, a, b })),
    [{ kind: 'item-bot', cell: 'AA', a: 0.5, b: 0.5 }],
  );
});

test('tie-breaks: +.005 precedent, +.005 in candidates, −.01 candidates miss; clamped', () => {
  const c = new Cells();
  assert.equal(cellConf(c, 'work', 'AA', { precedentAgrees: true, inCandidates: true }), 0.86);
  assert.equal(cellConf(c, 'work', 'AA', { candidatesMiss: true }), 0.84);
  for (let i = 0; i < 1000; i++) c.observe('work', 'AA+g', 1);
  assert.ok(cellConf(c, 'work', 'AA+g', { precedentAgrees: true, inCandidates: true }) <= 0.999);
});
