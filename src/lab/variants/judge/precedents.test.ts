import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { FragmentUnit, ItemUnit } from '../../types.js';
import { distinctiveTokens, formatPrecedent, PrecedentPool, seriesOf, similarity, summaryOf, type Summary } from './precedents.js';

const sum = (title: string, text: string, extra: Partial<Summary> = {}): Summary => ({ title, text, container: null, series: seriesOf(title), counterparts: [], ...extra });

test('seriesOf: one recurring title whatever the date, number or topic', () => {
  assert.equal(seriesOf('Weekly sync 12.10 — budget'), 'weekly sync');
  assert.equal(seriesOf('Weekly Sync #14 — hiring'), 'weekly sync');
  assert.equal(seriesOf('Re: Invoice 2026-10'), 'invoice');
});

test('similarity: token overlap plus container, series and counterpart bonuses', () => {
  const pool = new PrecedentPool();
  pool.add('p1', 'acme/web', '2026-01-05', 'human', sum('Checkout bug', 'promo checkout fails', { container: '#acme-web', counterparts: ['mara'] }));
  const [p] = pool.rank(sum('Checkout bug again', 'checkout fails on promo', { container: '#acme-web', counterparts: ['mara'] }));
  // tokens {checkout, bug, again, fails, promo} vs {checkout, bug, promo, fails} → 4/5, + .2 container + .2 series? no (series differ) + .1 mara
  assert.ok(Math.abs(p!.sim - (4 / 5 + 0.2 + 0.1)) < 1e-9);
  assert.equal(similarity(sum('x', 'y'), p!.p), 0);
});

test('pass A gets ranks 1–5, pass B ranks 6–10; a small pool is a seeded draw for B', () => {
  const pool = new PrecedentPool();
  for (let i = 0; i < 12; i++) pool.add(`p${i}`, 'acme/web', `2026-01-${String(10 + i).padStart(2, '0')}`, 'human', sum(`Checkout ${'x'.repeat(i)}`, `checkout promo ${i}`));
  const q = sum('Checkout', 'checkout promo');
  const ranked = pool.rank(q).map((r) => r.p.id);
  const { a, b } = pool.forPasses(q, 'seed');
  assert.deepEqual(a.map((p) => p.id), ranked.slice(0, 5));
  assert.deepEqual(b.map((p) => p.id), ranked.slice(5, 10));

  const small = new PrecedentPool();
  for (let i = 0; i < 4; i++) small.add(`s${i}`, 'acme/web', '2026-01-05', 'human', sum(`Checkout ${i}`, 'checkout'));
  const one = small.forPasses(q, 'seed-1');
  const two = small.forPasses(q, 'seed-1');
  assert.equal(one.a.length, 4);
  assert.equal(one.b.length, 4);
  assert.deepEqual(one.b.map((p) => p.id), two.b.map((p) => p.id)); // deterministic
});

test('summaries and the precedent line never carry more than the design allows', () => {
  const f: FragmentUnit = { id: 'frag-1', day: '2026-01-05', kind: 'call', start: '2026-01-05T09:00:00Z', end: '2026-01-05T10:00:00Z', minutes: 60, title: 'Weekly sync 5.1 — checkout', source: 'granola', container: null, participants: ['owner', 'mara'], projectKeys: [], repo: null, weight: 1, refs: [], text: `see https://shop.acme.example/promo?id=123 ${'word '.repeat(200)}` };
  const s = summaryOf('t1-fragment', f, 'owner');
  assert.deepEqual(s.counterparts, ['mara']);
  assert.equal(s.series, 'weekly sync');
  assert.ok(s.text.startsWith('see shop.acme.example '));
  assert.ok(s.text.length <= 400);
  const it: ItemUnit = { id: 'slack:T0:1', day: '2026-01-05', ts: '2026-01-05T09:00:00Z', type: 'message', source: 'slack', account: 'T0', container: '#acme-web', thread: null, author: 'Mara Quill', authorPerson: 'mara', isBot: false, participants: [], toPersons: ['owner'], subject: null, text: 'hi', keys: [] };
  assert.deepEqual(summaryOf('t1-item', it, 'owner').counterparts, ['mara']);
  const pool = new PrecedentPool();
  pool.add('frag-1', 'acme/web', '2026-01-05', 'human', s);
  const line = formatPrecedent(pool.rank(s)[0]!.p);
  assert.match(line, /^\[acme\/web\] \(2026-01-05\) Weekly sync 5\.1 — checkout — see shop/);
  assert.ok(line.length < 340);
});

test('distinctive tokens: what only the label’s precedents say', () => {
  const pool = new PrecedentPool();
  pool.add('a', 'acme/web', '2026-01-05', 'human', sum('Checkout banner', 'promo banner live'));
  pool.add('b', 'globex/ops', '2026-01-05', 'human', sum('Checkout outage', 'promo servers down'));
  const shown = pool.rank(sum('Checkout', 'promo')).map((r) => r.p);
  assert.deepEqual(distinctiveTokens(shown, 'acme/web').sort(), ['banner', 'live']);
});
