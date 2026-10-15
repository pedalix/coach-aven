import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { caseKeyOf } from '../cases.js';
import { loadDataset, saveMeta, writeJsonl } from '../dataset.js';
import { runTask } from '../run.js';
import type { DatasetMeta, DayCtx, ItemUnit, LlmLike, MemoryRow, MentionUnit, Prediction, TaskId, Unit, Variant } from '../types.js';
import { makeKeys } from './keys.js';
import type { Stage0 } from './stage0/index.js';

// A fictional agency: an uptime monitor posting about the shop's host, people chatting in #acme-web, and mentions.
const D1 = '2026-01-05';
const D2 = '2026-01-06';
const D3 = '2026-01-07';

const META: DatasetMeta = {
  name: 'keys-bench',
  kind: 'synthetic',
  tenant: 'acme-agency',
  tz: 'UTC',
  since: D1,
  until: D3,
  subject: 'owner',
  createdAt: '2026-01-08T00:00:00Z',
  sourceStore: 'test fixture',
  labelSpace: { initiatives: ['acme/shop', 'acme/web'], umbrellas: { 'acme/shop': 'acme', 'acme/web': 'acme' }, people: ['mara', 'owner'] },
  counts: {},
};

const alert = (id: string, day: string, up = false): ItemUnit => ({
  id,
  day,
  ts: `${day}T08:00:00Z`,
  type: 'message',
  source: 'slack',
  account: 'T0',
  container: '#ops-alerts',
  thread: `slack:T0/C9/${id}`,
  author: 'Uptime Watch',
  authorPerson: null,
  isBot: true,
  participants: [],
  toPersons: [],
  subject: null,
  text: `${up ? '✅ UP' : '🚨 DOWN'} https://shop.acme.example is ${up ? 'back' : 'not responding'}`,
  keys: [],
});

const chat = (id: string, day: string, text = 'pushed the new header'): ItemUnit => ({
  ...alert(id, day),
  container: '#acme-web',
  author: 'Mara Quill',
  authorPerson: 'mara',
  isBot: false,
  text,
});

const mention = (id: string, day: string, raw: string): MentionUnit => ({ id, day, raw, field: 'attendee', source: 'gmeet', ref: `meeting:${id}`, seen: 1, context: {}, production: null });

// A floor that knows nothing (the stub's shape): every unit falls through to the keys.
function blankFloor(): Stage0 {
  const none = (task: TaskId, u: Unit) => ({ label: null, conf: 0, rung: 'abstain', candidates: [], hint: '', case: caseKeyOf(task, u) });
  return {
    fragment: (u) => ({ ...none('t1-fragment', u), participants: u.participants, cowork: [] }),
    item: (u) => ({ ...none('t1-item', u), senderClass: u.isBot ? 'bot' : 'human', family: u.id, hosts: [], apps: [] }),
    mention: (u) => none('t3-identity', u),
    kind: (u) => none('t4-kind', u),
    addressee: (u) => none('t4-addressee', u),
    dedup: (units) => new Map(units.map((u) => [u.id, { cluster: `c-${u.id}`, conf: 0.99 }])),
    labelSpace: () => ['acme/shop', 'acme/web', 'none', 'unregistered'],
    cards: () => [
      { id: 'acme/shop', umbrella: 'acme', name: 'Shop', done: false, cues: ['shop.acme.example'], people: [] },
      { id: 'acme/web', umbrella: 'acme', name: 'Website', done: false, cues: ['#acme-web'], people: ['Mara Quill'] },
    ],
    calibrate: () => {},
  };
}

const K = (guess = false): Variant => makeKeys({ name: guess ? 'keys+g' : 'keys', description: 'test', guess, floor: blankFloor });

interface Run {
  v: Variant;
  state: Map<string, unknown>;
  memory: MemoryRow[];
  dir: string;
}
const newRun = (v: Variant): Run => ({ v, state: new Map(), memory: [], dir: mkdtempSync(join(tmpdir(), 'keys-')) });

function ctxOf(r: Run, day: string, pool: Unit[], llm: LlmLike | null = null): DayCtx {
  return { dataset: META, dir: r.dir, day, pool, memory: r.memory.slice(), state: r.state, llm, log: () => {} };
}

async function decide(r: Run, task: TaskId, day: string, units: Unit[], llm: LlmLike | null = null): Promise<Map<string, Prediction>> {
  const got = await r.v.decide(task, units, ctxOf(r, day, units, llm));
  return new Map(got.map((p) => [p.id, p]));
}

async function answer(r: Run, task: TaskId, day: string, rows: Omit<MemoryRow, 'task' | 'day'>[]): Promise<void> {
  r.memory.push(...rows.map((x) => ({ ...x, task, day })));
  await r.v.nightly!(task, ctxOf(r, day, []));
}

const auto = (p: Prediction | undefined): boolean => !!p && p.label !== null && p.conf >= 0.95;

test('replay: one answer about an alert family decides the family from the next day on', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'keys-ds-'));
  saveMeta(dir, { ...META, counts: { item: 13 } });
  const units = [
    ...['a1', 'a2', 'a3', 'a4', 'a5'].map((id) => alert(id, D1)),
    ...['b1', 'b2', 'b3', 'b4', 'b5'].map((id, i) => alert(id, D2, i % 2 === 1)),
    ...['c1', 'c2', 'c3'].map((id) => alert(id, D3)),
  ];
  writeJsonl(join(dir, 'units', 'item.jsonl'), units);
  writeJsonl(
    join(dir, 'gold', 't1-item.jsonl'),
    units.map((u) => ({ id: u.id, task: 't1-item', label: 'acme/shop', tier: 'synthetic' })),
  );
  const ds = loadDataset(dir);
  const res = await runTask(ds, K(), 't1-item', { mode: 'replay', memory: 'none', questionsPerDay: 1, auditShare: 0, llm: null, runName: 'keys-test', log: () => {}, labDir: dir });
  const byId = new Map(res.predictions.map((p) => [p.id, p]));
  assert.deepEqual(res.answered.sort(), ['a1', 'a2', 'a3', 'a4', 'a5'], 'day 1: the five alerts are ONE question (their family)');
  assert.equal(res.perDay[0]!.asked, 1);
  for (const id of ['b1', 'b2', 'b3', 'b4', 'b5', 'c1', 'c2', 'c3']) {
    assert.ok(auto(byId.get(id)), `${id} is decided by the earned key`);
    assert.equal(byId.get(id)!.label, 'acme/shop');
  }
  // The firing alerts share the answered family; a resolve is another template, and its host carries the answer over.
  assert.deepEqual(['b1', 'b2', 'b3'].map((id) => byId.get(id)!.rung), ['earned:family', 'earned:host', 'earned:family']);
  assert.deepEqual(
    res.perDay.map((d) => [d.decided, d.correctDecided, d.questions]),
    [
      [0, 0, 5],
      [5, 5, 0],
      [3, 3, 0],
    ],
  );
});

test('a contradiction stops the key; the failed trial demotes its type', async () => {
  const r = newRun(K());
  const d1 = await decide(r, 't1-item', D1, [alert('a1', D1), alert('a2', D1)]);
  assert.equal(d1.get('a1')!.ask?.group, d1.get('a2')!.ask?.group, 'one family, one question');
  await answer(r, 't1-item', D1, [
    { id: 'a1', label: 'acme/shop', source: 'human', answer: 'q1' },
    { id: 'a2', label: 'acme/shop', source: 'human', answer: 'q1' },
  ]);
  const d2 = await decide(r, 't1-item', D2, [alert('b1', D2), alert('b2', D2)]);
  assert.ok(auto(d2.get('b1')) && auto(d2.get('b2')));
  // An audit finds b2 belongs elsewhere: the family (and host) keys now hold two labels.
  await answer(r, 't1-item', D2, [{ id: 'b2', label: 'acme/web', source: 'human', audit: true, answer: 'audit:b2', predicted: 'acme/shop' }]);
  const d3 = await decide(r, 't1-item', D3, [alert('c1', D3)]);
  assert.equal(auto(d3.get('c1')), false);
  assert.ok(!d3.get('c1')!.rung.startsWith('earned:'));
  assert.ok(d3.get('c1')!.ask, 'it is a question again');
});

test('machine rows are not evidence at machineWeight 0 — the poisoning ablation can make them so', async () => {
  const rows: Omit<MemoryRow, 'task' | 'day'>[] = [
    { id: 'a1', label: 'acme/shop', source: 'machine' },
    { id: 'a2', label: 'acme/shop', source: 'machine' },
  ];
  const clean = newRun(K());
  await decide(clean, 't1-item', D1, [alert('a1', D1), alert('a2', D1)]);
  await answer(clean, 't1-item', D1, rows);
  const d2 = await decide(clean, 't1-item', D2, [alert('b1', D2)]);
  assert.equal(d2.get('b1')!.label, null, 'the pipeline’s own decisions taught nothing');
  const prev = process.env.LAB_OPT_machineWeight;
  process.env.LAB_OPT_machineWeight = '1';
  try {
    const poisoned = newRun(K());
    await decide(poisoned, 't1-item', D1, [alert('a1', D1), alert('a2', D1)]);
    await answer(poisoned, 't1-item', D1, rows);
    const p2 = await decide(poisoned, 't1-item', D2, [alert('b1', D2)]);
    assert.ok(auto(p2.get('b1')), 'with machineWeight=1 the loop learns from itself');
  } finally {
    if (prev === undefined) delete process.env.LAB_OPT_machineWeight;
    else process.env.LAB_OPT_machineWeight = prev;
  }
});

test('one answer covering many units counts once (a channel needs two answers)', async () => {
  const r = newRun(K());
  const day1 = ['m1', 'm2', 'm3', 'm4', 'm5', 'm6'].map((id) => chat(id, D1));
  await decide(r, 't1-item', D1, day1);
  await answer(
    r,
    't1-item',
    D1,
    day1.map((u) => ({ id: u.id, label: 'acme/web', source: 'human' as const, answer: 'q-chan-1' })),
  );
  const d2 = await decide(r, 't1-item', D2, [chat('n1', D2)]);
  assert.notEqual(d2.get('n1')!.rung, 'guess:container', 'six units of one answer are one observation: k = 2 not met');
  await answer(r, 't1-item', D2, [{ id: 'n1', label: 'acme/web', source: 'human', answer: 'q-chan-2' }]);
  const d3 = await decide(r, 't1-item', D3, [chat('o1', D3)]);
  const p = d3.get('o1')!;
  assert.equal(p.rung, 'guess:container', 'two independent answers: the channel predicts');
  assert.equal(p.label, 'acme/web');
  assert.ok(p.conf < 0.95, '…but a channel is only .80 homophilous: still a question');
  assert.equal(p.ask?.guess, 'acme/web');
});

test('K+g: one model call pre-fills confirm guesses for the top groups and never decides', async () => {
  const calls: { system: string; prompt: string; model: string }[] = [];
  const stub: LlmLike = {
    call: async (c) => {
      calls.push(c);
      return { text: '```json\n[{"group":"g1","guess":"acme/web","cite":"pushed the new header"},{"group":"g9","guess":"acme/shop"},{"group":"g2","guess":"not-in-the-list"}]\n```', costUsd: 0.001, cached: false };
    },
  };
  const day1 = [...['m1', 'm2'].map((id) => chat(id, D1)), alert('a1', D1)];
  const plain = await decide(newRun(K()), 't1-item', D1, day1);
  const r = newRun(K(true));
  const g = await decide(r, 't1-item', D1, day1, stub);
  assert.equal(calls.length, 1, 'one call for the day');
  assert.equal(calls[0]!.model, 'haiku');
  for (const id of ['m1', 'm2', 'a1']) assert.ok(!calls[0]!.prompt.includes(id), 'the model sees tags, never store ids');
  for (const [id, p] of g) {
    const k = plain.get(id)!;
    assert.deepEqual([p.label, p.conf, p.rung], [k.label, k.conf, k.rung], 'the guess changes no decision');
    assert.equal(p.ask?.group, k.ask?.group);
  }
  const confirmed = [...g.values()].filter((p) => p.ask?.form === 'confirm');
  assert.ok(confirmed.length >= 1);
  assert.ok(confirmed.every((p) => p.ask?.guess === 'acme/web'), 'only a valid guess for a known tag is used');
  assert.ok([...g.values()].filter((p) => p.ask?.form !== 'confirm').every((p) => p.ask?.form === 'choose'));
  // The guess is never evidence: the person says acme/shop, and that is what the key learns.
  const top = confirmed[0]!;
  const members = [...g.values()].filter((p) => p.ask?.group === top.ask?.group);
  await answer(
    r,
    't1-item',
    D1,
    members.map((p) => ({ id: p.id, label: 'acme/shop', source: 'human' as const, answer: 'q1', predicted: p.ask?.guess ?? null })),
  );
  // Without a model K+g is K.
  const noModel = await decide(newRun(K(true)), 't1-item', D1, day1, null);
  assert.ok([...noModel.values()].every((p) => !p.ask || p.ask.form === 'choose'));
  const learned = (r.state.get('keys') as { learner: { tables: Map<string, { labels: Map<string, number> }> } }).learner.tables;
  assert.ok(learned.size > 0);
  for (const e of learned.values()) assert.deepEqual([...e.labels.keys()], ['acme/shop']);
});

test('t3: the form memo — an answered form resolves its next occurrences', async () => {
  const r = newRun(K());
  const d1 = await decide(r, 't3-identity', D1, [mention('x1', D1, 'Mara Quill'), mention('x2', D1, 'MARA  QUILL')]);
  assert.equal(d1.get('x1')!.ask?.group, d1.get('x2')!.ask?.group, 'one form, one question');
  await answer(r, 't3-identity', D1, [{ id: 'x1', label: 'mara', source: 'human', answer: 'form-q' }]);
  const d2 = await decide(r, 't3-identity', D2, [mention('y1', D2, 'Mára Quill'), mention('y2', D2, 'Tobi Lenz')]);
  assert.ok(auto(d2.get('y1')));
  assert.equal(d2.get('y1')!.label, 'mara');
  assert.equal(d2.get('y1')!.rung, 'earned:form');
  assert.equal(d2.get('y2')!.label, null);
});

test('t2-dedup is the floor’s', async () => {
  const d = await decide(newRun(K()), 't2-dedup', D1, [alert('a1', D1)]);
  assert.deepEqual([d.get('a1')!.label, d.get('a1')!.conf, d.get('a1')!.rung], ['c-a1', 0.99, 'floor:dedup']);
});
