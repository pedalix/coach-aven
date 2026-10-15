import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { caseKeyOf } from '../cases.js';
import { loadDataset, saveMeta, writeJsonl } from '../dataset.js';
import { runTask } from '../run.js';
import type { DatasetMeta, DayCtx, FragmentUnit, ItemUnit, LlmLike, MemoryRow, Prediction, TaskId, Unit, Variant } from '../types.js';
import { makeKeys } from './keys.js';
import { makeK2b, structural } from './keys2b.js';
import type { Stage0 } from './stage0/index.js';

// A fictional agency: the client Nordwind has a shop and a stock bridge that share one tracker prefix (NW → the shop in
// the registry), the in-house booking product has its own (BK). The floor routes by prefix; the content tells the shop
// and the bridge apart.
const D1 = '2026-01-05';
const D2 = '2026-01-06';

const META: DatasetMeta = {
  name: 'k2b-bench',
  kind: 'synthetic',
  tenant: 'fjord-agency',
  tz: 'UTC',
  since: D1,
  until: D2,
  subject: 'owner',
  createdAt: '2026-01-07T00:00:00Z',
  sourceStore: 'test fixture',
  labelSpace: {
    initiatives: ['nordwind/shop', 'nordwind/stock-sync', 'nordwind/admin', 'inhouse/booker', 'inhouse/booker-desk'],
    umbrellas: { 'nordwind/shop': 'nordwind', 'nordwind/stock-sync': 'nordwind', 'nordwind/admin': 'nordwind', 'inhouse/booker': 'inhouse', 'inhouse/booker-desk': 'inhouse' },
    people: ['pia', 'owner'],
  },
  counts: {},
};

const CARDS = [
  { id: 'nordwind/shop', umbrella: 'nordwind', name: 'Online shop', done: false, cues: ['NW-', '#ext-nordwind'], people: [] },
  { id: 'nordwind/stock-sync', umbrella: 'nordwind', name: 'Stock bridge to the ERP', done: false, cues: ['stock-bridge'], people: [] },
  { id: 'nordwind/admin', umbrella: 'nordwind', name: 'Nordwind admin (invoices)', done: false, cues: [], people: [] },
  { id: 'inhouse/booker', umbrella: 'inhouse', name: 'Booking product', done: false, cues: ['BK-'], people: [] },
  { id: 'inhouse/booker-desk', umbrella: 'inhouse', name: 'Booking customer desk', done: false, cues: [], people: [] },
];

const comment = (id: string, day: string, key: string, text: string): ItemUnit => ({
  id,
  day,
  ts: `${day}T09:${String(id.length + text.length).padStart(2, '0').slice(-2)}:00Z`,
  type: 'comment',
  source: 'youtrack',
  account: 'yt',
  container: key.split('-')[0]!,
  thread: `youtrack:yt:${key}`,
  author: 'Pia Lund',
  authorPerson: 'pia',
  isBot: false,
  participants: [],
  toPersons: [],
  subject: `${key} ticket`,
  text: `${key}: ${text}`,
  keys: [key],
});

const chat = (id: string, day: string, thread: string, text: string): ItemUnit => ({
  ...comment(id, day, 'XX-1', text),
  type: 'message',
  source: 'slack',
  container: '#random',
  thread,
  subject: null,
  text,
  keys: [],
});

interface FakeFloor extends Stage0 {
  rows: MemoryRow[];
  decided: Map<string, string>;
}

// The floor routes by tracker prefix at .97; once a person contradicts an instance it drops to .924 (§2.5, one wrong answer).
function fakeFloor(): FakeFloor {
  const wrong = new Set<string>();
  const rows: MemoryRow[] = [];
  const decided = new Map<string, string>();
  const route = (u: ItemUnit): { label: string; rung: string } | null => {
    const k = u.keys.map((x) => /^([A-Z]+)-\d+$/.exec(x)?.[1]).find(Boolean);
    if (k === 'NW') return { label: 'nordwind/shop', rung: 'key:NW' };
    if (k === 'BK') return { label: 'inhouse/booker', rung: 'key:BK' };
    return null;
  };
  const blank = (task: TaskId, u: Unit) => ({ label: null, conf: 0, rung: 'abstain', candidates: [] as string[], hint: '', case: caseKeyOf(task, u) });
  return {
    rows,
    decided,
    item: (u) => {
      const r = route(u);
      const base = { candidates: [] as string[], hint: '', case: caseKeyOf('t1-item', u), senderClass: 'human' as const, family: u.id, hosts: [], apps: [] };
      return r ? { ...base, label: r.label, conf: wrong.has(r.rung) ? 0.924 : 0.97, rung: r.rung, candidates: [r.label] } : { ...base, label: null, conf: 0, rung: 'abstain' };
    },
    fragment: (u) => {
      const ruled = /weekly/i.test(u.title);
      return { ...blank('t1-fragment', u), ...(ruled ? { label: 'nordwind/shop', conf: 0.97, rung: 'rule:r-weekly', candidates: ['nordwind/shop'] } : {}), case: u.case ?? u.id.replace(/#\d+$/, ''), participants: u.participants, cowork: [] };
    },
    mention: (u) => blank('t3-identity', u),
    kind: (u) => blank('t4-kind', u),
    addressee: (u) => blank('t4-addressee', u),
    dedup: (units) => new Map(units.map((u) => [u.id, { cluster: `c-${u.id}`, conf: 0.99 }])),
    labelSpace: (task) => (task === 't4-kind' ? ['request', 'question', 'commitment', 'incident', 'info', 'noise'] : [...META.labelSpace.initiatives, 'none', 'unregistered']),
    cards: () => CARDS,
    calibrate: (rs, dec) => {
      for (const r of rs) {
        rows.push(r);
        const inst = dec.get(r.id);
        if (inst) decided.set(r.id, inst);
        if (inst && r.source === 'human' && r.label !== r.predicted) wrong.add(inst);
      }
    },
  };
}

const CHECK = /^You check work records/;

// A canned model: the check answers by the unit's own line on its card (stock → the bridge; BK- → the booking product;
// else the shop), K+g's guess call gets an empty answer. Every prompt is kept.
function canned(log: { system: string; prompt: string }[] = [], usd = 0.01): LlmLike {
  return {
    call: async (c) => {
      log.push({ system: c.system, prompt: c.prompt });
      if (!CHECK.test(c.system)) return { text: '[]', costUsd: 0.001, cached: false };
      const rows = [...c.prompt.matchAll(/^### (u\d+) · options: .*\n([\s\S]*?)(?=\n### u|\nAnswer with)/gm)].map((m) => {
        const own = m[2]!.split('\n').find((l) => l.startsWith(`${m[1]} [`)) ?? '';
        return { unit: m[1], label: /stock/i.test(own) ? 'nordwind/stock-sync' : /BK-/.test(own) ? 'inhouse/booker' : 'nordwind/shop', cite: 'stock' };
      });
      return { text: JSON.stringify(rows), costUsd: usd, cached: false };
    },
  };
}

interface Run {
  v: Variant;
  state: Map<string, unknown>;
  memory: MemoryRow[];
  dir: string;
}
const newRun = (v: Variant): Run => ({ v, state: new Map(), memory: [], dir: mkdtempSync(join(tmpdir(), 'k2b-')) });
const ctxOf = (r: Run, day: string, pool: Unit[], llm: LlmLike | null): DayCtx => ({ dataset: META, dir: r.dir, day, pool, memory: r.memory.slice(), state: r.state, llm, log: () => {} });
async function decide(r: Run, task: TaskId, day: string, units: Unit[], llm: LlmLike | null): Promise<Map<string, Prediction>> {
  return new Map((await r.v.decide(task, units, ctxOf(r, day, units, llm))).map((p) => [p.id, p]));
}

const DAY1 = [
  comment('yt:NW-7#c1', D1, 'NW-7', 'stock levels lag behind the ERP since the import'),
  comment('yt:NW-8#c1', D1, 'NW-8', 'checkout button is misaligned on mobile'),
  comment('yt:BK-3#c1', D1, 'BK-3', 'merged the calendar export fix'),
  chat('slack:T0:C9:1', D1, 'slack:T0:C9:1', 'anyone up for lunch?'),
];

test('the check vetoes a structural decision whose content says a sibling; agreement changes nothing', async () => {
  const fl = fakeFloor();
  const log: { system: string; prompt: string }[] = [];
  const got = await decide(newRun(makeK2b({ floor: () => fl })), 't1-item', D1, DAY1, canned(log));
  const checks = log.filter((c) => CHECK.test(c.system));
  assert.equal(checks.length, 1, 'one call for the day (≤25 units)');
  assert.equal((checks[0]!.prompt.match(/^### u/gm) ?? []).length, 3, 'the three structural decisions, not the abstained chat');
  assert.ok(!checks[0]!.prompt.includes('yt:NW-7'), 'no store ids');
  assert.match(checks[0]!.prompt, /options: (nordwind\/shop \| nordwind\/stock-sync|nordwind\/stock-sync \| nordwind\/shop) \| none \| unregistered/);
  assert.match(checks[0]!.prompt, /options: (inhouse\/booker \| inhouse\/booker-desk|inhouse\/booker-desk \| inhouse\/booker) \| none \| unregistered/);
  assert.ok(!/nordwind\/admin \|/.test(checks[0]!.prompt), 'admin buckets are never options nor registry lines');

  const veto = got.get('yt:NW-7#c1')!;
  assert.equal(veto.label, 'nordwind/shop', 'the label stays the structural one');
  assert.equal(veto.conf, 0.7);
  assert.equal(veto.rung, 'veto:key:NW');
  assert.equal(veto.ask?.guess, 'nordwind/shop', 'the guess a person sees is X, never the check’s label');
  assert.equal(veto.ask?.form, 'confirm');
  assert.ok(veto.ask?.group?.startsWith('veto:nordwind/shop|'));
  assert.match(veto.why ?? '', /check says nordwind\/stock-sync/);
  for (const id of ['yt:NW-8#c1', 'yt:BK-3#c1']) {
    const p = got.get(id)!;
    assert.equal(p.conf, 0.97);
    assert.equal(p.rung, id.includes('BK') ? 'key:BK' : 'key:NW');
    assert.equal(p.ask, undefined);
  }
  for (const id of ['yt:NW-7#c1', 'yt:NW-8#c1', 'yt:BK-3#c1']) assert.ok(Math.abs(got.get(id)!.costUsd! - 0.01 / 3) < 1e-12, 'the call’s spend split over its units');
  assert.equal(got.get('slack:T0:C9:1')!.costUsd, undefined);
  assert.equal(got.get('slack:T0:C9:1')!.label, null);
});

test('without a model K2b is keys+g, prediction for prediction; a failing model vetoes nothing', async () => {
  const kg = await decide(newRun(makeKeys({ name: 'keys+g', description: 't', guess: true, floor: fakeFloor })), 't1-item', D1, DAY1, null);
  const k2 = await decide(newRun(makeK2b({ floor: fakeFloor })), 't1-item', D1, DAY1, null);
  assert.deepEqual([...k2.values()], [...kg.values()]);
  const failing: LlmLike = { call: async (c) => ({ text: '', costUsd: CHECK.test(c.system) ? 0.002 : 0, cached: false, error: 'quota' }) };
  const kgf = await decide(newRun(makeKeys({ name: 'keys+g', description: 't', guess: true, floor: fakeFloor })), 't1-item', D1, DAY1, failing);
  const k2f = await decide(newRun(makeK2b({ floor: fakeFloor })), 't1-item', D1, DAY1, failing);
  const strip = (p: Prediction) => ({ ...p, costUsd: undefined });
  assert.deepEqual([...k2f.values()].map(strip), [...kgf.values()].map(strip));
  // other tasks are K+g's, unchecked
  const kinds = await decide(newRun(makeK2b({ floor: fakeFloor })), 't4-kind', D1, DAY1, canned());
  assert.ok([...kinds.values()].every((p) => !p.rung.startsWith('veto:') && p.costUsd === undefined));
});

test('decisions K earned from answers are not checked; only the floor’s structural ones are', async () => {
  const fl = fakeFloor();
  const r = newRun(makeK2b({ floor: () => fl }));
  const first = chat('slack:T0:C9:7', D1, 'slack:T0:C9:7', 'the stock bridge retries now');
  await decide(r, 't1-item', D1, [first], canned());
  r.memory.push({ id: first.id, task: 't1-item', day: D1, label: 'nordwind/stock-sync', source: 'human', answer: `${D1}:q1`, predicted: null, conf: 0, rung: 'abstain' });
  await r.v.nightly!('t1-item', ctxOf(r, D1, [], null));
  const log: { system: string; prompt: string }[] = [];
  const reply = chat('slack:T0:C9:8', D2, 'slack:T0:C9:7', 'stock bridge: still slow on stock levels');
  const got = await decide(r, 't1-item', D2, [reply], canned(log));
  assert.equal(got.get(reply.id)!.rung, 'earned:thread', 'the answered thread decides its reply');
  assert.ok(got.get(reply.id)!.conf >= 0.95);
  assert.equal(log.filter((c) => CHECK.test(c.system)).length, 0, 'an earned decision is never sent to the check');
  assert.equal(structural(got.get(reply.id), fl.item(reply, [reply]), 0.95), false);
});

test('replay: a vetoed unit is asked as a confirm of X; its answer is an ordinary human row that stops the instance', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'k2b-ds-'));
  const day2 = [comment('yt:NW-9#c1', D2, 'NW-9', 'stock bridge retries the nightly job'), comment('yt:NW-10#c1', D2, 'NW-10', 'new banner on the checkout page')];
  const units = [...DAY1, ...day2];
  saveMeta(dir, { ...META, counts: { item: units.length } });
  writeJsonl(join(dir, 'units', 'item.jsonl'), units);
  const gold: Record<string, string> = {
    'yt:NW-7#c1': 'nordwind/stock-sync',
    'yt:NW-8#c1': 'nordwind/shop',
    'yt:BK-3#c1': 'inhouse/booker',
    'slack:T0:C9:1': 'none',
    'yt:NW-9#c1': 'nordwind/stock-sync',
    'yt:NW-10#c1': 'nordwind/shop',
  };
  writeJsonl(
    join(dir, 'gold', 't1-item.jsonl'),
    units.map((u) => ({ id: u.id, task: 't1-item', label: gold[u.id], tier: 'synthetic' })),
  );
  const fl = fakeFloor();
  const log: { system: string; prompt: string }[] = [];
  const res = await runTask(loadDataset(dir), makeK2b({ floor: () => fl }), 't1-item', { mode: 'replay', memory: 'none', questionsPerDay: 3, auditShare: 0, llm: canned(log), runName: 'k2b-test', log: () => {}, labDir: dir });
  const byId = new Map(res.predictions.map((p) => [p.id, p]));
  assert.ok(res.answered.includes('yt:NW-7#c1'), 'the veto was asked (and answered) on day 1');
  // what the floor's calibration was handed: the person's answer, with X as what the pipeline said — never the check's label
  const row = fl.rows.find((x) => x.id === 'yt:NW-7#c1')!;
  assert.equal(row.source, 'human');
  assert.equal(row.label, 'nordwind/stock-sync');
  assert.equal(row.predicted, 'nordwind/shop');
  assert.equal(row.rung, 'veto:key:NW');
  assert.equal(fl.decided.get('yt:NW-7#c1'), 'key:NW', 'the answer is charged to the rung instance that decided the unit');
  assert.ok(fl.rows.every((x) => x.source === 'human'), 'no machine row, no check output in memory');
  // day 2: key:NW was contradicted once → .924 → no longer auto-decided, so no longer checked either
  for (const id of ['yt:NW-9#c1', 'yt:NW-10#c1']) {
    const p = byId.get(id)!;
    assert.ok(p.conf < 0.95 && !p.rung.startsWith('veto:'), `${id} is a question of K's own`);
  }
  const checkPrompts = log.filter((c) => CHECK.test(c.system));
  assert.equal(checkPrompts.length, 1, 'day 2 had no structural auto-decision to check');
  assert.ok(res.costUsd > 0);
});

test('fragments: a rule-routed call topic is checked; a veto weighs its minutes', async () => {
  const fl = fakeFloor();
  const topic = (n: number, heading: string, text: string, minutes: number): FragmentUnit => ({
    id: `frag-${D1}-call-abc#${n}`,
    day: D1,
    kind: 'call',
    start: `${D1}T10:00:00Z`,
    end: `${D1}T11:00:00Z`,
    minutes,
    title: `Nordwind weekly — ${heading}`,
    source: 'gmeet',
    container: null,
    participants: ['pia'],
    projectKeys: [],
    repo: null,
    weight: 0.5,
    refs: [],
    text: `## ${heading}\n${text}`,
    case: 'call:abc',
  });
  const units = [topic(1, 'stock bridge', 'the stock bridge lags; we scale the worker', 40), topic(2, 'checkout', 'new checkout banner', 20)];
  const got = await decide(newRun(makeK2b({ floor: () => fl })), 't1-fragment', D1, units, canned());
  const v = got.get(units[0]!.id)!;
  assert.equal(v.rung, 'veto:rule:r-weekly');
  assert.equal(v.conf, 0.7);
  assert.equal(v.ask?.group, 'veto:nordwind/shop|call:abc');
  assert.ok(Math.abs(v.ask!.value! - (40 * 0.3 + 0.5)) < 1e-9, 'own term weighs minutes; the lone veto of the instance adds 0.5·1');
  assert.equal(got.get(units[1]!.id)!.rung, 'rule:r-weekly');
  assert.equal(got.get(units[1]!.id)!.conf, 0.97);
});
