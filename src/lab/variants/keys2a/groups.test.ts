import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Prediction } from '../../types.js';
import { umbrellaFirst, umbrellaGroupOf } from './groups.js';

const DAY = '2026-01-05';
const q = (id: string, label: string | null, conf: number, group = `thread=${id}`, value = 1): Prediction => ({ id, label, conf, rung: 'held:key:AC', ask: { group, value, guess: label, form: 'choose' } });

test('questions whose client is decided are asked per client and day; the rest keep K’s groups', () => {
  const preds: Prediction[] = [
    q('a1', 'acme/shop', 0.85),
    q('a2', 'acme/erp-sync', 0.6),
    q('a3', null, 0),
    { id: 'a4', label: 'acme/shop', conf: 0.97, rung: 'key:AC' }, // decided: never a question
    q('b1', 'beta/app', 0.85),
    q('c1', 'acme/shop', 0.85, 'thread=c1', 2), // client known only at .90: K's group stays
  ];
  const clients = new Map([
    ['a1', { client: 'acme', umbrellaConf: 0.97 }],
    ['a2', { client: 'acme', umbrellaConf: 0.97 }],
    ['a3', { client: 'acme', umbrellaConf: 0.96 }],
    ['a4', { client: 'acme', umbrellaConf: 0.97 }],
    ['b1', { client: 'beta', umbrellaConf: 0.95 }],
    ['c1', { client: 'acme', umbrellaConf: 0.9 }],
  ]);
  const moved = umbrellaFirst(preds, (id) => clients.get(id), { day: DAY, tau: 0.95, weight: () => 1, gain: () => 3 });
  assert.equal(moved, 4);
  const by = new Map(preds.map((p) => [p.id, p]));
  const acme = umbrellaGroupOf('acme', DAY);
  for (const id of ['a1', 'a2', 'a3']) {
    assert.equal(by.get(id)!.ask!.group, acme);
    assert.equal(by.get(id)!.ask!.guess, 'acme/shop', 'the surest member’s own guess');
    assert.equal(by.get(id)!.ask!.form, 'confirm');
  }
  assert.equal(by.get('a4')!.ask, undefined);
  assert.equal(by.get('b1')!.ask!.group, umbrellaGroupOf('beta', DAY));
  assert.equal(by.get('c1')!.ask!.group, 'thread=c1');
  assert.equal(by.get('c1')!.ask!.form, 'choose');
  // value: each member's K value plus one share of the group's gain
  assert.equal(by.get('a1')!.ask!.value, 1 + 3 / 3);
});

test('a big client-day is chunked like K’s groups; a guessless chunk is a choose', () => {
  const preds = Array.from({ length: 14 }, (_, i) => q(`u${String(i).padStart(2, '0')}`, i < 13 ? null : 'acme/shop', i < 13 ? 0 : 0.85));
  umbrellaFirst(preds, () => ({ client: 'acme', umbrellaConf: 0.99 }), { day: DAY, tau: 0.95, weight: () => 1, max: 12 });
  const groups = new Map<string, Prediction[]>();
  for (const p of preds) groups.set(p.ask!.group!, [...(groups.get(p.ask!.group!) ?? []), p]);
  assert.deepEqual([...groups.keys()].sort(), [umbrellaGroupOf('acme', DAY), `${umbrellaGroupOf('acme', DAY)}#2`]);
  assert.equal(groups.get(umbrellaGroupOf('acme', DAY))!.length, 12, 'the least sure first');
  const second = groups.get(`${umbrellaGroupOf('acme', DAY)}#2`)!;
  assert.ok(second.some((p) => p.id === 'u13'));
  assert.ok(second.every((p) => p.ask!.guess === 'acme/shop' && p.ask!.form === 'confirm'));
  assert.ok(groups.get(umbrellaGroupOf('acme', DAY))!.every((p) => p.ask!.guess === null && p.ask!.form === 'choose'));
});
