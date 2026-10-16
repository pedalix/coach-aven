// prodlearn over a fictional dataset (a real store file, a tenant, unit files): the production build runs on a private
// copy and leaves the dataset as it was; the learner sees a person's rows only, nothing after today; a structural key of
// a client with siblings is held for the client-day question; one answer on a thread earns its key the next day; bench
// fragment ids production no longer cuts abstain as 'unmatched'. No model anywhere.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../../sources/store.js';
import { hash } from '../../sources/attribution/fragment.js';
import type { DatasetMeta, DayCtx, MemoryRow, Prediction, Unit } from '../types.js';
import { buildProd, evidenceOf, idReport, makeProdlearn, poolOf, predictionOf, queueOrder, type ProdBuild } from './prodlearn.js';

const D1 = '2026-10-14';
const D2 = '2026-10-15';
const REF = {
  root: 'slack:T1:C0DEV00001:1760425200.000100', // D1 07:00Z (09:00 Zurich): the owner in #dev about NW-12
  reply: 'slack:T1:C0DEV00001:1760511600.000200', // D2 07:00Z: Ana answers in the same thread
  bot: 'slack:T1:C0OPS00001:1760515200.000300', // D2 08:00Z: a monitor nobody routes
};
const THREAD = 'slack:T1/C0DEV00001/1760425200.000100';
const FRAG = `frag-${D1}-thread-${hash(`#dev|${REF.root}`)}`; // the production fragmenter's id of the owner's run

const meta: DatasetMeta = {
  name: 'fixture',
  kind: 'synthetic',
  tenant: 'fixture',
  tz: 'Europe/Zurich',
  since: D1,
  until: D2,
  subject: 'owner',
  createdAt: '2026-10-15T18:00:00.000Z',
  sourceStore: 'fixture',
  labelSpace: { initiatives: ['northwind/shop', 'northwind/erp-sync', 'globex/portal'], umbrellas: {}, people: ['owner', 'ana'] },
  counts: {},
};

// One client with two running initiatives (siblings: the NW prefix routes to the shop only), one other client.
const registry = {
  initiatives: [
    { id: 'northwind/shop', umbrella: 'northwind', company: 'northwind', name: 'Northwind shop relaunch', status: 'active', sources: { youtrack_prefixes: ['NW'] } },
    { id: 'northwind/erp-sync', umbrella: 'northwind', company: 'northwind', name: 'Northwind ERP sync', status: 'active', sources: {} },
    { id: 'globex/portal', umbrella: 'globex', sources: { slack_channels: ['#portal'] } },
  ],
};
const people = [
  { person_id: 'owner', name: 'Olga Owner', identities: ['olga@example.com', 'slack:Olga Owner'] },
  { person_id: 'ana', name: 'Ana Berg', identities: ['ana@northwind.example', 'slack:Ana Berg'] },
];

const sha = (p: string): string => createHash('sha256').update(readFileSync(p)).digest('hex');

/** A dataset directory: store.sqlite (closed), tenant/, units/. */
function dataset(): string {
  const dir = mkdtempSync(join(tmpdir(), 'prodlearn-ds-'));
  const db = openStore(join(dir, 'store.sqlite'));
  const pIns = db.prepare('INSERT INTO people(person_id, name, company, marker_type, marker_initiatives) VALUES (?, ?, NULL, ?, ?)');
  const iIns = db.prepare('INSERT INTO identities(identity, person_id, kind) VALUES (?, ?, ?)');
  for (const p of people) {
    pIns.run(p.person_id, p.name, 'broad', '[]');
    for (const id of p.identities) iIns.run(id.replace(/^slack:/, '').toLowerCase(), p.person_id, id.startsWith('slack:') ? 'slack' : 'email');
  }
  const m = db.prepare('INSERT INTO messages(ref, source, account, container, thread_id, ts, author_person, author_raw, subject, text, is_bot) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  m.run(REF.root, 'slack', 'T1', '#dev', THREAD, '2026-10-14T07:00:00.000Z', 'owner', 'Olga Owner', '', 'The NW-12 import failed on staging again, looking into it', 0);
  m.run(REF.reply, 'slack', 'T1', '#dev', THREAD, '2026-10-15T07:00:00.000Z', 'ana', 'Ana Berg', '', 'still failing on our side, logs attached', 0);
  m.run(REF.bot, 'slack', 'T1', '#ops', 'slack:T1/C0OPS00001/1760515200.000300', '2026-10-15T08:00:00.000Z', null, 'Uptime Watch', '', 'DOWN https://status.example.org is not responding', 1);
  db.close();

  const ann = join(dir, 'tenant', 'annotations');
  mkdirSync(ann, { recursive: true });
  writeFileSync(join(dir, 'tenant', 'initiatives.json'), JSON.stringify(registry));
  writeFileSync(join(ann, 'people.json'), JSON.stringify(people));
  writeFileSync(join(ann, 'rules.json'), '[]');
  // The learning loop is switched ON in the tenant as given: the copy must switch it off (the variant calls learn itself).
  writeFileSync(join(ann, 'attribution.json'), JSON.stringify({ subject: 'owner', since: D1, learn: { mode: 'shadow' } }));
  mkdirSync(join(dir, 'units'), { recursive: true });
  const items = [
    { id: REF.root, day: D1, type: 'message' },
    { id: REF.reply, day: D2, type: 'message' },
    { id: REF.bot, day: D2, type: 'message' },
  ];
  writeFileSync(join(dir, 'units', 'item.jsonl'), items.map((x) => JSON.stringify(x)).join('\n'));
  const frags = [
    { id: FRAG, day: D1, kind: 'thread', refs: [REF.root] },
    { id: `frag-${D1}-call-granola-gone`, day: D1, kind: 'call', refs: ['meeting:granola:gone'] }, // a cut production no longer makes
  ];
  writeFileSync(join(dir, 'units', 'fragment.jsonl'), frags.map((x) => JSON.stringify(x)).join('\n'));
  return dir;
}

const unit = (id: string, day: string, extra: object = {}): Unit => ({ id, day, ...extra }) as unknown as Unit;
const ctxOf = (dir: string, day: string, memory: MemoryRow[], state: Map<string, unknown>, logs: string[]): DayCtx => ({ dataset: meta, dir, day, pool: [], memory, state, llm: null, log: (m) => logs.push(m) });

let shared: { dir: string; build: ProdBuild; before: string } | null = null;
after(() => {
  if (shared) rmSync(shared.dir, { recursive: true, force: true });
});
function fixture(): { dir: string; build: ProdBuild; before: string } {
  if (!shared) {
    const dir = dataset();
    const before = sha(join(dir, 'store.sqlite'));
    shared = { dir, build: buildProd(dir, meta), before };
  }
  return shared;
}

test('buildProd: the production layer over a private copy — items and fragments as learn-load loads them; the dataset untouched', () => {
  const { dir, build, before } = fixture();
  assert.equal(sha(join(dir, 'store.sqlite')), before, 'the frozen store is byte-identical after the build');
  assert.ok(!existsSync(join(dir, 'store.sqlite-wal')) && !existsSync(join(dir, 'store.sqlite-shm')), 'and was never opened in place');
  assert.match(readFileSync(join(dir, 'tenant', 'annotations', 'attribution.json'), 'utf8'), /"learn"/, 'the tenant as given keeps its own file');
  assert.deepEqual(build.window, { since: D1, until: D2, days: 2, now: '2026-10-15T18:00:00.000Z' });
  assert.equal(build.summary.learn, undefined, 'learn is off in the copy: the build stores no shadow loop');
  const byId = new Map(build.units.map((u) => [u.id, u]));
  const root = byId.get(REF.root)!;
  assert.deepEqual([root.unit, root.day, root.label, root.conf, root.rung, root.structural], ['item', D1, 'northwind/shop', 0.95, 'key:NW', true], 'the item floor: a tracker key in the text');
  const reply = byId.get(REF.reply)!;
  assert.deepEqual([reply.day, reply.label, reply.rung], [D2, 'northwind/shop', 'key:NW'], 'a reply inherits its root');
  assert.ok(Math.abs(reply.conf - 0.95 * 0.99) < 1e-9);
  assert.equal(reply.keys.thread, THREAD);
  assert.ok(byId.has(REF.bot));
  assert.equal(byId.get(FRAG)?.unit, 'fragment', "the owner's run is a fragment with the fragmenter's id");
  const shop = build.initiatives.find((i) => i.id === 'northwind/shop')!;
  assert.deepEqual([shop.umbrella, shop.company, shop.active], ['northwind', 'northwind', true]);
});

test('evidenceOf: a person\'s answers and audits with their answer ids; machine rows and other tasks are never evidence', () => {
  const rows: MemoryRow[] = [
    { id: 'a', task: 't1-item', day: D1, label: 'x', source: 'human', answer: `${D1}:g1`, predicted: 'y', conf: 0.85, rung: 'key:NW' },
    { id: 'b', task: 't1-item', day: D1, label: 'x', source: 'human', audit: true, answer: `${D1}:audit:b`, predicted: 'x' },
    { id: 'c', task: 't1-item', day: D1, label: 'x', source: 'machine', predicted: 'x' },
    { id: 'd', task: 't1-fragment', day: D1, label: 'x', source: 'human', answer: 'f' },
    { id: 'e', task: 't1-item', day: D1, label: 'z', source: 'human' },
  ];
  assert.deepEqual(evidenceOf(rows, 't1-item'), [
    { id: 'a', day: D1, label: 'x', source: 'human', answer: `${D1}:g1`, guess: 'y' },
    { id: 'b', day: D1, label: 'x', source: 'human', answer: `${D1}:audit:b`, audit: true, guess: 'x' },
    { id: 'e', day: D1, label: 'z', source: 'human', answer: `${D1}:unit:e` },
  ]);
});

test('poolOf: the task\'s kind, nothing after today', () => {
  const { build } = fixture();
  const d1 = poolOf(build.units, new Set(['item']), D1).map((u) => u.id);
  assert.deepEqual(d1, [REF.root]);
  assert.deepEqual(poolOf(build.units, new Set(['item']), D2).map((u) => u.id).sort(), [REF.bot, REF.reply, REF.root].sort());
  assert.ok(poolOf(build.units, new Set(['fragment', 'item']), D2).some((u) => u.id === FRAG));
});

test('decide t1-item: a structural key of a client with siblings is held (.85) for the client-day question; one answer earns the thread', async () => {
  const { dir, build } = fixture();
  const v = makeProdlearn({ build: () => build });
  const logs: string[] = [];
  const state = new Map<string, unknown>();
  const [p1] = await v.decide('t1-item', [unit(REF.root, D1)], ctxOf(dir, D1, [], state, logs));
  assert.deepEqual([p1!.label, p1!.conf, p1!.rung], ['northwind/shop', 0.85, 'key:NW'], 'no cue tells the shop from the ERP sync');
  assert.deepEqual(p1!.ask && [p1!.ask.group, p1!.ask.guess, p1!.ask.form], [`client:northwind:${D1}`, 'northwind/shop', 'confirm'], 'the client is decided, the initiative asked');
  assert.match(logs.join('\n'), /3\/3 bench item ids are production ids/);

  // The person answers the client-day question: the ERP sync. The next day the reply's thread key has earned it.
  const answer: MemoryRow = { id: REF.root, task: 't1-item', day: D1, label: 'northwind/erp-sync', source: 'human', answer: `${D1}:client:northwind:${D1}`, predicted: 'northwind/shop', conf: 0.85, rung: 'key:NW' };
  const day2 = [unit(REF.reply, D2), unit(REF.bot, D2)];
  const [reply, bot] = await v.decide('t1-item', day2, ctxOf(dir, D2, [answer], state, logs));
  assert.deepEqual([reply!.label, reply!.rung], ['northwind/erp-sync', 'earned:thread']);
  assert.ok(reply!.conf >= 0.95, `decided: ${reply!.conf}`);
  assert.equal(bot!.label, null, 'nothing routes the monitor');
  assert.ok(bot!.ask?.group, 'an open unit is asked');

  // The same row as the machine's own output teaches nothing: the reply stays held.
  const [held] = await v.decide('t1-item', [unit(REF.reply, D2)], ctxOf(dir, D2, [{ ...answer, source: 'machine' }], new Map(), []));
  assert.deepEqual([held!.label, held!.conf, held!.rung], ['northwind/shop', 0.85, 'key:NW']);
});

test('decide t1-fragment: a bench id production still cuts is decided by production; one it no longer cuts abstains as unmatched', async () => {
  const { dir, build } = fixture();
  const v = makeProdlearn({ build: () => build });
  const logs: string[] = [];
  const [run, gone] = await v.decide('t1-fragment', [unit(FRAG, D1), unit(`frag-${D1}-call-granola-gone`, D1)], ctxOf(dir, D1, [], new Map(), logs));
  assert.notEqual(run!.rung, 'unmatched');
  assert.equal(run!.label, 'northwind/shop', 'the ladder routes the run by its tracker key');
  assert.deepEqual([gone!.label, gone!.conf, gone!.rung], [null, 0, 'unmatched']);
  assert.match(logs.join('\n'), /1\/2 bench fragment ids are production ids \(thread 1\/1, call 0\/1\); 0 of the unmatched share a ref/);
});

test('idReport: matched by id; an unmatched fragment that shares a ref with a production cut is counted', () => {
  const prod = { units: fixture().build.units, refs: new Map([[FRAG, [REF.root]]]) };
  const r = idReport('fragment', [unit(FRAG, D1, { kind: 'thread', refs: [REF.root] }), unit('frag-old', D1, { kind: 'thread', refs: [REF.root] }), unit('frag-x', D1, { kind: 'call', refs: ['meeting:x'] })], prod);
  assert.deepEqual([r.bench, r.matched, r.sharedRef, r.dayMismatch], [3, 1, 1, 0]);
  assert.deepEqual(r.byKind, { thread: { bench: 2, matched: 1 }, call: { bench: 1, matched: 0 } });
});

test('predictionOf / queueOrder: the Learned row as a Prediction; the queue ablation makes bench sums follow the queue', () => {
  assert.deepEqual(predictionOf('u', undefined), { id: 'u', label: null, conf: 0, rung: 'unmatched' });
  const p = predictionOf('u', { id: 'u', label: 'a', conf: 0.6, rung: 'cue:key:X', why: 'w', umbrella: 'c', umbrellaConf: 0.97, ask: { group: 'g', value: 1.5, guess: 'a', form: 'confirm' } });
  assert.deepEqual(p, { id: 'u', label: 'a', conf: 0.6, rung: 'cue:key:X', why: 'w · umbrella=c@0.970', ask: { group: 'g', value: 1.5, guess: 'a', form: 'confirm' } });
  const preds: Prediction[] = [
    { id: 'a', label: null, conf: 0, rung: 'abstain', ask: { group: 'g2', value: 9 } },
    { id: 'b', label: null, conf: 0, rung: 'abstain', ask: { group: 'g1', value: 0.1 } },
    { id: 'c', label: null, conf: 0, rung: 'abstain', ask: { group: 'g1', value: 0.1 } },
  ];
  queueOrder(preds, ['g0', 'g1', 'g2']);
  assert.deepEqual(preds.map((x) => x.ask?.value), [1, 1, 1], 'g1 (second of three) sums to 2 over its two members, g2 to 1');
});
