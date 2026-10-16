import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { MemoryRow } from '../../types.js';
import { Learner, decideUnit, evidenceWeight, obsIdOf, type FloorView } from './learner.js';
import { groupQuestions, reachOf } from './questions.js';
import { keyId, TAU } from './spec.js';

const NO_FLOOR: FloorView = { label: null, conf: 0, rung: 'abstain', candidates: [] };
const FAM = keyId('family', 'acme-alerts|<n> down|shop.acme.example');
const CHAN = keyId('container', '#acme-web');

test('a key earns the right to decide after k agreeing answers (strong type: one answer)', () => {
  const l = new Learner();
  assert.equal(l.predict(FAM), null, 'no answer, no prediction');
  assert.equal(decideUnit(NO_FLOOR, [FAM], l, TAU).label, null);
  l.observe(FAM, 'acme/shop', 'ans-1');
  const p = l.predict(FAM)!;
  assert.equal(p.label, 'acme/shop');
  assert.ok(Math.abs(p.conf - 0.951) < 1e-9, 'h_T = 19/20 plus the one-answer tie-break');
  const d = decideUnit(NO_FLOOR, [FAM], l, TAU);
  assert.equal(d.label, 'acme/shop');
  assert.equal(d.rung, 'earned:family');
  assert.ok(d.conf >= TAU);
});

test('a weak type needs k answers to predict and trials to decide', () => {
  const l = new Learner();
  l.observe(CHAN, 'acme/web', 'ans-1');
  assert.equal(l.predict(CHAN), null, 'container needs k = 2 independent answers');
  l.observe(CHAN, 'acme/web', 'ans-2');
  const g = decideUnit(NO_FLOOR, [CHAN], l, TAU);
  assert.equal(g.label, 'acme/web');
  assert.ok(g.conf < TAU, 'consistent, but the type is only .80 sure: a guess, i.e. a question');
  assert.equal(g.rung, 'guess:container');
  // The type earns trust on checked units: 30 right predictions lift Beta(8,2) to 38/40.
  for (let i = 0; i < 30; i++) l.trial('container', true);
  const d = decideUnit(NO_FLOOR, [CHAN], l, TAU);
  assert.equal(d.rung, 'earned:container');
  assert.ok(d.conf >= TAU);
  // …and one wrong one costs it again.
  l.trial('container', false);
  l.trial('container', false);
  assert.ok(decideUnit(NO_FLOOR, [CHAN], l, TAU).conf < TAU);
});

test('a contradiction stops a key for good', () => {
  const l = new Learner();
  l.observe(FAM, 'acme/shop', 'ans-1');
  assert.equal(decideUnit(NO_FLOOR, [FAM], l, TAU).rung, 'earned:family');
  l.observe(FAM, 'acme/web', 'ans-2');
  assert.equal(l.contradicted(FAM), true);
  assert.equal(l.predict(FAM), null);
  l.observe(FAM, 'acme/shop', 'ans-3');
  assert.equal(l.predict(FAM), null, 'more answers for one side do not heal it');
  assert.equal(decideUnit(NO_FLOOR, [FAM], l, TAU).label, null);
});

test('one answer covering many units is one observation', () => {
  const l = new Learner();
  for (let i = 0; i < 12; i++) l.observe(CHAN, 'acme/web', 'day1:group-a');
  assert.equal(l.tables.get(CHAN)!.n, 1);
  assert.equal(l.predict(CHAN), null, 'twelve units of one answer are still one answer (k = 2)');
  l.observe(CHAN, 'acme/web', 'day2:group-b');
  assert.equal(l.tables.get(CHAN)!.n, 2);
  assert.ok(l.predict(CHAN));
  // One answer that labels the key's units two ways contradicts it, however it is counted.
  const k = keyId('container', '#acme-misc');
  l.observe(k, 'acme/web', 'day1:group-c');
  l.observe(k, 'acme/app', 'day1:group-c');
  assert.equal(l.contradicted(k), true);
});

test('machine rows carry no weight unless the ablation gives them one', () => {
  const row = (source: MemoryRow['source'], extra: Partial<MemoryRow> = {}): MemoryRow => ({ id: 'u1', task: 't1-item', day: '2026-01-05', label: 'acme/web', source, ...extra });
  assert.equal(evidenceWeight(row('machine'), 0), 0);
  assert.equal(evidenceWeight(row('machine'), 0.25), 0.25);
  assert.equal(evidenceWeight(row('human'), 0), 1);
  assert.equal(evidenceWeight(row('seed'), 0), 1);
  const l = new Learner();
  assert.equal(l.observe(FAM, 'acme/web', obsIdOf(row('machine')), evidenceWeight(row('machine'), 0)), false);
  assert.equal(l.tables.size, 0);
  assert.equal(obsIdOf(row('human', { answer: 'd1:g' })), 'd1:g');
  assert.equal(obsIdOf(row('seed')), 'seed:2026-01-05:u1');
});

test('the floor decides first; keys that disagree decide nothing; guesses stay below τ', () => {
  const l = new Learner();
  const fam2 = keyId('family', 'acme-alerts|<n> up|shop.acme.example');
  l.observe(FAM, 'acme/shop', 'a1');
  l.observe(fam2, 'acme/web', 'a2');
  const floor: FloorView = { label: 'acme/app', conf: 0.97, rung: 'rule:r1', candidates: [] };
  const f = decideUnit(floor, [FAM], l, TAU);
  assert.equal(f.label, 'acme/app');
  assert.equal(f.rung, 'rule:r1');
  assert.equal(f.preds.length, 1, 'the key still predicted: an audit of the unit is a trial for it');
  const split = decideUnit(NO_FLOOR, [FAM, fam2], l, TAU);
  assert.ok(split.conf < TAU);
  assert.equal(split.rung, 'guess:split');
  const weak = decideUnit({ label: 'acme/web', conf: 0.8, rung: 'title:web', candidates: [] }, [], l, TAU);
  assert.equal(weak.label, 'acme/web');
  assert.equal(weak.conf, 0.8);
  const cand = decideUnit({ label: null, conf: 0, rung: 'abstain', candidates: ['acme/app'] }, [], l, TAU);
  assert.equal(cand.rung, 'guess:candidate');
  assert.ok(cand.conf < TAU);
  // A direct key (cowork) predicts its value at its type's mean, with no answers at all.
  const cw = l.predict(keyId('cowork', 'acme/web'))!;
  assert.equal(cw.label, 'acme/web');
  assert.equal(cw.conf, 0.5);
});

test('rule candidates: ≥3 agreeing answers on a type measured ≥ .9', () => {
  const l = new Learner();
  for (const a of ['a1', 'a2', 'a3']) l.observe(FAM, 'acme/shop', a);
  for (const a of ['a1', 'a2', 'a3']) l.observe(CHAN, 'acme/web', a);
  assert.deepEqual(l.ruleCandidates(), [FAM], 'container is only .80: not a rule yet');
});

test('questions: ≤12 per group, the yield goes to the first chunk, reach counts 14 days', () => {
  const qs = Array.from({ length: 14 }, (_, i) => ({ id: `u${String(i).padStart(2, '0')}`, conf: 0, weight: 1, group: FAM, yield: 6 }));
  const asked = groupQuestions([...qs, { id: 'solo', conf: 0.5, weight: 30, group: 'call:x', yield: 0 }]);
  const groups = new Map<string, number>();
  for (const a of asked.values()) groups.set(a.group, (groups.get(a.group) ?? 0) + a.value);
  assert.equal([...asked.values()].filter((a) => a.group === FAM).length, 12);
  assert.equal([...asked.values()].filter((a) => a.group === `${FAM}#2`).length, 2);
  assert.ok(Math.abs(groups.get(FAM)! - (12 + 6)) < 1e-9);
  assert.ok(Math.abs(groups.get(`${FAM}#2`)! - 2) < 1e-9);
  assert.equal(groups.get('call:x'), 15, 'minutes × (1 − conf)');
  const log = new Map([
    ['2026-01-01', 5],
    ['2026-01-10', 2],
    ['2026-01-14', 1],
    ['2026-01-15', 9],
  ]);
  assert.equal(reachOf(log, '2026-01-14'), 8);
  assert.equal(reachOf(log, '2026-01-15'), 12, 'the 1st falls out of a 14-day window ending on the 15th; the 15th is in');
});
