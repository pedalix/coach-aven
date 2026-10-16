import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VETO_CONF, vetoGroupOf, vetoQuestions, type Vetoed } from './veto.js';

const v = (id: string, instance: string, kase: string, weight = 1, label = 'nordwind/shop'): Vetoed => ({ id, label, instance, case: kase, weight });

test('veto questions: grouped by (X, case), K’s own value term (1 − .70) per member', () => {
  const asks = vetoQuestions([v('a', 'key:NW', 'ticket:NW-1'), v('b', 'key:NW', 'ticket:NW-1'), v('c', 'key:NW', 'ticket:NW-2')], () => 0);
  assert.equal(VETO_CONF, 0.7);
  assert.equal(asks.get('a')!.group, vetoGroupOf({ label: 'nordwind/shop', case: 'ticket:NW-1' }));
  assert.equal(asks.get('a')!.group, asks.get('b')!.group);
  assert.notEqual(asks.get('a')!.group, asks.get('c')!.group);
  assert.ok(asks.get('a')!.group.startsWith('veto:'), 'never merged into one of K’s groups');
  for (const id of ['a', 'b', 'c']) assert.equal(asks.get(id)!.value, 0.3);
  // two structural labels in one case are two questions (the runner asks a group with its first member's guess)
  const mixed = vetoQuestions([v('x', 'rule:r1', 'call:9', 1, 'nordwind/shop'), v('y', 'rule:r2', 'call:9', 1, 'inhouse/booker')], () => 0);
  assert.notEqual(mixed.get('x')!.group, mixed.get('y')!.group);
});

test('the targeting yield: 0.5 · the instance’s recent vetoes, on its lead group only', () => {
  const susp = (inst: string) => (inst === 'key:NW' ? 6 : inst === 'key:KS' ? 1 : 0);
  const asks = vetoQuestions(
    [v('a', 'key:NW', 'ticket:NW-1'), v('b', 'key:NW', 'ticket:NW-1'), v('c', 'key:NW', 'ticket:NW-2'), v('d', 'key:KS', 'ticket:KS-4', 1, 'kestrel/app'), v('f', 'excl:pia', 'call:7', 30)],
    susp,
  );
  // ticket NW-1 has the most own value of key:NW's groups: it carries the instance's 0.5·6 = 3, split over its two members
  assert.equal(asks.get('a')!.value, 0.3 + 1.5);
  assert.equal(asks.get('b')!.value, 0.3 + 1.5);
  assert.equal(asks.get('c')!.value, 0.3);
  assert.equal(asks.get('d')!.value, 0.3 + 0.5);
  // minutes weigh as in K: a 30-minute call topic is worth 9, with no suspicion on its instance
  assert.equal(asks.get('f')!.value, 9);
});

test('more than 12 vetoed units of one case: chunks, the yield on the first', () => {
  const many = Array.from({ length: 14 }, (_, i) => v(`u${String(i).padStart(2, '0')}`, 'key:NW', 'ticket:NW-1'));
  const asks = vetoQuestions(many, () => 4);
  const groups = new Set([...asks.values()].map((a) => a.group));
  assert.equal(groups.size, 2);
  const first = [...asks.values()].filter((a) => !a.group.endsWith('#2'));
  const second = [...asks.values()].filter((a) => a.group.endsWith('#2'));
  assert.equal(first.length, 12);
  assert.equal(second.length, 2);
  assert.ok(first.every((a) => Math.abs(a.value - (0.3 + 2 / 12)) < 1e-6));
  assert.ok(second.every((a) => a.value === 0.3));
});
