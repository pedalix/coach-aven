// Questions and audits (learn-ask.ts): grouping ≤ 12, value with the yield, reach over 14 days, the audit credit, a
// seeded sample.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { auditSample, auditSize, groupQuestions, reachOf } from './learn-ask.js';

test('a group is valued by its members’ uncertainty plus the yield; overflow chunks rank lower', () => {
  const qs = Array.from({ length: 14 }, (_, i) => ({ id: `u${String(i).padStart(2, '0')}`, conf: 0, weight: 1, group: 'family=acme', yield: 6 }));
  qs.push({ id: 'f1', conf: 0.5, weight: 30, group: 'call:c1', yield: 0 });
  const a = groupQuestions(qs);
  assert.equal(a.get('u00')!.group, 'family=acme');
  assert.equal(a.get('u12')!.group, 'family=acme#2');
  assert.ok(Math.abs(a.get('u00')!.value - (1 + 6 / 12)) < 1e-9, 'own term + an equal share of the yield');
  assert.equal(a.get('u13')!.value, 1, 'the second chunk buys no yield');
  assert.equal(a.get('f1')!.value, 15, 'minutes × (1 − conf)');
});

test('reach counts a key’s units over the last 14 days, today included', () => {
  const log = new Map([['2026-02-24', 5], ['2026-02-25', 1], ['2026-03-10', 2], ['2026-03-11', 9]]);
  assert.equal(reachOf(log, '2026-03-10'), 3);
  assert.equal(reachOf(undefined, '2026-03-10'), 0);
});

test('the audit credit accrues Q × share a day from the first answered day; each day draws its whole part', () => {
  assert.deepEqual(['03-01', '03-02', '03-03', '03-04', '03-05'].map((d) => auditSize('2026-03-01', `2026-${d}`, 0.45)), [0, 0, 1, 0, 1]);
  assert.equal(auditSize(null, '2026-03-05', 0.45), 0, 'nobody answered yet: nothing to audit for');
  assert.equal(auditSize('2026-03-01', '2026-03-05', 0), 0);
  assert.equal(auditSize('2026-03-01', '2026-03-01', 2.5), 2);
});

test('the audit sample is seeded by (seed, today): the same every build of a day', () => {
  const ids = Array.from({ length: 30 }, (_, i) => `slack:T0ACME:C0ACME:${i}`);
  const a = auditSample(ids, 'acme', '2026-03-10', 3);
  assert.equal(a.length, 3);
  assert.deepEqual(auditSample([...ids].reverse(), 'acme', '2026-03-10', 3), a, 'input order does not matter');
  assert.notDeepEqual(auditSample(ids, 'acme', '2026-03-11', 3), a, 'another day, another sample');
  assert.deepEqual(auditSample(ids, 'acme', '2026-03-10', 0), []);
});
