import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { MemoryRow } from '../../types.js';
import { CtxKeys, ctxKeyOf } from './ctxkeys.js';

const row = (id: string, label: string, answer: string, source: MemoryRow['source'] = 'human', extra: Partial<MemoryRow> = {}): MemoryRow => ({ id, task: 't1-item', day: '2026-01-05', label, source, answer, ...extra });

test('two agreeing independent answers make a ctx key predict; one answer covering many units counts once', () => {
  const c = new CtxKeys();
  for (const id of ['u1', 'u2', 'u3']) c.attach(id, 'key:AC', '2026-01-05');
  c.nightly([row('u1', 'acme/shop', 'q1'), row('u2', 'acme/shop', 'q1')], 't1-item', 0);
  assert.equal(c.predict('u3', ctxKeyOf('key:AC')), null, 'one answer id: k = 2 not met');
  c.nightly([row('u3', 'acme/shop', 'q2')], 't1-item', 0);
  const p = c.predict('u4', ctxKeyOf('key:AC'));
  assert.equal(p?.label, 'acme/shop');
  assert.ok(p!.conf < 0.95, 'the type is only .80 homophilous until trials prove more');
});

test('an answer that labels a rung’s units two ways contradicts its key for good; trials move the type', () => {
  const c = new CtxKeys({ a: 19, b: 1, k: 1 });
  for (const id of ['u1', 'u2', 'u3', 'u4']) c.attach(id, 'key:VN', '2026-01-05');
  c.nightly([row('u1', 'v/shop', 'q1')], 't1-item', 0);
  assert.equal(c.predict('u2', ctxKeyOf('key:VN'))?.label, 'v/shop');
  // u2 was predicted shop; the person says erp: a failed trial, and the key now holds two labels
  const r = c.nightly([row('u2', 'v/erp', 'q2'), row('u3', 'v/shop', 'q2')], 't1-item', 0);
  assert.deepEqual([r.trials, r.right], [1, 0]);
  assert.ok(c.h() < 0.95);
  assert.equal(c.predict('u4', ctxKeyOf('key:VN')), null);
  assert.equal(c.learner.contradicted(ctxKeyOf('key:VN')), true);
});

test('machine rows are not evidence (unless the poisoning ablation weighs them); rows are consumed once', () => {
  const c = new CtxKeys({ a: 19, b: 1, k: 1 });
  c.attach('u1', 'key:AC', '2026-01-05');
  c.attach('u2', 'key:AC', '2026-01-05');
  const machine = [row('u1', 'acme/shop', 'm1', 'machine')];
  assert.equal(c.nightly(machine, 't1-item', 0).observations, 0);
  assert.equal(c.predict('u2', ctxKeyOf('key:AC')), null);
  assert.equal(c.nightly(machine, 't1-item', 1).observations, 0, 'already consumed');
  const p = new CtxKeys({ a: 19, b: 1, k: 1 });
  p.attach('u1', 'key:AC', '2026-01-05');
  assert.equal(p.nightly(machine, 't1-item', 1).observations, 1, 'machineWeight 1: the loop learns from itself');
  assert.equal(c.nightly([row('x9', 'acme/shop', 'q9')], 't1-item', 0).rows, 0, 'a unit no rung mapped carries no ctx key');
});
