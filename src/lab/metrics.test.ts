import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  wilson,
  riskCoverage,
  operatingPoint,
  atThreshold,
  autoShare,
  splitOf,
  pairedBootstrap,
  pairwise,
  bcubed,
  jaccard,
  setKey,
  perClass,
  macroF1,
  rng,
  type Scored,
} from './metrics.js';

const u = (id: string, pred: string | null, conf: number, gold: string, weight?: number): Scored => ({ id, pred, conf, gold, weight });

test('wilson — sane bounds, honest at the extremes', () => {
  const all = wilson(10, 10);
  assert.equal(all.p, 1);
  assert.ok(all.lo < 0.75 && all.lo > 0.6, `10/10 lower bound ~0.72, got ${all.lo}`);
  assert.equal(all.hi, 1);
  const none = wilson(0, 0);
  assert.deepEqual(none, { p: 0, lo: 0, hi: 1 });
  const mid = wilson(95, 100);
  assert.ok(mid.lo > 0.88 && mid.hi < 0.99);
});

test('riskCoverage — strongest first, ties decided together, abstentions never decided', () => {
  const pts = riskCoverage([u('a', 'x', 0.9, 'x'), u('b', 'y', 0.9, 'x'), u('c', 'x', 0.5, 'x'), u('d', null, 0.99, 'x')]);
  assert.equal(pts.length, 2);
  assert.deepEqual(pts[0], { threshold: 0.9, decided: 2, correct: 1, coverage: 0.5, precision: 0.5 });
  assert.equal(pts[1].decided, 3);
  assert.equal(pts[1].coverage, 0.75);
});

test('operatingPoint — widest coverage meeting the floor; nothing when no point qualifies', () => {
  const units = [u('a', 'x', 0.99, 'x'), u('b', 'x', 0.95, 'x'), u('c', 'y', 0.9, 'x'), u('d', 'x', 0.8, 'x')];
  const op = operatingPoint(units, 0.95);
  assert.equal(op.threshold, 0.95);
  assert.equal(op.decided, 2);
  assert.equal(op.coverage, 0.5);
  const none = operatingPoint([u('a', 'y', 0.9, 'x')], 0.95);
  assert.equal(none.threshold, Infinity);
  assert.equal(none.coverage, 0);
  // the Wilson lower bound refuses a 95% promise on two lucky units
  assert.equal(operatingPoint(units, 0.95, { lowerBound: true }).threshold, Infinity);
});

test('weights — minutes, not counts, drive coverage and precision', () => {
  const units = [u('a', 'x', 0.9, 'x', 300), u('b', 'y', 0.8, 'x', 10), u('c', null, 0, 'x', 90)];
  const at = atThreshold(units, 0.8);
  assert.equal(at.coverage, 310 / 400);
  assert.equal(at.precision, 300 / 310);
  assert.equal(at.decided, 2);
  assert.equal(at.correct, 1);
});

test('autoShare — threshold from dev, number from test, oracle only as a bound', () => {
  const dev = [u('d1', 'x', 0.9, 'x'), u('d2', 'x', 0.7, 'x'), u('d3', 'y', 0.6, 'x')];
  const test = [u('t1', 'x', 0.95, 'x'), u('t2', 'y', 0.75, 'x'), u('t3', 'x', 0.65, 'x')];
  const r = autoShare(dev, test, 0.95);
  assert.equal(r.dev.threshold, 0.7);
  assert.equal(r.test.decided, 2); // t1 + t2 (>= 0.7) — t2 wrong: the dev threshold does not transfer
  assert.equal(r.test.precision, 0.5);
  assert.equal(r.oracle.decided, 1);
  assert.equal(r.accuracyAll, 2 / 3);
});

test('splitOf — deterministic and roughly balanced', () => {
  assert.equal(splitOf('fragment:2026-10-01:abc'), splitOf('fragment:2026-10-01:abc'));
  const n = 2000;
  let dev = 0;
  for (let i = 0; i < n; i++) if (splitOf(`unit-${i}`) === 'dev') dev++;
  assert.ok(dev > n * 0.45 && dev < n * 0.55, `dev share ${dev / n}`);
});

test('pairedBootstrap — a clearly better variant wins every resample; identical ones tie', () => {
  const gold = Array.from({ length: 60 }, (_, i) => `g${i % 3}`);
  const a = gold.map((g, i) => u(`${i}`, i % 2 ? g : 'wrong', 1, g));
  const b = gold.map((g, i) => u(`${i}`, g, 1, g));
  const acc = (us: Scored[]) => us.filter((x) => x.pred === x.gold).length / us.length;
  const r = pairedBootstrap(a, b, acc, 200);
  assert.equal(r.delta, 0.5);
  assert.equal(r.pBetter, 1);
  assert.ok(r.lo > 0.3);
  const same = pairedBootstrap(a, a, acc, 50);
  assert.equal(same.delta, 0);
  assert.equal(same.pBetter, 0);
});

test('pairedBootstrap — whole cases are resampled: units that move together widen the interval', () => {
  // 20 cases of 10 units; within a case both variants are right or wrong together, and b's edge sits in 5 cases.
  const a: Scored[] = [];
  const b: Scored[] = [];
  for (let c = 0; c < 20; c++) {
    for (let i = 0; i < 10; i++) {
      a.push({ ...u(`${c}-${i}`, c % 2 ? 'x' : 'y', 1, 'x'), case: `case-${c}` });
      b.push({ ...u(`${c}-${i}`, c % 2 || c % 4 === 0 ? 'x' : 'y', 1, 'x'), case: `case-${c}` });
    }
  }
  const acc = (us: Scored[]) => us.filter((x) => x.pred === x.gold).length / us.length;
  const strip = (us: Scored[]) => us.map(({ case: _c, ...rest }) => rest);
  const byCase = pairedBootstrap(a, b, acc, 500);
  const byUnit = pairedBootstrap(strip(a), strip(b), acc, 500);
  assert.equal(byCase.delta, 0.25);
  assert.equal(byUnit.delta, 0.25);
  // 200 "independent" units vs 20 cases: the honest interval is about three times as wide
  assert.ok(byCase.hi - byCase.lo > 2 * (byUnit.hi - byUnit.lo), `case [${byCase.lo}, ${byCase.hi}] vs unit [${byUnit.lo}, ${byUnit.hi}]`);
  // without case keys every unit is its own case: the plain unit bootstrap, draw for draw
  const single = a.map((x, i) => ({ ...x, case: `solo-${i}` }));
  assert.deepEqual(pairedBootstrap(single, b, acc, 200), pairedBootstrap(strip(a), strip(b), acc, 200));
});

test('rng — seeded and reproducible', () => {
  const a = rng(42);
  const b = rng(42);
  for (let i = 0; i < 5; i++) assert.equal(a(), b());
});

test('pairwise + bcubed — a false merge costs precision, a missed merge costs recall', () => {
  const gold = new Map([['a', 'P1'], ['b', 'P1'], ['c', 'P2'], ['d', 'P3']]);
  const perfect = pairwise(new Map([['a', '1'], ['b', '1'], ['c', '2'], ['d', '3']]), gold);
  assert.deepEqual([perfect.precision, perfect.recall], [1, 1]);
  const glued = pairwise(new Map([['a', '1'], ['b', '1'], ['c', '1'], ['d', '3']]), gold);
  assert.equal(glued.predPairs, 3);
  assert.equal(glued.truePairs, 1);
  assert.equal(glued.precision, 1 / 3);
  assert.equal(glued.recall, 1);
  const split = pairwise(new Map([['a', '1'], ['b', '2'], ['c', '3'], ['d', '4']]), gold);
  assert.equal(split.precision, 1);
  assert.equal(split.recall, 0);
  const b3 = bcubed(new Map([['a', '1'], ['b', '1'], ['c', '1'], ['d', '3']]), gold);
  assert.ok(b3.precision < 1 && b3.recall === 1);
});

test('jaccard + setKey', () => {
  assert.equal(jaccard(['a', 'b'], ['b', 'c']), 1 / 3);
  assert.equal(jaccard([], []), 1);
  assert.equal(setKey(['b', 'a', 'b']), 'a|b');
});

test('perClass + macroF1 — abstentions neither right nor wrong per class', () => {
  const units = [u('1', 'x', 1, 'x'), u('2', 'y', 1, 'x'), u('3', null, 0, 'y'), u('4', 'y', 1, 'y')];
  const rows = perClass(units);
  const x = rows.find((r) => r.label === 'x')!;
  assert.deepEqual([x.support, x.predicted, x.correct], [2, 1, 1]);
  const y = rows.find((r) => r.label === 'y')!;
  assert.deepEqual([y.support, y.predicted, y.correct], [2, 2, 1]);
  assert.ok(macroF1(units) > 0.5 && macroF1(units) < 0.7);
});
