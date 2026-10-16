// Earned Keys (learn-keys.ts) on fictional keys: k answers before a key predicts, trials before a weak type decides,
// contradiction for good, one answer = one observation, the floor first, rule candidates.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideUnit, isActive, keyId, Learner, newPool, notePool, type FloorView } from './learn-keys.js';

const TAU = 0.95;
const NO_FLOOR: FloorView = { label: null, conf: 0, rung: 'abstain', candidates: [] };
const FAM = keyId('family', 'acme-alerts|<n> down|shop.acme.example');
const CHAN = keyId('container', 'C0ACMEWEB1');

test('a strong key decides after one answer; a weak one needs k answers and earned trials', () => {
  const l = new Learner();
  assert.equal(l.predict(FAM), null);
  l.observe(FAM, 'acme/shop', 'q1');
  const d = decideUnit(NO_FLOOR, [FAM], l, TAU);
  assert.deepEqual([d.label, d.rung], ['acme/shop', 'earned:family']);
  assert.ok(Math.abs(d.conf - 0.951) < 1e-9, 'h = 19/20 plus the one-answer tie-break');

  l.observe(CHAN, 'acme/web', 'q1');
  assert.equal(l.predict(CHAN), null, 'container needs k = 2');
  l.observe(CHAN, 'acme/web', 'q2');
  const g = decideUnit(NO_FLOOR, [CHAN], l, TAU);
  assert.deepEqual([g.label, g.rung], ['acme/web', 'guess:container']);
  assert.ok(g.conf < TAU, 'consistent, but the type is only .80 sure');
  for (let i = 0; i < 30; i++) l.trial(CHAN, `t${i}`, true);
  assert.equal(decideUnit(NO_FLOOR, [CHAN], l, TAU).rung, 'earned:container', '30 right trials lift Beta(8,2) to 38/40');
  assert.equal(l.trial(CHAN, 't0', false), false, 'one trial per key × answer');
  l.trial(CHAN, 'x1', false);
  l.trial(CHAN, 'x2', false);
  assert.ok(decideUnit(NO_FLOOR, [CHAN], l, TAU).conf < TAU, 'and two wrong ones cost it again');
});

test('one answer is one observation; two labels contradict a key for good', () => {
  const l = new Learner();
  for (let i = 0; i < 12; i++) l.observe(CHAN, 'acme/web', 'day1:group');
  assert.equal(l.tables.get(CHAN)!.n, 1);
  assert.equal(l.predict(CHAN), null);
  l.observe(FAM, 'acme/shop', 'q1');
  l.observe(FAM, 'acme/sync', 'q2');
  assert.equal(l.contradicted(FAM), true);
  l.observe(FAM, 'acme/shop', 'q3');
  assert.equal(l.predict(FAM), null, 'more answers for one side do not heal it');
  const k = keyId('container', 'C0ACMEMIX1');
  l.observe(k, 'acme/web', 'q9');
  l.observe(k, 'acme/app', 'q9');
  assert.equal(l.contradicted(k), true, 'one answer labelling a key two ways contradicts it too');
});

test('the floor decides first; keys outrank a floor below τ; a split decides nothing', () => {
  const l = new Learner();
  l.observe(FAM, 'acme/shop', 'q1');
  const floor = (label: string, conf: number): FloorView => ({ label, conf, rung: 'key:AC', candidates: [] });
  assert.deepEqual(decideUnit(floor('acme/sync', 0.97), [FAM], l, TAU).label, 'acme/sync', 'a floor at ≥ τ decides');
  const d = decideUnit(floor('acme/sync', 0.85), [FAM], l, TAU);
  assert.deepEqual([d.label, d.rung], ['acme/shop', 'earned:family']);
  const host = keyId('host', 'shop.acme.example');
  l.observe(host, 'acme/sync', 'q2');
  const s = decideUnit(floor('acme/sync', 0.85), [FAM, host], l, TAU);
  assert.ok(s.conf < TAU, 'two keys disagree: nothing decided');
  assert.equal(s.guess, 'acme/sync', 'the floor’s own sub-τ label is the surest guess');
  assert.equal(decideUnit({ ...NO_FLOOR, candidates: ['globex/portal'] }, [], l, TAU).rung, 'guess:candidate');
});

test('pool statistics: a series speaks once seen on two calls, a token while it is rare', () => {
  const s = newPool();
  const series = keyId('series', 'acme weekly');
  notePool(s, [series], 'call:1');
  assert.equal(isActive(s, series), false);
  notePool(s, [series], 'call:1');
  assert.equal(isActive(s, series), false, 'two topics of one call are one call');
  notePool(s, [series], 'call:2');
  assert.equal(isActive(s, series), true);
  const tok = keyId('token', 'kubernetes');
  for (let i = 0; i < 40; i++) notePool(s, i < 2 ? [tok] : [], `c${i}`);
  assert.equal(isActive(s, tok), true, '2 of 43 units');
  for (let i = 0; i < 3; i++) notePool(s, [tok], `d${i}`);
  assert.equal(isActive(s, tok), false, '5 of 46 is no longer rare');
});

test('rule candidates: ≥ 3 agreeing answers on a type measured ≥ .9 — never a thread', () => {
  const l = new Learner();
  const host = keyId('host', 'shop.acme.example');
  const thread = keyId('thread', 'slack:T0ACME/C0ACME/1');
  for (const q of ['q1', 'q2', 'q3']) for (const k of [host, thread, CHAN]) l.observe(k, 'acme/shop', q);
  l.observe(keyId('app', 'acme-api'), 'acme/shop', 'q1');
  assert.deepEqual(l.ruleCandidates(), [{ key: host, label: 'acme/shop', support: 3 }]);
});
