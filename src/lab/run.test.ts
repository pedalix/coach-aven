import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadDataset, saveMeta, writeJsonl, type Dataset } from './dataset.js';
import { renderReport } from './report.js';
import { loadResult, loadRun, noteVariants, resultDir, runTask, type RunOpts } from './run.js';
import { scoreTask } from './score.js';
import type { DayCtx, FragmentUnit, GoldRow, ItemUnit, LlmLike, MemoryRow, Prediction, TaskId, Unit, Variant } from './types.js';

// A three-day fictional tenant: items for t4-kind (one without gold, so pool ≠ population), fragments for
// t1-fragment. Every text carries a TEXT- marker and every subject a SUBJ- marker, so a test can prove the
// report never quotes them.
const D1 = '2026-01-05';
const D2 = '2026-01-06';
const D3 = '2026-01-07';

const item = (id: string, day: string, extra: Partial<ItemUnit> = {}): ItemUnit => ({
  id,
  day,
  ts: `${day}T09:00:00Z`,
  type: 'message',
  source: 'slack',
  account: 'T0',
  container: '#acme-web',
  thread: null,
  author: 'Mara Quill',
  authorPerson: 'mara',
  isBot: false,
  participants: [],
  toPersons: [],
  subject: `SUBJ-${id}`,
  text: `TEXT-${id} could you check the staging deploy?`,
  keys: [],
  ...extra,
});

const frag = (id: string, day: string, minutes: number): FragmentUnit => ({
  id,
  day,
  kind: 'thread',
  start: `${day}T10:00:00Z`,
  end: `${day}T11:00:00Z`,
  minutes,
  title: `SUBJ-${id}`,
  source: 'slack',
  container: '#acme-web',
  participants: ['mara'],
  projectKeys: [],
  repo: null,
  weight: 1,
  refs: [`slack:T0:${id}`],
  text: `TEXT-${id}`,
});

const gold = (task: TaskId, id: string, label: string, tier: GoldRow['tier'] = 'human'): GoldRow => ({ id, task, label, tier });

function makeDataset(): Dataset {
  const dir = mkdtempSync(join(tmpdir(), 'lab-run-'));
  saveMeta(dir, {
    name: 'tiny-bench',
    kind: 'synthetic',
    tenant: 'acme-agency',
    tz: 'UTC',
    since: D1,
    until: D3,
    subject: 'owner',
    createdAt: '2026-01-08T00:00:00Z',
    sourceStore: 'test fixture',
    labelSpace: { initiatives: ['acme/web', 'acme/app', 'none'], umbrellas: { 'acme/web': 'acme', 'acme/app': 'acme' }, people: ['mara', 'owner'] },
    counts: { item: 9, fragment: 4 },
  });
  writeJsonl(join(dir, 'units', 'item.jsonl'), [
    item('i1', D1),
    item('i2', D1, { isBot: true }),
    item('i3', D1),
    item('i4', D1), // no gold: in the pool, not in the 'gold' population
    item('i5', D2),
    item('i6', D2, { isBot: true }),
    item('i7', D2),
    item('i8', D3),
    item('i9', D3),
  ]);
  writeJsonl(join(dir, 'units', 'fragment.jsonl'), [frag('f1', D1, 30), frag('f2', D1, 90), frag('f3', D1, 10), frag('f4', D2, 20)]);
  writeJsonl(join(dir, 'gold', 't4-kind.jsonl'), [
    gold('t4-kind', 'i1', 'request'),
    gold('t4-kind', 'i2', 'noise', 'opus'),
    gold('t4-kind', 'i3', 'question'),
    gold('t4-kind', 'i5', 'info'),
    gold('t4-kind', 'i6', 'noise', 'rule'),
    gold('t4-kind', 'i7', 'request'),
    gold('t4-kind', 'i8', 'incident', 'opus'),
    gold('t4-kind', 'i9', 'noise'),
  ]);
  writeJsonl(join(dir, 'gold', 't1-fragment.jsonl'), ['f1', 'f2', 'f3', 'f4'].map((id) => gold('t1-fragment', id, 'acme/web')));
  writeJsonl(join(dir, 'gold', 't2-dedup.jsonl'), [gold('t2-dedup', 'i1', 'fam-a'), gold('t2-dedup', 'i3', 'fam-a')]);
  return loadDataset(dir);
}

// t4-kind answers (threshold 0.5 → auto: i1 ✓, i2 ✓, i6 ✓, i9 ✗; questions: i3, i5, i7, i8).
const PLAN: Record<string, [string | null, number]> = {
  i1: ['request', 0.9],
  i2: ['noise', 0.99],
  i3: [null, 0],
  i4: ['info', 0.8],
  i5: ['question', 0.4],
  i6: ['noise', 0.99],
  i7: [null, 0],
  i8: ['incident', 0.3],
  i9: ['request', 0.95],
  f1: [null, 0],
  f2: ['acme/app', 0.2],
  f3: [null, 0],
  f4: ['acme/web', 0.9],
};

interface Seen {
  day: string;
  units: string[];
  pool: string[];
  memory: MemoryRow[];
}

function stub(name = 'stub', plan = PLAN): Variant & { seen: Seen[]; nights: { day: string; memory: MemoryRow[] }[] } {
  const seen: Seen[] = [];
  const nights: { day: string; memory: MemoryRow[] }[] = [];
  return {
    name,
    description: 'records what it is shown; answers from a fixed plan',
    tasks: ['t1-fragment', 't2-dedup', 't4-kind'],
    seen,
    nights,
    async decide(task: TaskId, units: Unit[], ctx: DayCtx): Promise<Prediction[]> {
      seen.push({ day: ctx.day, units: units.map((u) => u.id), pool: ctx.pool.map((u) => u.id), memory: ctx.memory });
      if (ctx.llm) await ctx.llm.call({ model: 'haiku', system: 's', prompt: ctx.day });
      if (task === 't2-dedup') return units.map((u) => ({ id: u.id, label: 'fam-x', conf: 1, rung: 'stub' }));
      return units.map((u) => ({ id: u.id, label: plan[u.id]?.[0] ?? null, conf: plan[u.id]?.[1] ?? 0, rung: plan[u.id]?.[0] ? 'stub' : 'abstain' }));
    },
    async nightly(_task: TaskId, ctx: DayCtx): Promise<void> {
      nights.push({ day: ctx.day, memory: ctx.memory });
    },
  };
}

const fakeLlm: LlmLike = { call: async () => ({ text: '{}', costUsd: 0.01, cached: false }) };

function opts(labDir: string, o: Partial<RunOpts> = {}): RunOpts {
  return { mode: 'static', memory: 'none', llm: null, runName: 'r1', log: () => {}, labDir, threshold: 0.5, ...o };
}

const tmpLab = () => mkdtempSync(join(tmpdir(), 'lab-out-'));

test('static — days in order, cold every day, pool wider than the population, nobody answers', async () => {
  const ds = makeDataset();
  const v = stub();
  const r = await runTask(ds, v, 't4-kind', opts(tmpLab(), { llm: fakeLlm }));
  assert.deepEqual(
    v.seen.map((s) => s.day),
    [D1, D2, D3],
  );
  assert.ok(v.seen.every((s) => s.memory.length === 0));
  assert.deepEqual(v.seen[0].units, ['i1', 'i2', 'i3']);
  assert.deepEqual(v.seen[0].pool, ['i1', 'i2', 'i3', 'i4']);
  assert.equal(v.nights.length, 0, 'static never learns');
  assert.deepEqual(r.answered, []);
  assert.equal(r.predictions.length, 8);
  assert.deepEqual(
    r.perDay.map(({ day, n, decided, correctDecided, questions, answered }) => ({ day, n, decided, correctDecided, questions, answered })),
    [
      { day: D1, n: 3, decided: 2, correctDecided: 2, questions: 1, answered: 0 },
      { day: D2, n: 3, decided: 1, correctDecided: 1, questions: 2, answered: 0 },
      { day: D3, n: 2, decided: 1, correctDecided: 0, questions: 1, answered: 0 },
    ],
  );
  // one metered call per day
  assert.deepEqual(
    r.perDay.map((d) => d.costUsd),
    [0.01, 0.01, 0.01],
  );
  assert.ok(Math.abs(r.costUsd - 0.03) < 1e-12);
  assert.equal(r.opts.llm, true);
});

test('replay — answers within the budget, least sure first; memory only from earlier days; nightly sees the day', async () => {
  const ds = makeDataset();
  const v = stub();
  const r = await runTask(ds, v, 't4-kind', opts(tmpLab(), { mode: 'replay', questionsPerDay: 1 }));
  // day 2 has two questions (i5 at 0.4, i7 abstained): the budget of one goes to the less sure i7
  assert.deepEqual(r.answered, ['i3', 'i7', 'i8']);
  assert.deepEqual(
    r.perDay.map((d) => [d.questions, d.answered]),
    [
      [1, 1],
      [2, 1],
      [1, 1],
    ],
  );
  assert.deepEqual(v.seen[0].memory, []);
  // the row also keeps what the pipeline said before the answer (here: it abstained)
  assert.deepEqual(v.seen[1].memory, [{ id: 'i3', task: 't4-kind', day: D1, label: 'question', source: 'human', answer: `${D1}:i3`, predicted: null, conf: 0, rung: 'abstain' }]);
  for (const s of v.seen) assert.ok(s.memory.every((m) => m.day < s.day), `memory on ${s.day} must come from earlier days`);
  assert.deepEqual(
    v.seen[2].memory.map((m) => m.id),
    ['i3', 'i7'],
  );
  // the nightly pass runs after the day's answers are in
  assert.deepEqual(
    v.nights.map((n) => n.memory.map((m) => m.id)),
    [['i3'], ['i3', 'i7'], ['i3', 'i7', 'i8']],
  );
  // answered units are resolved by a person, not auto-decided
  assert.equal(r.perDay.reduce((a, d) => a + d.decided, 0), 4);
});

test('replay — a zero budget answers nothing; the threshold decides what is a question', async () => {
  const ds = makeDataset();
  const none = await runTask(ds, stub(), 't4-kind', opts(tmpLab(), { mode: 'replay', questionsPerDay: 0 }));
  assert.deepEqual(none.answered, []);
  const strict = await runTask(ds, stub(), 't4-kind', opts(tmpLab(), { mode: 'replay', questionsPerDay: 0, threshold: 0.95 }));
  // only i2, i6 (0.99) and i9 (0.95) clear 0.95
  assert.equal(strict.perDay.reduce((a, d) => a + d.decided, 0), 3);
  assert.equal(strict.perDay.reduce((a, d) => a + d.questions, 0), 5);
});

test('replay loop — the pipeline remembers its own decisions, wrong ones included', async () => {
  const ds = makeDataset();
  const v = stub();
  await runTask(ds, v, 't4-kind', opts(tmpLab(), { mode: 'replay', memory: 'loop', questionsPerDay: 1 }));
  assert.deepEqual(
    v.seen[1].memory.map((m) => [m.id, m.label, m.source]),
    [
      ['i3', 'question', 'human'],
      ['i1', 'request', 'machine'],
      ['i2', 'noise', 'machine'],
    ],
  );
  const last = v.nights.at(-1)!.memory;
  const i9 = last.find((m) => m.id === 'i9')!;
  assert.deepEqual(
    { id: i9.id, task: i9.task, day: i9.day, label: i9.label, source: i9.source, predicted: i9.predicted },
    { id: 'i9', task: 't4-kind', day: D3, label: 'request', source: 'machine', predicted: 'request' },
    'i9 is wrong (gold noise) and is remembered as the pipeline said it',
  );
});

test('replay oracle — every gold label of earlier days, as a person would have given it', async () => {
  const ds = makeDataset();
  const v = stub();
  await runTask(ds, v, 't4-kind', opts(tmpLab(), { mode: 'replay', memory: 'oracle', questionsPerDay: 1 }));
  assert.deepEqual(
    v.seen[1].memory.map((m) => [m.id, m.label, m.source]),
    [
      ['i1', 'request', 'human'],
      ['i2', 'noise', 'human'],
      ['i3', 'question', 'human'],
    ],
  );
  assert.equal(v.seen[2].memory.length, 6);
});

test('fragments — the costliest questions first; minutes before confidence', async () => {
  const ds = makeDataset();
  const r = await runTask(ds, stub(), 't1-fragment', opts(tmpLab(), { mode: 'replay', questionsPerDay: 2 }));
  // day 1 questions: f1 (30 min), f2 (90 min, 0.2), f3 (10 min) → f2 then f1
  assert.deepEqual(r.answered, ['f2', 'f1']);
});

test('population — gold by default, all on request, always all for dedup; tiers narrow the gold', async () => {
  const ds = makeDataset();
  const lab = tmpLab();
  assert.equal((await runTask(ds, stub(), 't4-kind', opts(lab, { population: 'all' }))).predictions.length, 9);
  assert.equal((await runTask(ds, stub(), 't4-kind', opts(lab, { tiers: ['human'] }))).predictions.length, 5);
  const dedup = await runTask(ds, stub(), 't2-dedup', opts(lab, { population: 'gold' }));
  assert.equal(dedup.predictions.length, 9);
  // i1 and i3 are gold fam-a, but fam-x holds every item: their predicted family (seen through the gold
  // units) is exactly fam-a's members, so both count as right
  assert.equal(dedup.perDay[0].correctDecided, 2);
});

test('a skipped unit is an abstention; a made-up id is dropped; a variant must do the task', async () => {
  const ds = makeDataset();
  const lazy: Variant = {
    name: 'lazy',
    description: 'answers one unit a day and invents another',
    tasks: ['t4-kind'],
    decide: async (_t, units) => [
      { id: units[0].id, label: 'request', conf: 1, rung: 'x' },
      { id: 'nope', label: 'noise', conf: 1, rung: 'x' },
    ],
  };
  const r = await runTask(ds, lazy, 't4-kind', opts(tmpLab()));
  assert.equal(r.predictions.length, 8);
  assert.equal(r.predictions.filter((p) => p.rung === 'missing' && p.label === null).length, 5);
  assert.ok(!r.predictions.some((p) => p.id === 'nope'));
  await assert.rejects(runTask(ds, lazy, 't1-item', opts(tmpLab())), /does not do t1-item/);
});

test('results persist under LAB_DIR and load back; a run lists its results in variant order', async () => {
  const ds = makeDataset();
  const lab = tmpLab();
  noteVariants('r1', ['stub', 'alt'], lab);
  const r = await runTask(ds, stub(), 't4-kind', opts(lab));
  await runTask(ds, stub('alt'), 't4-kind', opts(lab));
  const dir = resultDir(r, lab);
  assert.ok(dir.startsWith(lab));
  assert.ok(existsSync(join(dir, 't4-kind.predictions.jsonl')));
  const back = loadResult(join(dir, 't4-kind.result.json'));
  assert.deepEqual(back.predictions, r.predictions);
  assert.deepEqual(back.perDay, r.perDay);
  assert.equal(back.datasetDir, ds.dir);
  assert.deepEqual(
    loadRun('r1', lab).map((x) => x.variant),
    ['stub', 'alt'],
  );
});

test('end to end — run, score, report: numbers and labels, never a unit text, subject or id', async () => {
  const ds = makeDataset();
  const lab = tmpLab();
  const entries = [];
  for (const v of [stub('ref'), stub('other', { ...PLAN, i9: ['noise', 0.95], i5: ['info', 0.6] })]) {
    const result = await runTask(ds, v, 't4-kind', opts(lab));
    entries.push({ result, score: scoreTask(ds, result) });
  }
  const md = renderReport(entries, { iters: 200 });
  assert.match(md, /## tiny-bench · t4-kind/);
  assert.match(md, /Paired bootstrap vs \*\*ref\*\*/);
  assert.match(md, /\| other \| static ≥0\.5 \|/);
  assert.match(md, /Top confusions/);
  assert.doesNotMatch(md, /TEXT-|SUBJ-/);
  assert.doesNotMatch(md, /\bi[1-9]\b/, 'unit ids stay out of the report');
});

// --- the person's side of a replay: what gets asked and audited ------------------------------------------

// One day, two question groups ranked by the variant: g1 asks to confirm a guess for a1+a2, g2 is b1 alone.
function askDataset(goldOfA: string): Dataset {
  const dir = mkdtempSync(join(tmpdir(), 'lab-ask-'));
  saveMeta(dir, { ...loadDataset(makeDataset().dir).meta, name: 'ask-bench' });
  writeJsonl(join(dir, 'units', 'item.jsonl'), [item('a1', D1), item('a2', D1), item('b1', D1)]);
  writeJsonl(join(dir, 'gold', 't4-kind.jsonl'), [gold('t4-kind', 'a1', goldOfA), gold('t4-kind', 'a2', goldOfA), gold('t4-kind', 'b1', 'question')]);
  return loadDataset(dir);
}

const asker: Variant = {
  name: 'asker',
  description: 'two ranked question groups: a confirm of a guess, then a plain question',
  tasks: ['t4-kind'],
  decide: async (_t, units) =>
    units.map((u) =>
      u.id.startsWith('a')
        ? { id: u.id, label: null, conf: 0, rung: 'abstain', ask: { group: 'g1', value: 2, form: 'confirm' as const, guess: 'request' } }
        : { id: u.id, label: null, conf: 0, rung: 'abstain', ask: { group: 'g2', value: 1 } },
    ),
};

test('replay — questions go in rank order and are paid after the answer: whether one is asked never depends on its gold', async () => {
  // g1's guess is wrong (1.5 questions) on a budget of 1: it is still asked first, and it uses the day up
  const wrong = await runTask(askDataset('noise'), asker, 't4-kind', opts(tmpLab(), { mode: 'replay', questionsPerDay: 1 }));
  assert.deepEqual(wrong.answered, ['a1', 'a2']);
  assert.deepEqual([wrong.perDay[0].asked, wrong.perDay[0].effort], [1, 1.5]);
  // the same guess right (half a question): g1 again, and the half left over buys g2 — the day may overrun by one group
  const right = await runTask(askDataset('request'), asker, 't4-kind', opts(tmpLab(), { mode: 'replay', questionsPerDay: 1 }));
  assert.deepEqual(right.answered, ['a1', 'a2', 'b1']);
  assert.deepEqual([right.perDay[0].asked, right.perDay[0].effort], [2, 1.5]);
  // no budget, no questions
  const none = await runTask(askDataset('noise'), asker, 't4-kind', opts(tmpLab(), { mode: 'replay', questionsPerDay: 0 }));
  assert.deepEqual(none.answered, []);
});

test('replay — audit credit banked on days with nothing to check is capped: the first busy day keeps its questions', async () => {
  // Eight quiet days (one abstention each, nothing auto-decided), then a day with four confident units and a question.
  const days = Array.from({ length: 9 }, (_, i) => `2026-01-${String(5 + i).padStart(2, '0')}`);
  const dir = mkdtempSync(join(tmpdir(), 'lab-audit-'));
  saveMeta(dir, { ...loadDataset(makeDataset().dir).meta, name: 'audit-bench', until: days[8]! });
  const units = [...days.slice(0, 8).map((d, i) => item(`q${i + 1}`, d)), ...['a1', 'a2', 'a3', 'a4', 'q9'].map((id) => item(id, days[8]!))];
  writeJsonl(join(dir, 'units', 'item.jsonl'), units);
  writeJsonl(join(dir, 'gold', 't4-kind.jsonl'), units.map((u) => gold('t4-kind', u.id, 'request')));
  const plan: Record<string, [string | null, number]> = Object.fromEntries(units.map((u) => [u.id, u.id.startsWith('a') ? ['request', 0.99] : [null, 0]]));
  const r = await runTask(loadDataset(dir), stub('quiet', plan), 't4-kind', opts(tmpLab(), { mode: 'replay', questionsPerDay: 3, auditShare: 0.15 }));
  const last = r.perDay.at(-1)!;
  // 8 × 0.45 banked would be 3.6 + 0.45 → four audits and no question; carried credit is capped at one audit
  assert.deepEqual([last.decided, last.audited, last.answered, last.effort], [4, 1, 1, 2]);
  assert.ok(r.answered.includes('q9'));
  assert.ok(r.perDay.every((d) => d.effort <= 3), 'audits never take more than the day');
});

test('--opt settings are saved with the result and named in the report; a run without them saves none', async () => {
  const ds = makeDataset();
  const lab = tmpLab();
  process.env.LAB_OPT_machineWeight = '0';
  try {
    const r = await runTask(ds, stub(), 't4-kind', opts(lab, { mode: 'replay', questionsPerDay: 1 }));
    assert.deepEqual(r.opts.opt, { machineWeight: '0' });
    assert.deepEqual(loadResult(join(resultDir(r, lab), 't4-kind.result.json')).opts.opt, { machineWeight: '0' });
    const md = renderReport([{ result: r, score: scoreTask(ds, r) }], { iters: 10 });
    assert.match(md, /\| stub \| replay·none q1 ≥0\.5 · machineWeight=0 \|/);
  } finally {
    delete process.env.LAB_OPT_machineWeight;
  }
  assert.equal((await runTask(ds, stub(), 't4-kind', opts(tmpLab()))).opts.opt, undefined);
});

test('report — the floor names the auto@ columns; the τ column keeps the cut it was measured at', async () => {
  const ds = makeDataset();
  const result = await runTask(ds, stub(), 't4-kind', opts(tmpLab()));
  const md = renderReport([{ result, score: scoreTask(ds, result, { floor: 0.9 }) }], { iters: 10 });
  assert.match(md, /\| auto@90 test \| auto@90 conservative \| auto at τ \.95 \(P\) \|/);
  assert.match(renderReport([{ result, score: scoreTask(ds, result) }], { iters: 10 }), /\| auto@95 test \| auto@95 conservative \| auto at τ \.95 \(P\) \|/);
});
