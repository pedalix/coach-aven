import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeJsonl, type Dataset } from './dataset.js';
import { splitOf } from './metrics.js';
import type { RunResult } from './run.js';
import { familyExact, scoreTask } from './score.js';
import type { DatasetMeta, GoldRow, ItemUnit, Prediction, TaskId } from './types.js';

// Hand-computed examples. The ids are chosen for their fixed hash split (metrics.splitOf): the first test
// pins that assumption, so a change to the split shows up there and not as a riddle in the numbers below.
const DEV = ['u1', 'u3', 'u4', 'u6', 'u9'];
const TEST = ['u2', 'u5', 'u7', 'u8', 'u11'];

const meta = (umbrellas: Record<string, string> = {}): DatasetMeta => ({
  name: 'hand',
  kind: 'synthetic',
  tenant: 'acme-agency',
  tz: 'UTC',
  since: '2026-01-05',
  until: '2026-01-06',
  createdAt: '2026-01-07T00:00:00Z',
  sourceStore: 'test',
  labelSpace: { initiatives: ['A', 'B', 'C'], umbrellas, people: [] },
  counts: {},
});

const item = (id: string, isBot = false): ItemUnit => ({
  id,
  day: '2026-01-05',
  ts: '2026-01-05T09:00:00Z',
  type: 'message',
  source: 'slack',
  account: 'T0',
  container: '#acme-web',
  thread: null,
  author: 'Mara Quill',
  authorPerson: 'mara',
  isBot,
  participants: [],
  toPersons: [],
  subject: null,
  text: 'fixture',
  keys: [],
});

const g = (task: TaskId, id: string, label: string, alts?: string[]): GoldRow => ({ id, task, label, tier: 'human', ...(alts ? { alts } : {}) });
const p = (id: string, label: string | null, conf: number, rung = 'r'): Prediction => ({ id, label, conf, rung });

function dataset(task: TaskId, gold: GoldRow[], ids: string[], o: { umbrellas?: Record<string, string>; dir?: string; bots?: string[] } = {}): Dataset {
  return {
    dir: o.dir ?? '/nonexistent',
    meta: meta(o.umbrellas),
    units: { item: ids.map((id) => item(id, (o.bots ?? []).includes(id))) },
    gold: { [task]: gold },
  };
}

function result(task: TaskId, predictions: Prediction[], o: Partial<RunResult> & { threshold?: number } = {}): RunResult {
  return {
    dataset: 'hand',
    datasetDir: '/nonexistent',
    variant: 'v',
    task,
    opts: { mode: 'replay', memory: 'none', questionsPerDay: 1, auditShare: 0, threshold: o.threshold ?? 0, population: 'gold', tiers: null, runName: 'r', llm: false },
    predictions,
    answered: o.answered ?? [],
    perDay: o.perDay ?? [],
    costUsd: o.costUsd ?? 0,
    startedAt: '2026-01-07T00:00:00Z',
    ms: 1,
  };
}

test('fixture ids sit in the split this file assumes', () => {
  for (const id of DEV) assert.equal(splitOf(id), 'dev', id);
  for (const id of TEST) assert.equal(splitOf(id), 'test', id);
});

// gold: dev u1 A, u3 A, u4 B, u6 B, u9 A · test u2 A, u5 B, u7 A, u8 B (alt C), u11 A
const GOLD = [g('t1-item', 'u1', 'A'), g('t1-item', 'u3', 'A'), g('t1-item', 'u4', 'B'), g('t1-item', 'u6', 'B'), g('t1-item', 'u9', 'A'), g('t1-item', 'u2', 'A'), g('t1-item', 'u5', 'B'), g('t1-item', 'u7', 'A'), g('t1-item', 'u8', 'B', ['C']), g('t1-item', 'u11', 'A')];
// dev: u1 ✓ .9, u3 ✓ .8, u4 ✗ .7, u6 ✓ .6, u9 abstains · test: u2 ✓ .95, u5 ✓ .85, u7 ✗ .75, u8 ✓(alt) .65, u11 abstains
const PREDS = [
  p('u1', 'A', 0.9, 'rule:x'),
  p('u3', 'A', 0.8, 'rule:x'),
  p('u4', 'A', 0.7, 'knn'),
  p('u6', 'B', 0.6, 'knn'),
  p('u9', null, 0, 'abstain'),
  p('u2', 'A', 0.95, 'rule:x'),
  p('u5', 'B', 0.85, 'rule:x'),
  p('u7', 'B', 0.75, 'knn'),
  p('u8', 'C', 0.65, 'knn'),
  p('u11', null, 0, 'abstain'),
];
const IDS = [...DEV, ...TEST];

test('auto share — threshold on dev, measured on test; alts count; abstentions charged', () => {
  const ds = dataset('t1-item', GOLD, IDS);
  const s = scoreTask(ds, result('t1-item', PREDS, { costUsd: 0.5, perDay: [{ day: 'd1', n: 6, decided: 3, correctDecided: 3, questions: 2, answered: 1, asked: 0, effort: 0, audited: 0, costUsd: 0.2 }, { day: 'd2', n: 4, decided: 3, correctDecided: 2, questions: 1, answered: 1, asked: 0, effort: 0, audited: 0, costUsd: 0.3 }] }));
  assert.equal(s.n, 10);
  assert.deepEqual(s.split, { dev: 5, test: 5 });
  // dev curve: .9 1/1, .8 2/2, .7 2/3, .6 3/4 → the widest point at ≥95% is .8 (coverage 2/5)
  assert.equal(s.auto.dev.threshold, 0.8);
  assert.equal(s.auto.dev.coverage, 0.4);
  // test at .8: u2 ✓, u5 ✓ → 2/5 decided, all right
  assert.equal(s.auto.test.decided, 2);
  assert.equal(s.auto.test.correct, 2);
  assert.equal(s.auto.test.coverage, 0.4);
  assert.equal(s.auto.test.precision, 1);
  // oracle on test: .95 1/1, .85 2/2, .75 2/3 → .85, 2/5
  assert.equal(s.auto.oracle.coverage, 0.4);
  // test accuracy: u2, u5, u8 (alt C) right of 5
  assert.equal(s.auto.accuracyAll, 0.6);
  // the Wilson lower bound of 2/2 is far below 95%: the conservative rule decides nothing
  assert.equal(s.autoConservative.dev.threshold, Infinity);
  assert.equal(s.autoConservative.test.coverage, 0);
  assert.equal(s.accuracy, 0.6); // u1 u3 u6 u2 u5 u8 of 10
  assert.deepEqual(s.rungs, [
    { rung: 'knn', n: 4, decided: 4, correct: 2 },
    { rung: 'rule:x', n: 4, decided: 4, correct: 4 },
    { rung: 'abstain', n: 2, decided: 0, correct: 0 },
  ]);
  assert.deepEqual(s.confusions, [
    { gold: 'A', pred: 'B', n: 1 },
    { gold: 'B', pred: 'A', n: 1 },
  ]);
  // cost: $0.5 over 10 units; 4 units clear the dev threshold (.8): u1 u3 u2 u5
  assert.equal(s.costPerUnit, 0.05);
  assert.equal(s.costPerAuto, 0.125);
  assert.equal(s.questions, 3);
  assert.equal(s.questionsPerDay, 1.5);
  assert.equal(s.answeredPerDay, 1);
  assert.equal(s.perClass, undefined);
});

test('umbrella level — a P-code mix-up inside one client is right at the umbrella', () => {
  const ds = dataset('t1-item', GOLD, IDS, { umbrellas: { A: 'X', B: 'X', C: 'Y' } });
  const s = scoreTask(ds, result('t1-item', PREDS), { level: 'umbrella' });
  // u4 (A for B) and u7 (B for A) are both X; u8 predicted C = Y matches its alt C = Y
  assert.equal(s.accuracy, 0.8);
  assert.deepEqual(s.confusions, []);
  assert.equal(scoreTask(ds, result('t1-item', PREDS)).accuracy, 0.6, 'initiative level is unchanged');
});

test('answered units leave the auto machinery but are counted; the run threshold masks low labels', () => {
  const ds = dataset('t1-item', GOLD, IDS);
  const s = scoreTask(ds, result('t1-item', PREDS, { answered: ['u6'] }));
  assert.equal(s.gold, 10);
  assert.equal(s.answered, 1);
  assert.equal(s.n, 9);
  assert.equal(s.split.dev, 4);
  // under a run threshold of .7, u6 (.6) and u8 (.65) were questions, not decisions
  const masked = scoreTask(ds, result('t1-item', PREDS, { threshold: 0.7 }));
  assert.equal(masked.auto.accuracyAll, 0.4); // test: u2, u5 right; u8 no longer decided
  assert.equal(masked.rungs.find((r) => r.rung === 'knn')!.decided, 2);
  // tiers: nothing labelled 'opus' → nothing scored
  assert.equal(scoreTask(ds, result('t1-item', PREDS), { tiers: ['opus'] }).n, 0);
});

test('t4-kind — per class and macro F1 over the decided labels', () => {
  const gold = [g('t4-kind', 'u1', 'request'), g('t4-kind', 'u2', 'question'), g('t4-kind', 'u3', 'noise'), g('t4-kind', 'u4', 'noise')];
  const ds = dataset('t4-kind', gold, ['u1', 'u2', 'u3', 'u4']);
  const s = scoreTask(ds, result('t4-kind', [p('u1', 'request', 0.9), p('u2', 'noise', 0.9), p('u3', 'noise', 0.9), p('u4', null, 0)]));
  // request P1 R1 F1 1 · question P1 (nothing predicted) R0 F1 0 · noise P½ R½ F1 ½ → (1 + 0 + ½) / 3
  assert.equal(s.macroF1, 0.5);
  assert.deepEqual(
    s.perClass!.map((c) => [c.label, c.support, c.predicted, c.correct]),
    [
      ['noise', 2, 2, 1],
      ['question', 1, 0, 0],
      ['request', 1, 1, 1],
    ],
  );
});

test('t4-addressee — sets compare in any order; Jaccard over decided units', () => {
  const gold = [g('t4-addressee', 'u1', 'mara|tobias'), g('t4-addressee', 'u2', 'mara'), g('t4-addressee', 'u3', 'none'), g('t4-addressee', 'u4', 'mara')];
  const ds = dataset('t4-addressee', gold, ['u1', 'u2', 'u3', 'u4']);
  const s = scoreTask(ds, result('t4-addressee', [p('u1', 'tobias|mara', 0.9), p('u2', 'mara|olive', 0.9), p('u3', 'none', 0.9), p('u4', null, 0)]));
  assert.equal(s.accuracy, 0.5); // u1 (order-free) and u3 right; u2 half right is still wrong; u4 abstained
  assert.ok(Math.abs(s.jaccard! - (1 + 0.5 + 1) / 3) < 1e-12);
  assert.deepEqual(s.confusions, [{ gold: 'mara', pred: 'mara|olive', n: 1 }]);
});

test('t2-dedup — pairwise, B-cubed, compression, human safety, exact families and checked pairs', () => {
  // gold families: i1 i2 i5 = F1 (bot alerts), i3 = F2 (a person), i4 = F3 (a person); i6 has no gold
  // predicted: P1 = {i1, i2, i3, i6} (a person folded into the alert family), P4 = {i4}, P5 = {i5} (a missed repeat)
  const dir = mkdtempSync(join(tmpdir(), 'lab-score-'));
  writeJsonl(join(dir, 'gold', 't2-pairs.jsonl'), [
    { a: 'i1', b: 'i2', same: true, tier: 'human' },
    { a: 'i1', b: 'i3', same: false, tier: 'human' },
    { a: 'i4', b: 'i5', same: false, tier: 'human' },
    { a: 'i1', b: 'i5', same: true, tier: 'human' },
    { a: 'i2', b: 'i6', same: true, tier: 'human' },
  ]);
  const gold = [g('t2-dedup', 'i1', 'F1'), g('t2-dedup', 'i2', 'F1'), g('t2-dedup', 'i3', 'F2'), g('t2-dedup', 'i4', 'F3'), g('t2-dedup', 'i5', 'F1')];
  const ds = dataset('t2-dedup', gold, ['i1', 'i2', 'i3', 'i4', 'i5', 'i6'], { dir, bots: ['i1', 'i2', 'i5', 'i6'] });
  const preds = [p('i1', 'P1', 1), p('i2', 'P1', 1), p('i3', 'P1', 1), p('i4', 'P4', 1), p('i5', null, 0), p('i6', 'P1', 1)];
  const s = scoreTask(ds, result('t2-dedup', preds));
  const c = s.cluster!;
  assert.equal(c.units, 5);
  // pairwise: predicted pairs in {i1,i2,i3} = 3, true = 1 (i1-i2); gold pairs in F1 = 3 → P = R = 1/3
  assert.equal(c.pairwise.predPairs, 3);
  assert.equal(c.pairwise.truePairs, 1);
  assert.ok(Math.abs(c.pairwise.precision - 1 / 3) < 1e-12 && Math.abs(c.pairwise.recall - 1 / 3) < 1e-12);
  // B-cubed: i1 i2 (⅔, ⅔), i3 (⅓, 1), i4 (1, 1), i5 (1, ⅓) → both 11/15
  assert.ok(Math.abs(c.bcubed.precision - 11 / 15) < 1e-12 && Math.abs(c.bcubed.recall - 11 / 15) < 1e-12);
  // the abstained i5 stands alone: families P1, P4, i5 over 6 items
  assert.equal(c.families, 3);
  assert.equal(c.compression, 0.5);
  // humans: i3 (folded into the alerts — unsafe) and i4 (alone — safe)
  assert.equal(c.humanUnits, 2);
  assert.equal(c.humanSafety, 0.5);
  // only i4's family is exactly its gold family
  assert.equal(c.exact, 0.2);
  // checked pairs: predicted same = i1-i2, i1-i3, i2-i6 (2 right) · truly same = i1-i2, i1-i5, i2-i6 (2 found)
  assert.deepEqual(c.pairs, { n: 5, predSame: 3, goldSame: 3, precision: 2 / 3, recall: 2 / 3 });
  // per-unit correctness feeds the shared machinery: i4 alone is right; i5 abstained
  assert.equal(s.accuracy, 0.2);
  assert.deepEqual(s.confusions, [], 'family ids are arbitrary: no confusion table for a clustering');
});

test('familyExact — member sets, not family names: a false merge and a missed one both fail', () => {
  const pred = new Map([
    ['a', 'x'],
    ['b', 'x'],
    ['c', 'c'],
    ['d', 'F'],
  ]);
  const gold = new Map([
    ['a', 'F'],
    ['b', 'F'],
    ['c', 'G'],
    ['d', 'H'],
  ]);
  assert.deepEqual(
    [...familyExact(pred, gold)],
    [
      ['a', true],
      ['b', true],
      ['c', true],
      ['d', true],
    ],
  );
  pred.set('c', 'x'); // c folded into a+b's family: all three fail
  assert.deepEqual(
    [...familyExact(pred, gold)].filter(([, ok]) => !ok).map(([id]) => id),
    ['a', 'b', 'c'],
  );
});

test('t2-dedup — a wrong family that happens to carry the gold family\'s name is still wrong', () => {
  const gold = [g('t2-dedup', 'i1', 'F1'), g('t2-dedup', 'i2', 'F1')];
  const ds = dataset('t2-dedup', gold, ['i1', 'i2']);
  // i1 is called 'F1' but stands alone; its gold family F1 also holds i2 → a missed repeat, not a match
  const s = scoreTask(ds, result('t2-dedup', [p('i1', 'F1', 1), p('i2', 'Z', 1)]));
  assert.equal(s.accuracy, 0);
  assert.equal(s.auto.accuracyAll + s.units.filter((u) => u.pred === u.gold).length, 0);
});
