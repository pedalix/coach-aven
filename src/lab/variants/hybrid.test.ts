// The hybrid end to end over a fictional tenant (the K2a fixture): Acme Bikes runs an online shop and an ERP sync
// (siblings; the `AC` tracker prefix routes to the shop only), Beta runs one app (`BT`, no siblings). The floor is a
// stand-in for stage 0 with stage 0's own rung calibration; the model is CANNED — what both passes answer for a unit is
// looked up by a marker word in its text (Q1, Q2 …), so no directive can double as a registry cue. No claude anywhere.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadDataset, saveMeta, writeJsonl } from '../dataset.js';
import { runTask } from '../run.js';
import type { DatasetMeta, DayCtx, ItemUnit, LlmLike, MemoryRow, MentionUnit, Prediction, TaskId, Unit } from '../types.js';
import { hybridState, makeHybrid } from './hybrid.js';
import { judgeState } from './judge.js';
import { makeK2a } from './keys2a.js';
import type { Trusted } from './keys2a/floor.js';
import { Calibration, type Said } from './stage0/calibrate.js';
import type { Floor, Stage0 } from './stage0/index.js';

const D1 = '2026-01-05';
const D2 = '2026-01-06';
const D3 = '2026-01-07';

const META: DatasetMeta = {
  name: 'hybrid-bench',
  kind: 'synthetic',
  tenant: 'agency',
  tz: 'UTC',
  since: D1,
  until: D3,
  subject: 'owner',
  createdAt: '2026-01-08T00:00:00Z',
  sourceStore: 'test fixture',
  labelSpace: { initiatives: ['acme/shop', 'acme/erp-sync', 'acme/admin', 'beta/app'], umbrellas: { 'acme/shop': 'acme', 'acme/erp-sync': 'acme', 'acme/admin': 'acme', 'beta/app': 'beta' }, people: ['owner'] },
  counts: {},
};

function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'hybrid-'));
  const ann = join(dir, 'tenant', 'annotations');
  mkdirSync(ann, { recursive: true });
  writeFileSync(
    join(dir, 'tenant', 'initiatives.json'),
    JSON.stringify({
      companies: [
        { id: 'acme', umbrella: 'acme', name: 'Acme Bikes' },
        { id: 'beta', umbrella: 'beta', name: 'Beta Health' },
      ],
      initiatives: [
        { id: 'acme/shop', umbrella: 'acme', company: 'acme', name: 'Online shop', status: 'active', sources: { youtrack_prefixes: ['AC'], calendar_title_patterns: ['Checkout'] } },
        { id: 'acme/erp-sync', umbrella: 'acme', company: 'acme', name: 'ERP stock-sync bridge', status: 'active', sources: {} },
        { id: 'acme/admin', umbrella: 'acme', company: 'acme', name: 'Acme admin', status: 'active', sources: {} },
        { id: 'beta/app', umbrella: 'beta', company: 'beta', name: 'Patient app', status: 'active', sources: { jira_keys: ['BT'] } },
      ],
    }),
  );
  writeFileSync(join(ann, 'people.json'), JSON.stringify([{ person_id: 'owner', name: 'Mara Keller', identities: [] }]));
  writeFileSync(join(ann, 'rules.json'), JSON.stringify([]));
  writeFileSync(join(ann, 'attribution.json'), JSON.stringify({ subject: 'owner', admin: { acme: 'acme/admin' } }));
  return dir;
}

const item = (id: string, day: string, text: string, thread = id, extra: Partial<ItemUnit> = {}): ItemUnit => ({
  id,
  day,
  ts: `${day}T09:00:00Z`,
  type: 'comment',
  source: 'youtrack',
  account: 'agency',
  container: null,
  thread,
  author: 'Lena Ostrova',
  authorPerson: null,
  isBot: false,
  participants: [],
  toPersons: [],
  subject: null,
  text,
  keys: [...text.matchAll(/\b[A-Z]{2}-\d+\b/g)].map((m) => m[0]),
  ...extra,
});

// Stage 0's stand-in: AC → the shop, BT → the app (.97, the text-key rung), with stage 0's rung-instance calibration;
// t4: a bot is noise at .95, a person's item is open. One per run (ctx.state), like the real floor.
function fakeFloor(ctx: DayCtx): Stage0 {
  const hit = ctx.state.get('fake-floor') as Stage0 | undefined;
  if (hit) return hit;
  const calib = new Calibration();
  const said = new Map<string, Said>();
  const open = (c: string): Floor => ({ label: null, conf: 0, rung: 'abstain', candidates: [], hint: '', case: c });
  const route = (u: ItemUnit): Floor => {
    const k = u.keys.find((x) => /^(AC|BT)-/.test(x))?.slice(0, 2);
    const label = k === 'AC' ? 'acme/shop' : k === 'BT' ? 'beta/app' : null;
    said.set(u.id, { instance: label ? `key:${k}` : 'abstain', label });
    return label ? { label, conf: calib.mean(`key:${k}`, 0.97), prior: 0.97, rung: `key:${k}`, candidates: [label], hint: `key ${k}`, case: `ticket:${u.thread}` } : open(`ticket:${u.thread}`);
  };
  const memo = new Map<string, Floor>();
  const fl: Stage0 = {
    fragment: () => {
      throw new Error('no fragments here');
    },
    item: (u) => {
      const f = memo.get(u.id) ?? route(u);
      memo.set(u.id, f);
      return { ...f, senderClass: u.isBot ? 'bot' : 'human', family: u.isBot ? `fam:${u.author}` : u.id, hosts: [], apps: [] };
    },
    mention: (u) => open(u.id),
    kind: (u) => (u.isBot ? { label: 'noise', conf: 0.95, rung: 'sender:bot', candidates: [], hint: '', case: `thread:${u.thread}` } : open(`thread:${u.thread}`)),
    addressee: (u) => open(u.id),
    dedup: (units) => new Map(units.map((u) => [u.id, { cluster: u.id, conf: 1 }])),
    labelSpace: (task) => (task === 't4-kind' ? ['request', 'question', 'commitment', 'incident', 'info', 'noise'] : [...META.labelSpace.initiatives, 'none', 'unregistered']),
    cards: () => [],
    calibrate: (rows, decided) => calib.update(rows, (id) => said.get(id), decided),
    said: (id) => said.get(id),
  };
  ctx.state.set('fake-floor', fl);
  return fl;
}

// What both passes answer, by the marker word of a unit's text.
const SAYS: Record<string, { label: string; cite?: string; kind?: string }> = {
  Q1: { label: 'acme/erp-sync' },
  Q3: { label: 'acme/erp-sync', cite: 'stock sync' },
  Q4: { label: 'none' },
  Q5: { label: 'acme/erp-sync', cite: 'stock sync' },
  Q6: { label: 'acme/erp-sync', cite: 'stock sync' },
  Q7: { label: 'acme/erp-sync', cite: 'stock sync' },
  Q9: { label: 'acme/erp-sync', cite: 'stock sync' },
  K1: { label: '', kind: 'request' },
  K2: { label: '', kind: 'question' },
};

interface Call {
  model: string;
  system: string;
  prompt: string;
}

function cannedModel(calls: Call[]): LlmLike {
  return {
    async call(c) {
      calls.push(c);
      const out: unknown[] = [];
      if (/^You read incoming messages/.test(c.system)) {
        for (const blk of c.prompt.split(/\n(?=u\d+ · )/).filter((x) => /^u\d+ · /.test(x))) {
          const marker = /\b(K\d)\b/.exec(blk)?.[1];
          out.push({ unit: /^(u\d+)/.exec(blk)![1], kind: (marker && SAYS[marker]?.kind) || 'info', addressee: 'none', cue: '' });
        }
        return { text: JSON.stringify(out), costUsd: 0.01, cached: false };
      }
      for (const m of c.prompt.matchAll(/^(u\d+)[^\n]*?\]: ([^\n]*)$/gm)) {
        const marker = /\b(Q\d+)\b/.exec(m[2]!)?.[1];
        const say = (marker && SAYS[marker]) || { label: 'none' };
        out.push({ unit: m[1], label: say.label, cite: { field: 'text', span: say.cite ?? 'not in the card' } });
      }
      return { text: JSON.stringify(out), costUsd: 0.01, cached: false };
    },
  };
}

const V = () => makeHybrid({ floor: fakeFloor });
interface Run {
  v: ReturnType<typeof V>;
  state: Map<string, unknown>;
  memory: MemoryRow[];
  dir: string;
}
const newRun = (dir = fixture()): Run => ({ v: V(), state: new Map(), memory: [], dir });
const ctxOf = (r: Run, day: string, pool: Unit[], llm: LlmLike | null): DayCtx => ({ dataset: META, dir: r.dir, day, pool, memory: r.memory.slice(), state: r.state, llm, log: () => {} });
async function decide(r: Run, day: string, units: Unit[], llm: LlmLike | null, task: TaskId = 't1-item'): Promise<Map<string, Prediction>> {
  return new Map((await r.v.decide(task, units, ctxOf(r, day, units, llm))).map((p) => [p.id, p]));
}
async function answer(r: Run, day: string, rows: Omit<MemoryRow, 'task' | 'day'>[], llm: LlmLike | null, task: TaskId = 't1-item'): Promise<void> {
  r.memory.push(...rows.map((x) => ({ ...x, task, day })));
  await r.v.nightly!(task, ctxOf(r, day, [], llm));
}
const auto = (p: Prediction | undefined): boolean => !!p && p.label !== null && p.conf >= 0.95;
const decision = (p: Prediction) => ({ label: p.label, conf: p.conf, rung: p.rung, ask: p.ask });

const DAY1 = [
  item('a1', D1, 'AC-1: what is the status? Q1'),
  item('a2', D1, 'AC-2: checkout fails in the shop'),
  item('a3', D1, 'AC-3: stock sync lags behind the ERP Q3'),
  item('b1', D1, 'BT-1: crash on login'),
  item('x1', D1, 'Lunch on Friday? Q4'),
];

test('the spine decides what it proves; J judges only its residue, on the spine’s belief; questions carry J’s judgment in the spine’s client-day group', async () => {
  const calls: Call[] = [];
  const r = newRun();
  const d = await decide(r, D1, DAY1, cannedModel(calls));
  for (const id of ['a2', 'b1']) {
    assert.ok(auto(d.get(id)), `${id}: the spine’s own decision`);
    assert.equal(d.get(id)!.ask, undefined);
  }
  assert.deepEqual([d.get('a2')!.rung, d.get('b1')!.rung], ['key:AC', 'key:BT']);
  const prompts = calls.map((c) => c.prompt).join('\n');
  assert.ok(!/checkout fails|crash on login/.test(prompts), 'J never reads what the spine decided');
  assert.match(prompts, /floor guess acme\/shop \(held:key:AC, 0\.85\)/, 'the card’s weak hint is the spine’s held X');
  assert.match(prompts, /floor guess acme\/erp-sync \(sib:key:AC, 0\.60\)/, 'and its sibling guess');

  const a1 = d.get('a1')!;
  const a3 = d.get('a3')!;
  assert.deepEqual([a1.label, a1.rung], ['acme/erp-sync', 'judge:AA'], 'J’s label, J’s cell');
  assert.deepEqual([a3.label, a3.rung], ['acme/erp-sync', 'judge:AA+g']);
  for (const p of [a1, a3]) {
    assert.ok(!auto(p), 'uncalibrated cells stay under τ');
    assert.deepEqual([p.ask?.group, p.ask?.guess, p.ask?.form], [`umb:acme:${D1}`, 'acme/erp-sync', 'confirm']);
    assert.ok(p.costUsd! > 0, 'J’s spend stays on the units it judged');
    assert.match(p.why!, /^spine acme\/(shop|erp-sync)@0\.(850|600) (held|sib):key:AC · A=B acme\/erp-sync/);
  }
  const x1 = d.get('x1')!;
  assert.deepEqual([x1.label, x1.rung, x1.ask?.group, x1.ask?.guess], ['none', 'judge:AA-none', 'ticket:x1', 'none'], 'J’s case outside client-day groups');
  // value: (1 − conf) plus the spine's yield (K2a's ctx-key gain on its client-day group)
  assert.ok(a1.ask!.value! >= 1 - a1.conf - 1e-9);

  // one entry in the run's state; the spine and J each keep their own
  assert.deepEqual([...r.state.keys()], ['hybrid']);
  const st = hybridState(r);
  assert.ok(st.spine.has('k2a:trusted') && st.spine.has('keys') && st.spine.has('fake-floor'));
  assert.ok(!st.spine.has('judge:t1-item'));
  assert.ok(st.judge.has('judge:t1-item') && st.judge.has('hybrid:floor'));
  assert.ok(!st.judge.has('keys') && !st.judge.has('k2a:trusted'));
});

test('without a model the hybrid IS its spine: every decision is K2a’s', async () => {
  const r = newRun();
  const k = makeK2a({ name: 'k2a', description: 'test', guess: false, floor: fakeFloor });
  const kState = new Map<string, unknown>();
  const h = await decide(r, D1, DAY1, null);
  const kp = await k.decide('t1-item', DAY1, { ...ctxOf(r, D1, DAY1, null), state: kState });
  for (const p of kp) {
    const q = h.get(p.id)!;
    if (auto(p)) assert.deepEqual(decision(q), { label: p.label, conf: p.conf, rung: p.rung, ask: undefined });
    else assert.deepEqual([q.label, q.conf, q.rung], [p.label, p.conf, p.rung], `${p.id}: the spine’s guess`);
  }
});

test('nightly: J’s cells learn from human answers until J may decide; machine rows move nothing, even at machineWeight=1', async () => {
  const llm = cannedModel([]);
  const poisoned = newRun();
  const clean = newRun(poisoned.dir);
  const units = [...DAY1, item('a5', D1, 'AC-5: stock sync stalls Q5', 'T5'), item('a6', D1, 'AC-6: stock sync retry Q6', 'T6'), item('a7', D1, 'AC-7: stock sync queue Q7', 'T7')];
  const d1 = await decide(clean, D1, units, llm);
  await decide(poisoned, D1, units, llm);
  // the person answers the client-day question (one answer) and, separately, three sync tickets J judged AA+g
  const human: Omit<MemoryRow, 'task' | 'day'>[] = [
    { id: 'a1', label: 'acme/erp-sync', source: 'human', answer: `${D1}:umb`, predicted: d1.get('a1')!.label, conf: d1.get('a1')!.conf, rung: d1.get('a1')!.rung },
    { id: 'a3', label: 'acme/erp-sync', source: 'human', answer: `${D1}:umb`, predicted: 'acme/erp-sync', conf: d1.get('a3')!.conf, rung: 'judge:AA+g' },
    ...['a5', 'a6', 'a7'].map((id) => ({ id, label: 'acme/erp-sync', source: 'human' as const, answer: `${D1}:${id}`, predicted: 'acme/erp-sync', conf: d1.get(id)!.conf, rung: d1.get(id)!.rung })),
  ];
  // the loop's own decisions, wrong on purpose
  const machine: Omit<MemoryRow, 'task' | 'day'>[] = [
    { id: 'a2', label: 'beta/app', source: 'machine', predicted: 'beta/app', conf: 0.97, rung: 'key:AC' },
    { id: 'b1', label: 'acme/shop', source: 'machine', predicted: 'acme/shop', conf: 0.97, rung: 'key:BT' },
    { id: 'x1', label: 'acme/shop', source: 'machine', predicted: 'acme/shop', conf: 0.9, rung: 'judge:AA-none' },
  ];
  process.env.LAB_OPT_machineWeight = '1';
  try {
    await answer(clean, D1, human, llm);
    await answer(poisoned, D1, [...human, ...machine], llm);
    const day2 = [item('a9', D2, 'AC-9: stock sync broken again Q9', 'T9'), item('b2', D2, 'BT-2: push fails', 'B2'), item('x2', D2, 'BT-3: lunch again Q4', 'x1')];
    const c2 = await decide(clean, D2, day2, llm);
    const p2 = await decide(poisoned, D2, day2, llm);
    for (const u of day2) assert.deepEqual(decision(p2.get(u.id)!), decision(c2.get(u.id)!), `${u.id}: machine rows changed nothing`);
    const a9 = c2.get('a9')!;
    assert.ok(auto(a9), `three right answers on J’s AA+g cell: J decides (${a9.conf})`);
    assert.equal(a9.rung, 'judge:AA+g');
    assert.equal(a9.ask, undefined);

    const jc = judgeState({ ...ctxOf(clean, D2, [], null), state: hybridState(clean).judge }, 't1-item');
    const jp = judgeState({ ...ctxOf(poisoned, D2, [], null), state: hybridState(poisoned).judge }, 't1-item');
    assert.deepEqual(jp.cells.table(), jc.cells.table());
    assert.equal(jp.pool.size, jc.pool.size);
    assert.equal(jc.pool.size, 5, 'the precedents are the five answered units');
    const tc = hybridState(clean).spine.get('k2a:trusted') as Trusted;
    const tp = hybridState(poisoned).spine.get('k2a:trusted') as Trusted;
    assert.deepEqual([...tp.ctxKeys.learner.tables.keys()], [...tc.ctxKeys.learner.tables.keys()]);
    assert.deepEqual(tp.client.all(), tc.client.all());

    // the same rows DO poison a bare K2a at machineWeight=1: the filter is what keeps them out
    const bare = makeK2a({ name: 'k2a', description: 'test', guess: false, floor: fakeFloor });
    const bs = new Map<string, unknown>();
    const bctx = (day: string, memory: MemoryRow[]): DayCtx => ({ dataset: META, dir: clean.dir, day, pool: units, memory, state: bs, llm: null, log: () => {} });
    await bare.decide('t1-item', units, bctx(D1, []));
    await bare.nightly!('t1-item', bctx(D1, machine.map((x) => ({ ...x, task: 't1-item' as const, day: D1 }))));
    const bt = bs.get('k2a:trusted') as Trusted;
    assert.ok(bt.client.all().length === 0 && (bs.get('keys') as { learner: { tables: Map<string, unknown> } }).learner.tables.size > 0, 'K counted the machine rows');
  } finally {
    delete process.env.LAB_OPT_machineWeight;
  }
});

test('t4-kind: J judges the spine’s residue; t2/t3/t4-addressee are the spine alone (no model call)', async () => {
  const calls: Call[] = [];
  const r = newRun();
  const units = [item('k1', D1, 'Could you send the invoice K1'), item('k2', D1, 'When is the release K2'), item('k3', D1, 'Deploy finished', 'k3', { isBot: true, author: 'CIBot' })];
  const d = await decide(r, D1, units, cannedModel(calls), 't4-kind');
  assert.deepEqual([d.get('k3')!.label, d.get('k3')!.rung, d.get('k3')!.ask], ['noise', 'sender:bot', undefined], 'the spine’s noise stands');
  assert.deepEqual([d.get('k1')!.label, d.get('k1')!.rung, d.get('k1')!.ask?.guess], ['request', 'judge:AA', 'request']);
  assert.deepEqual([d.get('k2')!.label, d.get('k2')!.ask?.group], ['question', 'thread:k2']);
  assert.equal(calls.length, 2, 'two passes over the residue');
  assert.ok(!calls.some((c) => c.prompt.includes('Deploy finished')));
  const quiet: Call[] = [];
  const mentions: MentionUnit[] = [{ id: 'm1', day: D1, raw: 'Lena O.', field: 'author', source: 'youtrack', ref: 'k1', seen: 3, context: {}, production: null }];
  for (const [task, us] of [['t2-dedup', units], ['t3-identity', mentions], ['t4-addressee', units]] as [TaskId, Unit[]][]) {
    const x = newRun();
    const ps = await x.v.decide(task, us, ctxOf(x, D1, us, cannedModel(quiet)));
    assert.equal(ps.length, us.length);
    assert.ok(!hybridState(x).judge.has(`judge:${task}`), `${task}: J never ran`);
  }
  assert.equal(quiet.length, 0);
});

test('the runner: memory loop (the machine’s own decisions as rows, machineWeight=1) replays exactly like memory none', async () => {
  const dir = fixture();
  saveMeta(dir, { ...META, counts: { item: 9 } });
  const units = [
    ...DAY1,
    item('a5', D2, 'AC-5: stock sync stalls Q5', 'T5'),
    item('c1', D2, 'AC-4: checkout broken in the shop'),
    item('x2', D2, 'BT-3: lunch again Q4', 'x1'),
    item('a9', D3, 'AC-9: stock sync broken again Q9', 'T9'),
  ];
  const gold: Record<string, string> = { a1: 'acme/shop', a2: 'acme/shop', a3: 'acme/erp-sync', b1: 'beta/app', x1: 'none', a5: 'acme/erp-sync', c1: 'acme/shop', x2: 'none', a9: 'acme/erp-sync' };
  writeJsonl(join(dir, 'units', 'item.jsonl'), units);
  writeJsonl(
    join(dir, 'gold', 't1-item.jsonl'),
    units.map((u) => ({ id: u.id, task: 't1-item', label: gold[u.id], tier: 'synthetic' })),
  );
  const ds = loadDataset(dir);
  const run = (memory: 'none' | 'loop') => runTask(ds, V(), 't1-item', { mode: 'replay', memory, questionsPerDay: 2, auditShare: 0.5, llm: cannedModel([]), runName: `hybrid-${memory}`, log: () => {}, labDir: dir });
  process.env.LAB_OPT_machineWeight = '1';
  try {
    const none = await run('none');
    const loop = await run('loop');
    assert.deepEqual(loop.predictions.map(decision), none.predictions.map(decision));
    assert.deepEqual(loop.answered, none.answered);
    assert.deepEqual(loop.audited, none.audited);
    assert.ok(none.answered.length > 0 && none.perDay.some((d) => d.decided > 0));
  } finally {
    delete process.env.LAB_OPT_machineWeight;
  }
});
