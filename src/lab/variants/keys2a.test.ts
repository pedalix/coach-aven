// K2a end to end over a fictional tenant: Acme Bikes runs an online shop and an ERP sync (siblings; the `AC` tracker
// prefix routes to the shop only), Beta runs one app (`BT` → the app, no siblings). The floor is a stand-in for stage 0
// with stage 0's own rung calibration (stage0/calibrate.ts); the registry facts come from the fixture's tenant/ files.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadDataset, saveMeta, writeJsonl } from '../dataset.js';
import { runTask } from '../run.js';
import type { DatasetMeta, DayCtx, ItemUnit, LlmLike, MemoryRow, Prediction, TaskId, Unit } from '../types.js';
import { makeK2a } from './keys2a.js';
import { Calibration, type Said } from './stage0/calibrate.js';
import type { Floor, Stage0 } from './stage0/index.js';
import type { Trusted } from './keys2a/floor.js';

const D1 = '2026-01-05';
const D2 = '2026-01-06';
const D3 = '2026-01-07';

const META: DatasetMeta = {
  name: 'k2a-bench',
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
  const dir = mkdtempSync(join(tmpdir(), 'k2a-'));
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
  writeFileSync(join(ann, 'rules.json'), JSON.stringify([{ id: 'r-ext', when: { container: '#ext-acme' }, then: { initiative: 'acme/shop' } }]));
  writeFileSync(join(ann, 'attribution.json'), JSON.stringify({ subject: 'owner', admin: { acme: 'acme/admin' } }));
  return dir;
}

const item = (id: string, day: string, text: string, thread = id): ItemUnit => ({
  id,
  day,
  ts: `${day}T09:00:00Z`,
  type: 'comment',
  source: 'youtrack',
  account: 'agency',
  container: null,
  thread,
  author: 'Mara Keller',
  authorPerson: 'owner',
  isBot: false,
  participants: [],
  toPersons: [],
  subject: null,
  text,
  keys: [...text.matchAll(/\b[A-Z]{2}-\d+\b/g)].map((m) => m[0]),
});

// A stage-0 stand-in: the AC prefix routes to the shop, BT to the app (.97, like stage 0's text-key rung), with stage 0's
// rung-instance calibration. One per run (ctx.state), like the real floor.
function fakeFloor(ctx: DayCtx): Stage0 {
  const hit = ctx.state.get('fake-floor') as Stage0 | undefined;
  if (hit) return hit;
  const calib = new Calibration();
  const said = new Map<string, Said>();
  const route = (u: ItemUnit): Floor => {
    if (u.container === '#ext-acme') {
      // the channel rule (stage 0 rung 5, .95 for a person's message)
      said.set(u.id, { instance: 'rule:r-ext', label: 'acme/shop' });
      return { label: 'acme/shop', conf: calib.mean('rule:r-ext', 0.95), prior: 0.95, rung: 'rule:r-ext', candidates: ['acme/shop'], hint: 'rule r-ext', case: `thread:${u.thread}` };
    }
    const k = u.keys.find((x) => /^(AC|BT)-/.test(x))?.slice(0, 2);
    const label = k === 'AC' ? 'acme/shop' : k === 'BT' ? 'beta/app' : null;
    said.set(u.id, { instance: label ? `key:${k}` : 'abstain', label });
    return label
      ? { label, conf: calib.mean(`key:${k}`, 0.97), prior: 0.97, rung: `key:${k}`, candidates: [label], hint: `key ${k}`, case: `ticket:${u.thread}` }
      : { label: null, conf: 0, rung: 'abstain', candidates: [], hint: '', case: `ticket:${u.thread}` };
  };
  const memo = new Map<string, Floor>();
  const fl: Stage0 = {
    fragment: () => {
      throw new Error('no fragments here');
    },
    item: (u) => {
      const f = memo.get(u.id) ?? route(u);
      memo.set(u.id, f);
      return { ...f, senderClass: 'human', family: u.id, hosts: [], apps: [] };
    },
    mention: (u) => ({ label: null, conf: 0, rung: 'abstain', candidates: [], hint: '', case: u.id }),
    kind: (u) => ({ label: null, conf: 0, rung: 'abstain', candidates: [], hint: '', case: u.id }),
    addressee: (u) => ({ label: null, conf: 0, rung: 'abstain', candidates: [], hint: '', case: u.id }),
    dedup: (units) => new Map(units.map((u) => [u.id, { cluster: u.id, conf: 1 }])),
    labelSpace: () => [...META.labelSpace.initiatives, 'none', 'unregistered'],
    cards: () => [],
    calibrate: (rows, decided) => calib.update(rows, (id) => said.get(id), decided),
    said: (id) => said.get(id),
  };
  ctx.state.set('fake-floor', fl);
  return fl;
}

const V = (guess = false) => makeK2a({ name: 'k2a', description: 'test', guess, floor: fakeFloor });

interface Run {
  v: ReturnType<typeof V>;
  state: Map<string, unknown>;
  memory: MemoryRow[];
  dir: string;
}
const newRun = (guess = false): Run => ({ v: V(guess), state: new Map(), memory: [], dir: fixture() });
const ctxOf = (r: Run, day: string, pool: Unit[], llm: LlmLike | null = null): DayCtx => ({ dataset: META, dir: r.dir, day, pool, memory: r.memory.slice(), state: r.state, llm, log: () => {} });

async function decide(r: Run, day: string, units: Unit[], llm: LlmLike | null = null, task: TaskId = 't1-item'): Promise<Map<string, Prediction>> {
  return new Map((await r.v.decide(task, units, ctxOf(r, day, units, llm))).map((p) => [p.id, p]));
}
async function answer(r: Run, day: string, rows: Omit<MemoryRow, 'task' | 'day'>[], task: TaskId = 't1-item'): Promise<void> {
  r.memory.push(...rows.map((x) => ({ ...x, task, day })));
  await r.v.nightly!(task, ctxOf(r, day, []));
}
const auto = (p: Prediction | undefined): boolean => !!p && p.label !== null && p.conf >= 0.95;

const DAY1 = [
  item('a1', D1, 'AC-1: what is the status?'),
  item('a2', D1, 'AC-2: checkout fails in the shop'),
  item('a3', D1, 'AC-3: stock sync lags behind the ERP'),
  item('b1', D1, 'BT-1: crash on login'),
];

test('day 1: a sibling-having route decides X only on an own cue; else a held confirm or a sibling guess, asked per client-day', async () => {
  const d = await decide(newRun(), D1, DAY1);
  const a2 = d.get('a2')!;
  assert.deepEqual([a2.label, a2.conf, a2.rung], ['acme/shop', 0.97, 'key:AC'], 'an own cue (checkout, shop) and no sibling cue: X at the rung confidence');
  assert.ok(auto(d.get('b1')) && d.get('b1')!.rung === 'key:BT', 'no siblings: the route is the initiative');
  const a1 = d.get('a1')!;
  assert.deepEqual([a1.label, a1.conf, a1.rung], ['acme/shop', 0.85, 'held:key:AC'], 'no cue: X held at .85');
  const a3 = d.get('a3')!;
  assert.deepEqual([a3.label, a3.conf, a3.rung], ['acme/erp-sync', 0.6, 'sib:key:AC'], 'a sibling-only cue: the sibling at .60');
  for (const p of [a1, a3]) {
    assert.equal(p.ask?.group, `umb:acme:${D1}`, 'one question for the client’s day');
    assert.equal(p.ask?.guess, 'acme/shop', 'the surest member’s guess');
    assert.equal(p.ask?.form, 'confirm');
    assert.match(p.why ?? '', /client=acme@0\.970/);
  }
  assert.equal(a2.ask, undefined, 'decided units are never asked');
});

test('the loop: a mixed answer demotes the rung instance (initiative), keeps the client, contradicts ctx:key:AC', async () => {
  const r = newRun();
  const d1 = await decide(r, D1, DAY1);
  const group = d1.get('a1')!.ask!.group!;
  await answer(r, D1, [
    { id: 'a1', label: 'acme/shop', source: 'human', answer: `${D1}:${group}`, predicted: 'acme/shop', conf: 0.85, rung: 'held:key:AC' },
    { id: 'a3', label: 'acme/erp-sync', source: 'human', answer: `${D1}:${group}`, predicted: 'acme/erp-sync', conf: 0.6, rung: 'sib:key:AC' },
  ]);
  const t = r.state.get('k2a:trusted') as Trusted;
  assert.equal(t.ctxKeys.learner.contradicted('ctx=key:AC'), true, 'one answer, two labels: the ctx key is contradicted');
  const d2 = await decide(r, D2, [item('c1', D2, 'AC-4: checkout button misaligned in the shop'), item('c2', D2, 'AC-5: any news?'), item('c3', D2, 'BT-2: push fails')]);
  const c1 = d2.get('c1')!;
  assert.equal(auto(c1), false, 'key:AC was wrong once on an ordinary answer: it no longer decides, own cue or not');
  assert.equal(c1.label, 'acme/shop');
  assert.ok(c1.conf < 0.95 && c1.conf > 0.9, `the calibrated rung confidence, ${c1.conf}`);
  assert.ok(auto(d2.get('c3')), 'other rung instances are untouched');
  // the client question was answered right (both labels are Acme's): the client stays decided, so both are asked together
  assert.equal(d2.get('c1')!.ask?.group, `umb:acme:${D2}`);
  assert.equal(d2.get('c2')!.ask?.group, `umb:acme:${D2}`);
  assert.match(c1.why ?? '', /client=acme@0\.97/);
});

test('K’s own earned keys still decide below a held floor (a thread answered once)', async () => {
  const r = newRun();
  const d1 = await decide(r, D1, [item('a1', D1, 'AC-1: what is the status?', 'T-1')]);
  await answer(r, D1, [{ id: 'a1', label: 'acme/erp-sync', source: 'human', answer: `${D1}:${d1.get('a1')!.ask!.group}` }]);
  const d2 = await decide(r, D2, [item('a9', D2, 'AC-1: still lagging?', 'T-1')]);
  const p = d2.get('a9')!;
  assert.ok(auto(p));
  assert.deepEqual([p.label, p.rung], ['acme/erp-sync', 'earned:thread']);
});

test('machine rows move nothing: not the rung, not the client, not the ctx key', async () => {
  const r = newRun();
  await decide(r, D1, DAY1);
  await answer(r, D1, [
    { id: 'a1', label: 'acme/erp-sync', source: 'machine' },
    { id: 'a2', label: 'beta/app', source: 'machine' },
  ]);
  const t = r.state.get('k2a:trusted') as Trusted;
  assert.equal(t.ctxKeys.learner.tables.size, 0);
  assert.equal(t.client.all().length, 0);
  const d2 = await decide(r, D2, [item('c1', D2, 'AC-4: checkout broken in the shop')]);
  assert.ok(auto(d2.get('c1')), 'the floor’s calibration ignored them too');
});

test('K+g: one call guesses the groups actually asked (the client-day included); a guess never decides', async () => {
  const calls: { system: string; prompt: string; model: string }[] = [];
  const stub: LlmLike = {
    call: async (c) => {
      calls.push(c);
      const tag = /(g\d+) \(\d+ records?, shared key: client acme, one day\)/.exec(c.prompt)?.[1];
      return { text: JSON.stringify(tag ? [{ group: tag, guess: 'acme/erp-sync', cite: 'stock sync' }] : []), costUsd: 0.001, cached: false };
    },
  };
  const plain = await decide(newRun(), D1, DAY1);
  const g = await decide(newRun(true), D1, DAY1, stub);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.model, 'haiku');
  assert.ok(!/\b(?:a1|a2|a3|b1)\b/.test(calls[0]!.prompt), 'the model sees tags, never store ids');
  for (const [id, p] of g) {
    const k = plain.get(id)!;
    assert.deepEqual([p.label, p.conf, p.rung], [k.label, k.conf, k.rung], 'the guess changes no decision');
  }
  assert.equal(g.get('a1')!.ask?.guess, 'acme/erp-sync');
  assert.equal(g.get('a3')!.ask?.form, 'confirm');
  const none = await decide(newRun(true), D1, DAY1, null);
  assert.equal(none.get('a1')!.ask?.guess, 'acme/shop', 'without a model the group keeps its own guess');
});

test('the runner: one answer resolves the client-day; the next day’s own-cue unit is a question after the demotion', async () => {
  const dir = fixture();
  saveMeta(dir, { ...META, counts: { item: 7 } });
  const units = [...DAY1, item('c1', D2, 'AC-4: checkout broken in the shop'), item('c2', D2, 'AC-5: any news?'), item('e1', D3, 'BT-3: ok')];
  const gold: Record<string, string> = { a1: 'acme/shop', a2: 'acme/shop', a3: 'acme/erp-sync', b1: 'beta/app', c1: 'acme/shop', c2: 'acme/erp-sync', e1: 'beta/app' };
  writeJsonl(join(dir, 'units', 'item.jsonl'), units);
  writeJsonl(
    join(dir, 'gold', 't1-item.jsonl'),
    units.map((u) => ({ id: u.id, task: 't1-item', label: gold[u.id], tier: 'synthetic' })),
  );
  const res = await runTask(loadDataset(dir), V(), 't1-item', { mode: 'replay', memory: 'none', questionsPerDay: 2, auditShare: 0, llm: null, runName: 'k2a-test', log: () => {}, labDir: dir });
  const byId = new Map(res.predictions.map((p) => [p.id, p]));
  assert.deepEqual(res.answered.slice(0, 2).sort(), ['a1', 'a3'], 'day 1: the client-day is one question');
  assert.equal(res.perDay[0]!.asked, 1);
  assert.equal(res.perDay[0]!.effort, 1.5, 'confirm with a right guess (.5) + one more initiative (1)');
  assert.equal(auto(byId.get('c1')), false);
  assert.ok(res.answered.includes('c1') && res.answered.includes('c2'), 'day 2: asked together and answered');
  assert.ok(auto(byId.get('e1')));
});

test('every other task is K+g as is', async () => {
  const r = newRun();
  assert.deepEqual(r.v.tasks, ['t1-fragment', 't1-item', 't2-dedup', 't3-identity', 't4-kind', 't4-addressee']);
  const d = await decide(r, D1, DAY1, null, 't2-dedup');
  assert.deepEqual([d.get('a1')!.label, d.get('a1')!.rung], ['a1', 'floor:dedup']);
  assert.equal(r.state.has('k2a:trusted'), false, 'the trusted floor is built for t1 only');
});

test('the own-route ablation: under a channel rule, the shop’s key prefix corroborates the shop only while ownRouteCues is on', async () => {
  const unit = { ...item('r1', D1, 'AC-7: any news?'), container: '#ext-acme', type: 'message' as const };
  const on = (await decide(newRun(), D1, [unit])).get('r1')!;
  assert.deepEqual([on.label, on.conf, on.rung], ['acme/shop', 0.95, 'rule:r-ext'], 'the spec: a key prefix is a cue of X');
  assert.match(on.why ?? '', /own cue key:AC/);
  const prev = process.env.LAB_OPT_ownRouteCues;
  process.env.LAB_OPT_ownRouteCues = 'off';
  try {
    const off = (await decide(newRun(), D1, [unit])).get('r1')!;
    assert.deepEqual([off.label, off.conf, off.rung], ['acme/shop', 0.85, 'held:rule:r-ext'], 'a route does not corroborate a route');
  } finally {
    if (prev === undefined) delete process.env.LAB_OPT_ownRouteCues;
    else process.env.LAB_OPT_ownRouteCues = prev;
  }
});
