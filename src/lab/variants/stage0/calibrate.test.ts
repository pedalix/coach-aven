import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { MemoryRow } from '../../types.js';
import { Calibration, TAU, type Said } from './calibrate.js';

const row = (id: string, label: string, o: Partial<MemoryRow> = {}): MemoryRow => ({ id, task: 't1-item', day: '2026-09-07', label, source: 'human', ...o });
const said = (m: Record<string, Said>) => (id: string) => m[id];

test('before any evidence an instance is its rung prior; Beta(20c, 20(1-c)) moves with answers', () => {
  const c = new Calibration();
  assert.equal(c.mean('channel:#ops', 0.95), 0.95);
  c.update([row('u1', 'x/infra', { answer: 'q1' })], said({ u1: { instance: 'channel:#ops', label: 'x/infra' } }));
  assert.ok(Math.abs(c.mean('channel:#ops', 0.95) - 20 / 21) < 1e-12); // (19 + 1) / (20 + 1)
  c.update([row('u2', 'x/shop', { answer: 'q2', audit: true })], said({ u2: { instance: 'channel:#ops', label: 'x/infra' } }));
  assert.ok(c.mean('channel:#ops', 0.95) < TAU); // one wrong audit demotes a .95 instance: it no longer decides alone
  assert.deepEqual(c.stat('channel:#ops'), { instance: 'channel:#ops', right: 1, wrong: 1 });
});

test('one answer is ONE observation, however many units it covered; a re-fed row never counts twice', () => {
  const c = new Calibration();
  const s = said({ a: { instance: 'title:sync', label: 'x/a' }, b: { instance: 'title:sync', label: 'x/a' }, d: { instance: 'title:sync', label: 'x/a' } });
  const rows = [row('a', 'x/a', { answer: 'call-1' }), row('b', 'x/a', { answer: 'call-1' }), row('d', 'x/b', { answer: 'call-2' })];
  c.update(rows, s);
  c.update(rows, s); // the nightly pass gets every row so far, every night
  assert.deepEqual(c.stat('title:sync'), { instance: 'title:sync', right: 1, wrong: 1 });
  // an answer whose units disagree with the instance in part is a miss
  const p = new Calibration();
  p.update([row('a', 'x/a', { answer: 'q' }), row('b', 'x/b', { answer: 'q' })], s);
  assert.deepEqual(p.stat('title:sync'), { instance: 'title:sync', right: 0, wrong: 1 });
});

test('the invariant: machine and seed rows never move an instance; abstentions charge nothing', () => {
  const c = new Calibration();
  const s = said({ u1: { instance: 'rule:r1', label: 'x/a' }, u2: { instance: 'abstain', label: null } });
  c.update([row('u1', 'x/b', { source: 'machine' }), row('u1', 'x/b', { source: 'seed' }), row('u2', 'x/b', { answer: 'q' })], s);
  assert.equal(c.stat('rule:r1'), undefined);
  assert.equal(c.mean('rule:r1', 0.97), 0.97);
  assert.deepEqual(c.all(), []);
});

test('a caller-tracked instance (unit → instance) wins over what the floor said; the row’s predicted label fills in', () => {
  const c = new Calibration();
  c.update([row('u9', 'x/a', { answer: 'q', predicted: 'x/a' })], () => undefined, new Map([['u9', 'key:VN']]));
  assert.deepEqual(c.stat('key:VN'), { instance: 'key:VN', right: 1, wrong: 0 });
});
