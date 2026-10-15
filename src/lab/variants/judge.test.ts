// J end to end on a fictional agency, with a FIXED floor (so the stage-0 work in flight cannot move these tests)
// and a CANNED model: every answer is scripted by directives inside the fictional unit texts —
//   pick:<label>     what both passes answer          pickB:<label>  what pass B (haiku) answers instead
//   cite:"<span>"    the span both passes cite         arb:<label>    what the arbiter picks
//   fixme            the first answer is off the list (the re-ask fixes it)
// t4: kind:<k> / kindB:<k> / addr:<id|none> / addrB:<id|none> / cue:"<span>"; t3 answers by the surface form.
// No claude anywhere (imports.test.ts): the model is a plain function here.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatasetMeta, DayCtx, FragmentUnit, ItemUnit, LlmLike, MemoryRow, MentionUnit, Prediction, TaskId, Unit } from '../types.js';
import type { Floor, Stage0 } from './stage0/index.js';
import { judgeState, makeJudge, stableBatches } from './judge.js';

const D1 = '2026-01-05';
const D2 = '2026-01-06';

function tenantDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'lab-judge-'));
  const t = join(dir, 'tenant');
  mkdirSync(join(t, 'annotations'), { recursive: true });
  writeFileSync(
    join(t, 'initiatives.json'),
    JSON.stringify({
      initiatives: [
        { id: 'acme/web', umbrella: 'acme', name: 'Acme Website', sources: { slack_channels: ['#acme-web'], youtrack_prefixes: ['WEB'] } },
        { id: 'acme/app', umbrella: 'acme', name: 'Acme Mobile App', sources: { jira_keys: ['APP'] } },
        { id: 'globex/ops', umbrella: 'globex', name: 'Globex Operations', sources: {} },
      ],
    }),
  );
  writeFileSync(
    join(t, 'annotations', 'people.json'),
    JSON.stringify([
      { person_id: 'olive', name: 'Olive Owner', identities: ['olive@agency.example'] },
      { person_id: 'mara', name: 'Mara Quill', company: 'acme', identities: ['mara@acme.example'], marker: { type: 'narrow', initiatives: ['acme/web', 'acme/app'] } },
    ]),
  );
  return dir;
}

const META: DatasetMeta = {
  name: 'judge-fixture',
  kind: 'synthetic',
  tenant: 'agency',
  tz: 'UTC',
  since: D1,
  until: D2,
  subject: 'olive',
  createdAt: '2026-01-07T00:00:00Z',
  sourceStore: 'test',
  labelSpace: { initiatives: ['acme/web', 'acme/app', 'globex/ops'], umbrellas: { 'acme/web': 'acme', 'acme/app': 'acme', 'globex/ops': 'globex' }, people: ['olive', 'mara'] },
  counts: {},
};

// The fixed floor: a production ladder 'rule' decides at .97, anything else is open with the ladder's candidates.
function fixedFloor(calibrations: { rows: MemoryRow[]; decided: Map<string, string> }[] = []): (ctx: DayCtx) => Stage0 {
  const open = (c: string): Floor => ({ label: null, conf: 0, rung: 'open', candidates: [], hint: '', case: c });
  const s0: Stage0 = {
    fragment: (u) => {
      const l = u.ladder;
      const decided = l?.state === 'rule' && !!l.initiative;
      return { ...open(u.id.replace(/#\d+$/, '')), label: decided ? l!.initiative! : null, conf: decided ? 0.97 : 0, rung: decided ? `rule:${l!.rule}` : 'open', candidates: l?.candidates ?? [], participants: u.participants, cowork: [] };
    },
    item: (u) => ({ ...open(`thread:${u.thread}`), senderClass: u.isBot ? 'bot' : 'human', family: u.isBot ? `fam:${u.author}` : u.id, hosts: [], apps: [] }),
    mention: (u) => ({ ...open(`form:${u.raw.toLowerCase().replace(/\s+/g, ' ').trim()}`), label: u.production, conf: u.production ? 0.99 : 0, rung: u.production ? 'production' : 'open' }),
    kind: (u) =>
      u.isBot && /FIRING/.test(u.text)
        ? { ...open(`thread:${u.thread}`), label: 'incident', conf: 0.9, rung: 'auto:firing', candidates: ['incident'] }
        : u.isBot
          ? { ...open(`thread:${u.thread}`), label: 'noise', conf: 0.95, rung: 'sender:bot' }
          : open(`thread:${u.thread}`),
    addressee: (u) => open(`thread:${u.thread}`),
    dedup: (units) => new Map(units.map((u) => [u.id, { cluster: u.id, conf: 1 }])),
    labelSpace: () => ['acme/web', 'acme/app', 'globex/ops', 'none', 'unregistered'],
    cards: () => [], // → J reads the tenant's registry itself
    calibrate: (rows, decided) => void calibrations.push({ rows, decided: new Map(decided) }),
  };
  return () => s0;
}

interface Call {
  model: string;
  system: string;
  prompt: string;
}

const ARBITER = /^You arbitrate/;
const T4 = /^You read incoming messages/;
const T3 = /^You resolve how people/;

function cannedModel(calls: Call[]): LlmLike {
  return {
    async call(c) {
      calls.push(c);
      const b = c.model === 'haiku';
      const lines = c.prompt.split('\n');
      const reask = c.prompt.includes('Your previous answer had problems');
      const asked = reask ? new Set([...c.prompt.split('Your previous answer had problems')[1]!.matchAll(/^- (u\d+):/gm)].map((m) => m[1])) : null;
      const out: unknown[] = [];
      if (ARBITER.test(c.system)) {
        for (const m of c.prompt.matchAll(/^(u\d+): option 1 = (\S+) · option 2 = (\S+)$/gm)) {
          const line = lines.find((l) => l.startsWith(`${m[1]} [`)) ?? '';
          out.push({ unit: m[1], label: /arb:(\S+)/.exec(line)?.[1] ?? m[2], cite: { field: 'text', span: /arbcite:"([^"]+)"/.exec(line)?.[1] ?? 'not in the card' } });
        }
        return { text: JSON.stringify(out), costUsd: 0.02, cached: false };
      }
      if (T4.test(c.system)) {
        const blocks = c.prompt.split(/\n(?=u\d+ · )/).filter((x) => /^u\d+ · /.test(x));
        for (const blk of blocks) {
          const tag = /^(u\d+)/.exec(blk)![1]!;
          const kind = (b && /kindB:(\S+)/.exec(blk)?.[1]) || /kind:(\S+)/.exec(blk)?.[1] || 'info';
          const addr = (b && /addrB:(\S+)/.exec(blk)?.[1]) || /addr:(\S+)/.exec(blk)?.[1] || 'none';
          out.push({ unit: tag, kind, addressee: addr === 'none' ? 'none' : [addr], cue: /cue:"([^"]+)"/.exec(blk)?.[1] ?? '' });
        }
        return { text: JSON.stringify(out), costUsd: 0.01, cached: false };
      }
      if (T3.test(c.system)) {
        for (const m of c.prompt.matchAll(/^(u\d+) · "([^"]*)"/gm)) {
          const raw = m[2]!;
          const label = /bot/i.test(raw) ? 'system' : /^mara/i.test(raw) ? 'person:mara' : b ? 'person:olive' : 'unknown';
          out.push({ unit: m[1], label, cite: raw });
        }
        return { text: JSON.stringify(out), costUsd: 0.01, cached: false };
      }
      for (const m of c.prompt.matchAll(/^(u\d+)[^\n]*?\]: ([^\n]*)$/gm)) {
        const [, tag, text] = m as unknown as [string, string, string];
        if (asked && !asked.has(tag)) continue;
        let label = /pick:(\S+)/.exec(text)?.[1] ?? 'none';
        if (b) label = /pickB:(\S+)/.exec(text)?.[1] ?? label;
        if (!reask && /fixme/.test(text)) label = 'acme/nonsense';
        out.push({ unit: tag, label, cite: { field: 'text', span: /cite:"([^"]+)"/.exec(text)?.[1] ?? 'not in the card' } });
      }
      return { text: `\`\`\`json\n${JSON.stringify(out)}\n\`\`\``, costUsd: 0.01, cached: false };
    },
  };
}

const frag = (id: string, text: string, extra: Partial<FragmentUnit> = {}): FragmentUnit => ({
  id,
  day: D1,
  kind: 'call',
  start: `${D1}T10:00:00Z`,
  end: `${D1}T11:00:00Z`,
  minutes: 30,
  title: 'Acme sync — topic',
  source: 'granola',
  container: null,
  participants: ['mara'],
  projectKeys: [],
  repo: null,
  weight: 0.5,
  refs: [`meeting:granola:${id}`],
  text,
  ladder: { state: 'open', candidates: [] },
  ...extra,
});

function day1(): FragmentUnit[] {
  return [
    frag('f-rule', 'work on the shop', { kind: 'work', ladder: { state: 'rule', initiative: 'acme/web', rule: 'r1' }, minutes: 60 }),
    frag('f-call#1', 'Acme Website checkout pick:acme/web cite:"Acme Website checkout"', { ladder: { state: 'open', candidates: ['acme/web'] } }),
    frag('f-call#2', 'Quarterly planning pick:acme/app pickB:acme/web arb:acme/app'),
    frag('f-chat', 'random chatter pick:none', { kind: 'thread', title: 'dm:@mara', container: 'dm:@mara' }),
    frag('f-fix', 'fixme Website copy pick:acme/web cite:"Website copy"', { kind: 'thread', title: 'dm:@mara', container: 'dm:@mara', start: `${D1}T15:00:00Z`, end: `${D1}T15:30:00Z` }),
    frag('f-bad', 'pick:bogus/x', { kind: 'thread', title: '#random', container: '#random', start: `${D1}T16:00:00Z`, end: `${D1}T16:10:00Z` }),
  ];
}

const ctxOf = (dir: string, day: string, pool: Unit[], llm: LlmLike | null, state = new Map<string, unknown>(), memory: MemoryRow[] = []): DayCtx => ({ dataset: META, dir, day, pool, memory, state, llm, log: () => {} });
const byId = (ps: Prediction[]) => new Map(ps.map((p) => [p.id, p]));

test('t1-fragment: the floor stands; the residue is judged by case into cells; questions carry the guess', async () => {
  const dir = tenantDir();
  const calls: Call[] = [];
  const v = makeJudge(fixedFloor());
  const units = day1();
  const p = byId(await v.decide('t1-fragment', units, ctxOf(dir, D1, units, cannedModel(calls))));

  // the floor's decision is kept as is — no model spend on it
  assert.deepEqual(
    (({ label, conf, rung, costUsd }) => ({ label, conf, rung, costUsd }))(p.get('f-rule')!),
    { label: 'acme/web', conf: 0.97, rung: 'rule:r1', costUsd: undefined },
  );
  // both passes agree, the cite is in the text and names the label → AA+g; in the floor's candidates → +.005
  assert.equal(p.get('f-call#1')!.label, 'acme/web');
  assert.equal(p.get('f-call#1')!.rung, 'judge:AA+g');
  assert.equal(p.get('f-call#1')!.conf, 0.935);
  // the passes disagree, the arbiter sides with A, its cite is not in the card → AR
  assert.equal(p.get('f-call#2')!.label, 'acme/app');
  assert.equal(p.get('f-call#2')!.rung, 'judge:AR');
  assert.equal(p.get('f-call#2')!.conf, 0.7);
  assert.equal(p.get('f-chat')!.rung, 'judge:AA-none');
  // off the list on the first answer, fixed by the one re-ask
  assert.equal(p.get('f-fix')!.label, 'acme/web');
  assert.equal(p.get('f-fix')!.rung, 'judge:AA+g');
  // still off the list after the re-ask → an abstention
  assert.equal(p.get('f-bad')!.label, null);
  assert.equal(p.get('f-bad')!.rung, 'judge:invalid');

  // questions: group = the case, guess = J's label, value = minutes × (1 − conf)
  assert.deepEqual(p.get('f-call#1')!.ask, { group: 'f-call', value: 1.95, guess: 'acme/web', form: 'confirm' });
  assert.deepEqual(p.get('f-bad')!.ask, { group: 'f-bad', value: 30, guess: null, form: 'choose' });

  // calls: a sonnet pass A and a haiku pass B per batch (2 batches: 4 cases + … ≤8 per call → 1 batch), one arbiter
  const first = calls.filter((c) => !c.prompt.includes('Your previous answer had problems') && !ARBITER.test(c.system));
  assert.deepEqual(first.map((c) => c.model).sort(), ['haiku', 'sonnet']);
  assert.equal(calls.filter((c) => ARBITER.test(c.system)).length, 1);
  assert.equal(calls.filter((c) => c.prompt.includes('Your previous answer had problems')).length, 2); // one re-ask per pass
  // pass B reads the same list in another order; every id is there in both
  const [sa, sb] = [first.find((c) => c.model === 'sonnet')!.system, first.find((c) => c.model === 'haiku')!.system];
  assert.notEqual(sa, sb);
  for (const id of ['acme/web', 'acme/app', 'globex/ops', 'none', 'unregistered']) assert.ok(sa.includes(`\n${id} | `) && sb.includes(`\n${id} | `));
  // the model never sees a store id
  for (const c of calls) assert.doesNotMatch(c.prompt, /f-call|f-rule|meeting:granola/);
  assert.match(p.get('f-call#1')!.why!, / · pv [0-9a-f]{10}$/);

  // every call's cost lands on the units it judged
  const spent = calls.reduce((a, c) => a + (ARBITER.test(c.system) ? 0.02 : 0.01), 0);
  const attributed = [...p.values()].reduce((a, x) => a + (x.costUsd ?? 0), 0);
  assert.ok(Math.abs(spent - attributed) < 1e-9, `spent ${spent} vs attributed ${attributed}`);
});

test('without a model J abstains on the residue and keeps the floor', async () => {
  const dir = tenantDir();
  const units = day1();
  const p = byId(await makeJudge(fixedFloor()).decide('t1-fragment', units, ctxOf(dir, D1, units, null)));
  assert.equal(p.get('f-rule')!.label, 'acme/web');
  for (const id of ['f-call#1', 'f-call#2', 'f-chat', 'f-fix', 'f-bad']) assert.deepEqual([p.get(id)!.label, p.get(id)!.rung], [null, 'judge:no-llm']);
});

test('sample=0 judges nothing (cost control) and says so per unit', async () => {
  const dir = tenantDir();
  const calls: Call[] = [];
  process.env.LAB_OPT_sample = '0';
  try {
    const units = day1();
    const p = byId(await makeJudge(fixedFloor()).decide('t1-fragment', units, ctxOf(dir, D1, units, cannedModel(calls))));
    assert.equal(calls.length, 0);
    assert.equal(p.get('f-call#1')!.rung, 'judge:sampled-out');
    assert.equal(p.get('f-rule')!.rung, 'rule:r1');
  } finally {
    delete process.env.LAB_OPT_sample;
  }
});

test('nightly: human answers (audits included) move the cells and become precedents; machine rows never do', async () => {
  const dir = tenantDir();
  const calibrations: { rows: MemoryRow[]; decided: Map<string, string> }[] = [];
  const v = makeJudge(fixedFloor(calibrations));
  const state = new Map<string, unknown>();
  const units = day1();
  await v.decide('t1-fragment', units, ctxOf(dir, D1, units, cannedModel([]), state));
  const rows: MemoryRow[] = [
    // one answer about the call: right on #1 (AA+g), wrong on #2 (AR) — one observation per cell
    { id: 'f-call#1', task: 't1-fragment', day: D1, label: 'acme/web', source: 'human', answer: 'q-call', predicted: 'acme/web', conf: 0.935, rung: 'judge:AA+g' },
    { id: 'f-call#2', task: 't1-fragment', day: D1, label: 'acme/web', source: 'human', answer: 'q-call', predicted: 'acme/app', conf: 0.7, rung: 'judge:AR' },
    // an audit of the floor's decision
    { id: 'f-rule', task: 't1-fragment', day: D1, label: 'acme/web', source: 'human', audit: true, answer: 'audit-1', predicted: 'acme/web', conf: 0.97, rung: 'rule:r1' },
    // the loop's own output: never evidence
    { id: 'f-chat', task: 't1-fragment', day: D1, label: 'none', source: 'machine', predicted: 'none', conf: 0.85, rung: 'judge:AA-none' },
  ];
  await v.nightly!('t1-fragment', ctxOf(dir, D1, units, cannedModel([]), state, rows));
  const st = judgeState(ctxOf(dir, D1, units, null, state), 't1-fragment');
  const table = Object.fromEntries(st.cells.table().map((c) => [`${c.kind}|${c.cell}`, [c.a, c.b]]));
  assert.deepEqual(table, { 'call|AA+g': [1, 0], 'call|AR': [0, 1] });
  assert.ok(st.cells.mean('call', 'AA+g') > 0.93);
  assert.ok(st.cells.mean('call', 'AR') < 0.7);
  assert.equal(st.pool.size, 3); // the human rows (answers + the audit), not the machine row
  assert.equal(calibrations.length, 1);
  assert.deepEqual(calibrations[0]!.rows.map((r) => r.id).sort(), ['f-call#1', 'f-call#2', 'f-rule']);
  assert.equal(calibrations[0]!.decided.get('f-rule'), 'rule:r1');

  // day 2: the same kind of call now sits on the measured cell, and pass A reads the precedent
  const calls: Call[] = [];
  const d2 = [frag('g-call#1', 'Acme Website checkout again pick:acme/web cite:"Acme Website checkout"', { day: D2, start: `${D2}T10:00:00Z`, end: `${D2}T11:00:00Z` })];
  const p2 = byId(await v.decide('t1-fragment', d2, ctxOf(dir, D2, d2, cannedModel(calls), state)));
  assert.equal(p2.get('g-call#1')!.rung, 'judge:AA+g');
  // one right answer lifts the cell, but one answer is not enough to cross τ: pooled (9.3+1)/11, call (10·.9364+1)/11,
  // + .005 because the top precedent agrees
  assert.equal(p2.get('g-call#1')!.conf, 0.9471);
  const a = calls.find((c) => c.model === 'sonnet')!;
  assert.match(a.prompt, /- \[acme\/web\] \(2026-01-05\) Acme sync — topic — Acme Website checkout/);
});

const item = (id: string, text: string, extra: Partial<ItemUnit> = {}): ItemUnit => ({
  id,
  day: D1,
  ts: `${D1}T09:00:00Z`,
  type: 'message',
  source: 'slack',
  account: 'T0',
  container: 'dm:@mara',
  thread: id,
  author: 'Mara Quill',
  authorPerson: 'mara',
  isBot: false,
  participants: [],
  toPersons: ['olive'],
  subject: null,
  text,
  keys: [],
  fromSubject: false,
  ...extra,
});

test('t4: kind by agreement and cue; the floor keeps what it decides; open bot posts are judged; the subject’s own are not', async () => {
  const dir = tenantDir();
  const units = [
    item('i-req', 'Could you check the export? kind:request cue:"Could you check"'),
    item('i-split', 'FYI the release is out kind:info kindB:noise addr:none'),
    item('i-bot', 'Build passed', { isBot: true, author: 'CIBot', authorPerson: null }),
    item('i-alert', 'FIRING: checkout error rate high kind:incident cue:"checkout error"', { isBot: true, author: 'AlertBot', authorPerson: null }),
    item('i-mine', 'I will send it kind:commitment', { fromSubject: true, authorPerson: 'olive' }),
    item('i-ask', 'Mara, when is the demo? kind:question addr:mara addrB:olive'),
  ];
  const v = makeJudge(fixedFloor());
  // Both t4 passes are haiku by default; pass A on sonnet lets the canned model tell the two framings apart.
  process.env.LAB_OPT_modelA = 'sonnet';
  let k: Map<string, Prediction>;
  let a: Map<string, Prediction>;
  try {
    k = byId(await v.decide('t4-kind', units, ctxOf(dir, D1, units, cannedModel([]))));
    a = byId(await v.decide('t4-addressee', units, ctxOf(dir, D1, units, cannedModel([]))));
  } finally {
    delete process.env.LAB_OPT_modelA;
  }
  assert.deepEqual([k.get('i-req')!.label, k.get('i-req')!.rung, k.get('i-req')!.conf], ['request', 'judge:AA+g', 0.93]);
  assert.deepEqual([k.get('i-split')!.label, k.get('i-split')!.rung], ['info', 'judge:XX']);
  assert.deepEqual([k.get('i-bot')!.label, k.get('i-bot')!.rung], ['noise', 'sender:bot']);
  // a bot post the floor leaves under τ (a firing alert at .90) is judged like any other incoming item
  assert.deepEqual([k.get('i-alert')!.label, k.get('i-alert')!.rung], ['incident', 'judge:AA+g']);
  assert.deepEqual([k.get('i-mine')!.label, k.get('i-mine')!.rung], [null, 'judge:not-incoming']);
  assert.equal(k.get('i-ask')!.rung, 'judge:AA'); // both say question, but no cue was cited → not grounded
  assert.deepEqual([a.get('i-split')!.label, a.get('i-split')!.rung], ['none', 'judge:AA-none']);
  assert.deepEqual([a.get('i-ask')!.label, a.get('i-ask')!.rung], ['mara', 'judge:XX']);
});

test('t3: forms seen twice are judged once; only "system" may reach τ', async () => {
  const dir = tenantDir();
  const m = (id: string, raw: string, seen: number): MentionUnit => ({ id, day: D1, raw, field: 'author', source: 'slack', ref: `slack:T0:${id}`, seen, context: {}, production: null });
  const units = [m('m1', 'DeployBot', 3), m('m2', 'Mara Q', 2), m('m3', 'mara q', 2), m('m4', 'Zed', 1)];
  const calls: Call[] = [];
  const p = byId(await makeJudge(fixedFloor()).decide('t3-identity', units, ctxOf(dir, D1, units, cannedModel(calls))));
  assert.deepEqual([p.get('m1')!.label, p.get('m1')!.rung, p.get('m1')!.conf], ['system', 'judge:AA-sys', 0.93]);
  // A says mara, B says mara too ("Mara" prefix) → AA-person, held under τ (people exact)
  assert.equal(p.get('m2')!.label, 'mara');
  assert.ok(p.get('m2')!.conf < 0.95);
  assert.equal(p.get('m3')!.label, 'mara'); // the same folded form: one judgment fanned out
  assert.equal(p.get('m4')!.rung, 'judge:once');
  assert.equal(calls.filter((c) => !c.prompt.includes('problems')).length, 2); // one batch, two passes
});

test('t3 form memo: an answered surface form resolves its later occurrences; a machine row does not', async () => {
  const dir = tenantDir();
  const v = makeJudge(fixedFloor());
  const state = new Map<string, unknown>();
  const m = (id: string, raw: string, day: string): MentionUnit => ({ id, day, raw, field: 'attendee', source: 'gmeet', ref: `meeting:gmeet:${id}`, seen: 1, context: {}, production: null });
  const d1 = [m('m-zed', 'Zed Example', D1), m('m-yo', 'Yo Example', D1)];
  await v.decide('t3-identity', d1, ctxOf(dir, D1, d1, null, state));
  const rows: MemoryRow[] = [
    { id: 'm-zed', task: 't3-identity', day: D1, label: 'unknown', source: 'human', answer: 'q-zed' },
    { id: 'm-yo', task: 't3-identity', day: D1, label: 'mara', source: 'machine' },
  ];
  await v.nightly!('t3-identity', ctxOf(dir, D1, d1, null, state, rows));
  const d2 = [m('m-zed2', 'zed  example', D2), m('m-yo2', 'Yo Example', D2)];
  const p = byId(await v.decide('t3-identity', d2, ctxOf(dir, D2, d2, null, state)));
  assert.deepEqual([p.get('m-zed2')!.label, p.get('m-zed2')!.rung], ['unknown', 'memo:form']);
  assert.equal(p.get('m-yo2')!.label, null);
});

test('t1-item: a bot family is judged once and fanned out; every unit gets a prediction', async () => {
  const dir = tenantDir();
  const units = [
    item('b1', 'status.globex.example is down pick:globex/ops', { isBot: true, author: 'StatusBot', authorPerson: null, container: '#alerts', ts: `${D1}T08:00:00Z` }),
    item('b2', 'status.globex.example is down pick:globex/ops', { isBot: true, author: 'StatusBot', authorPerson: null, container: '#alerts', ts: `${D1}T08:05:00Z` }),
    item('h1', 'Can we move the Acme Website launch? pick:acme/web cite:"Acme Website launch"'),
  ];
  const calls: Call[] = [];
  const p = byId(await makeJudge(fixedFloor()).decide('t1-item', units, ctxOf(dir, D1, units, cannedModel(calls))));
  assert.equal(p.get('b1')!.label, 'globex/ops');
  assert.equal(p.get('b2')!.label, 'globex/ops');
  assert.equal(p.get('b1')!.ask!.group, `family:fam:StatusBot:${D1}`);
  assert.equal(p.get('h1')!.rung, 'judge:AA+g');
  const prompt = calls.find((c) => c.model === 'haiku')!.prompt;
  assert.equal((prompt.match(/status\.globex\.example is down/g) ?? []).length, 1); // one representative
});

test('the variant does every task and decides t2 from the floor', async () => {
  const v = makeJudge(fixedFloor());
  const tasks: TaskId[] = ['t1-fragment', 't1-item', 't2-dedup', 't3-identity', 't4-kind', 't4-addressee'];
  assert.deepEqual(v.tasks, tasks);
  const units = [item('x1', 'a'), item('x2', 'b')];
  const p = await v.decide('t2-dedup', units, ctxOf(tenantDir(), D1, units, null));
  assert.deepEqual(p.map((x) => [x.id, x.label, x.rung]), [['x1', 'x1', 'floor:dedup'], ['x2', 'x2', 'floor:dedup']]);
});

test('stable batches: removing one unit changes only its own batch (the call cache survives a moving floor)', () => {
  const ids = Array.from({ length: 300 }, (_, i) => `unit-${i}`);
  const before = stableBatches(ids, (x) => x, 25);
  assert.deepEqual(before.flat(), ids);
  assert.ok(before.every((b) => b.length <= 75));
  assert.ok(before.length >= 6 && before.length <= 24, `${before.length} batches`);
  const gone = before[3]![0]!;
  const after = stableBatches(ids.filter((x) => x !== gone), (x) => x, 25);
  const key = (bs: string[][]) => new Set(bs.map((b) => b.join(',')));
  const kept = [...key(before)].filter((b) => key(after).has(b));
  assert.equal(kept.length, before.length - 1);
});
