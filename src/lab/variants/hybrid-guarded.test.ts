// hybrid-g end to end over the hybrid test's fictional tenant: Acme Bikes runs an online shop and an ERP sync
// (siblings; the `AC` tracker prefix routes to the shop only), Beta Health one app (`BT`). The floor is a stand-in for
// stage 0 with stage 0's rung calibration (t4: a bot's item is noise at .90, a sender rung under τ); the model is CANNED —
// both passes answer a unit by the marker word in its text (Q1 …, K0 …). Every unit has its own author and thread, so
// the spine learns no sender or thread key from the answers and stays silent where it was silent. No claude anywhere.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadDataset, saveMeta, writeJsonl } from '../dataset.js';
import { wilson } from '../metrics.js';
import { runTask } from '../run.js';
import type { DatasetMeta, DayCtx, ItemUnit, LlmLike, MemoryRow, Prediction, TaskId, Unit, Variant } from '../types.js';
import { guardState, makeHybridG } from './hybrid-guarded.js';
import { hybridState, makeHybrid } from './hybrid.js';
import { GuardCells, guardCell, pickProbes, rungFamily, sharedClient } from './hybrid/guard.js';
import { merge, PROBE_VALUE } from './hybrid/merge.js';
import { PRIOR_MEAN } from './judge/cells.js';
import { Calibration, type Said } from './stage0/calibrate.js';
import type { Floor, Stage0 } from './stage0/index.js';

const D1 = '2026-01-05';
const dayN = (i: number): string => new Date(Date.parse(`${D1}T00:00:00Z`) + i * 86_400_000).toISOString().slice(0, 10);
const TAU = 0.95;

const META: DatasetMeta = {
  name: 'hybrid-g-bench',
  kind: 'synthetic',
  tenant: 'agency',
  tz: 'UTC',
  since: D1,
  until: dayN(13),
  subject: 'owner',
  createdAt: '2026-01-20T00:00:00Z',
  sourceStore: 'test fixture',
  labelSpace: { initiatives: ['acme/shop', 'acme/erp-sync', 'acme/admin', 'beta/app'], umbrellas: { 'acme/shop': 'acme', 'acme/erp-sync': 'acme', 'acme/admin': 'acme', 'beta/app': 'beta' }, people: ['owner'] },
  counts: {},
};

function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'hybrid-g-'));
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

// Every unit its own author and thread: no sender/thread key the spine could learn across units.
const item = (id: string, day: string, text: string, extra: Partial<ItemUnit> = {}): ItemUnit => ({
  id,
  day,
  ts: `${day}T09:00:00Z`,
  type: 'comment',
  source: 'youtrack',
  account: 'agency',
  container: null,
  thread: id,
  author: `${id}@crew.example`,
  authorPerson: null,
  isBot: false,
  participants: [],
  toPersons: [],
  subject: null,
  text,
  keys: [...text.matchAll(/\b[A-Z]{2}-\d+\b/g)].map((m) => m[0]),
  ...extra,
});

// Stage 0's stand-in: AC → the shop, BT → the app (.97, the text-key rung) with stage 0's rung-instance calibration;
// t4: a bot's item is noise at .90 (a sender rung under τ — the spine's residue), a person's item is open.
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
    kind: (u) => (u.isBot ? { label: 'noise', conf: 0.9, rung: 'sender:bot', candidates: [], hint: '', case: `thread:${u.thread}` } : open(`thread:${u.thread}`)),
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
  Q1: { label: 'acme/erp-sync', cite: 'stock sync' }, // grounded when the text carries "stock sync"
  Q2: { label: 'acme/shop' }, // no cite: AA
  Q3: { label: 'none' },
  K0: { label: '', kind: 'noise' },
  K1: { label: '', kind: 'request' },
};

function cannedModel(): LlmLike {
  return {
    async call(c) {
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

interface Run {
  v: Variant;
  state: Map<string, unknown>;
  memory: MemoryRow[];
  dir: string;
}
const newRun = (v: Variant, dir = fixture()): Run => ({ v, state: new Map(), memory: [], dir });
const G = (o: Parameters<typeof makeHybridG>[0] = {}): Variant => makeHybridG({ floor: fakeFloor, ...o });
const llm = cannedModel();
const ctxOf = (r: Run, day: string, pool: Unit[]): DayCtx => ({ dataset: META, dir: r.dir, day, pool, memory: r.memory.slice(), state: r.state, llm, log: () => {} });
async function decide(r: Run, day: string, units: Unit[], task: TaskId = 't1-item'): Promise<Map<string, Prediction>> {
  return new Map((await r.v.decide(task, units, ctxOf(r, day, units))).map((p) => [p.id, p]));
}
async function nightly(r: Run, day: string, rows: Omit<MemoryRow, 'task' | 'day'>[], task: TaskId = 't1-item'): Promise<void> {
  r.memory.push(...rows.map((x) => ({ ...x, task, day })));
  await r.v.nightly!(task, ctxOf(r, day, []));
}
const guard = (r: Run, task: TaskId = 't1-item') => guardState({ state: hybridState(r).guard! }, task);
const auto = (p: Prediction | undefined): boolean => !!p && p.label !== null && p.conf >= TAU;
const said = (p: Prediction) => ({ predicted: p.label ?? p.ask?.guess ?? null, conf: p.conf, rung: p.rung });
/** The person answers every question of the day with `truth`, as the runner would: one row per unit, the group's id. */
const answers = (day: string, ps: Iterable<Prediction>, truth: (id: string) => string): Omit<MemoryRow, 'task' | 'day'>[] =>
  [...ps].filter((p) => p.ask).map((p) => ({ id: p.id, label: truth(p.id), source: 'human' as const, answer: `${day}:${p.ask!.group}`, ...said(p) }));

test('guard cells: J’s cell × its relation to the spine; an agree cell’s prior is the spine rung’s calibrated precision, the others J’s priors', () => {
  const held = { label: 'acme/shop', conf: 0.85, rung: 'held:key:AC' };
  assert.deepEqual(guardCell('item-human', 'AA+g', 'acme/shop', held), { key: 'item-human|AA+g|agree:held', relation: 'agree', prior: 0.85 });
  assert.deepEqual(guardCell('item-human', 'AA+g', 'acme/erp-sync', held), { key: 'item-human|AA+g|contradict', relation: 'contradict', prior: PRIOR_MEAN['AA+g'] });
  assert.deepEqual(guardCell('item-human', 'AA', 'acme/shop', null), { key: 'item-human|AA|silent', relation: 'silent', prior: PRIOR_MEAN.AA });
  assert.deepEqual(guardCell('t4', 'AA', 'noise', { label: 'noise', conf: 0.9, rung: 'sender:bot' }), { key: 't4|AA|agree:sender', relation: 'agree', prior: 0.9 });
  assert.deepEqual(['sib:key:AC', 'admin', 'container=#ops', 'guess:thread'].map(rungFamily), ['sib', 'admin', 'container', 'guess']);
});

test('the right to decide: Wilson lower bound of prior + random checks ≥ τ — at the defaults 90 straight right checks on a .93 prior; one wrong takes it back', () => {
  const c = new GuardCells(); // z 1.96, prior strength 10 (J's)
  const k = 'item-human|AA+g|silent';
  assert.ok(Math.abs(c.lower(k, 0.93) - wilson(9.3, 10).lo) < 1e-12, 'no evidence: the prior alone');
  for (let i = 0; i < 89; i++) c.observe(k, true);
  assert.ok(c.lower(k, 0.93) < TAU, '89 right checks are not enough');
  c.observe(k, true);
  assert.ok(c.lower(k, 0.93) >= TAU, '90 are');
  c.observe(k, false);
  assert.ok(c.lower(k, 0.93) < TAU, 'one wrong check takes the right back');
  assert.deepEqual(c.evidence(k), { right: 90, n: 91 });
  // an agree cell on the spine's .60 sibling guess cannot reach τ from where it starts: never probed
  assert.ok(new GuardCells().upper('x', 0.6) < TAU && new GuardCells().upper('x', 0.85) >= TAU);
});

test('probes: one per not-yet-earned cell, the least-probed cell first; a cell whose evidence rules τ out is not probed', () => {
  const cells = new GuardCells();
  const cands = [
    { id: 'a1', key: 'A', prior: 0.93 },
    { id: 'a2', key: 'A', prior: 0.93 },
    { id: 'b1', key: 'B', prior: 0.85 },
    { id: 'c1', key: 'C', prior: 0.6 },
  ];
  const first = pickProbes(cands, cells, 1, D1, TAU);
  assert.deepEqual(first.map((p) => p.key), ['A'], 'nobody probed yet: the cell with more candidates today');
  cells.noteProbe('A');
  assert.deepEqual(pickProbes(cands, cells, 1, dayN(1), TAU).map((p) => p.key), ['B'], 'rotation: the least-probed cell');
  assert.deepEqual(pickProbes(cands, cells, 5, dayN(1), TAU).map((p) => p.key), ['B', 'A'], 'one per cell; C (prior .60) is ruled out');
  assert.deepEqual(pickProbes(cands, cells, 0, dayN(1), TAU), []);
  cells.observe('B', false);
  cells.observe('B', false);
  assert.deepEqual(pickProbes(cands, cells, 5, dayN(1), TAU).map((p) => p.key), ['A'], 'two wrong checks rule a .85 cell out');
});

test('merge with a guard: J decides only where the guard says, at its confidence; a probe is its own question at the top; client agreement → client-day', () => {
  const P = (id: string, label: string | null, conf: number, rung: string, extra: Partial<Prediction> = {}): Prediction => ({ id, label, conf, rung, ...extra });
  const by = (ps: Prediction[]) => new Map(ps.map((p) => [p.id, p]));
  const spine = [P('e', null, 0, 'abstain'), P('h', null, 0, 'abstain'), P('p', null, 0, 'abstain'), P('c', 'acme/shop', 0.8, 'guess:sender', { ask: { group: 'sender=x', value: 0.2, guess: 'acme/shop', form: 'confirm' } })];
  const judge = [
    P('e', 'acme/shop', 0.9, 'judge:AA', { ask: { group: 't:e', value: 0.1 } }),
    P('h', 'acme/shop', 0.97, 'judge:AA+g', { ask: { group: 't:h', value: 0.03 } }),
    P('p', 'acme/erp-sync', 0.97, 'judge:AA+g', { ask: { group: 't:p', value: 0.03 } }),
    P('c', 'acme/erp-sync', 0.9, 'judge:AA', { ask: { group: 't:c', value: 0.1 } }),
  ];
  const decideHook = (_s: Prediction | undefined, j: Prediction) => (j.id === 'e' ? { conf: 0.9612, why: 'guard x 90/90 lb 0.961' } : null);
  const clientAgree = (s: Prediction | undefined, j: Prediction) => sharedClient(s?.label, j.label, (l) => l.split('/')[0]!);
  const { preds, stats } = merge(['e', 'h', 'p', 'c'], by(spine), by(judge), { day: D1, tau: TAU, weight: () => 1, decide: decideHook, probes: new Set(['p']), clientAgree });
  const m = by(preds);
  assert.deepEqual([m.get('e')!.label, m.get('e')!.conf, m.get('e')!.ask], ['acme/shop', 0.9612, undefined], 'earned: decided at the guard’s confidence, J’s own .90 aside');
  assert.match(m.get('e')!.why!, /guard x 90\/90 lb 0\.961/);
  assert.deepEqual([m.get('h')!.conf, m.get('h')!.ask?.guess, m.get('h')!.ask?.form], [0.949, 'acme/shop', 'confirm'], 'J at .97 without the right: the confirm question’s guess');
  assert.deepEqual([m.get('p')!.ask?.group, m.get('p')!.ask?.guess, m.get('p')!.ask?.form], ['probe:p', 'acme/erp-sync', 'confirm']);
  assert.ok(m.get('p')!.ask!.value! >= PROBE_VALUE && m.get('p')!.conf < TAU);
  assert.deepEqual([m.get('c')!.ask?.group, m.get('c')!.ask?.guess, m.get('c')!.label], [`umb:acme:${D1}`, 'acme/erp-sync', 'acme/erp-sync'], 'spine the shop, J the sync: one Acme question for the day');
  assert.deepEqual([stats.judge, stats.gated, stats.probed, stats.clientAgree, stats.splitUmbrella], [1, 1, 1, 1, 0]);
  assert.equal(sharedClient('acme/shop', 'beta/app', (l) => l.split('/')[0]!), null, 'two clients: no client-day question');
  assert.equal(sharedClient('acme/shop', 'acme/shop', (l) => l.split('/')[0]!), null, 'the same initiative: nothing to ask about the client');
});

test('agree cell prior from the spine: J naming the spine’s held X starts at the spine’s .85, its sibling guess at .60; silent and contradict at J’s priors; t4 agrees with the floor’s sender rung', async () => {
  const r = newRun(G());
  const units = [
    item('h1', D1, 'AC-12: what is the status? Q2'), // spine: the shop held at .85 (siblings, no cue) · J: the shop (AA)
    item('s1', D1, 'AC-13: stock sync lags behind Q1'), // spine: a cue of the sync only → the sync at .60 · J: the sync (AA+g)
    item('c1', D1, 'AC-14: what is the status? Q1'), // spine: the shop held at .85 · J: the sync (no grounded cite: AA)
    item('n1', D1, 'Lunch on Friday? Q3'), // spine: nothing · J: none
  ];
  const d = await decide(r, D1, units);
  const gs = guard(r);
  const cell = (id: string) => (({ key, prior }) => ({ key, prior }))(gs.today.get(id)!);
  assert.deepEqual(cell('h1'), { key: 'item-human|AA|agree:held', prior: 0.85 });
  assert.deepEqual(cell('s1'), { key: 'item-human|AA+g|agree:sib', prior: 0.6 });
  assert.deepEqual(cell('c1'), { key: 'item-human|AA|contradict', prior: PRIOR_MEAN.AA });
  assert.deepEqual(cell('n1'), { key: 'item-human|AA-none|silent', prior: PRIOR_MEAN['AA-none'] });
  assert.ok(Math.abs(gs.today.get('h1')!.lb - wilson(8.5, 10).lo) < 1e-12, 'the agree cell’s bound starts from the spine’s precision');
  for (const u of units) assert.ok(!auto(d.get(u.id)), `${u.id}: nothing earned on day one`);
  // J's labels are the questions' guesses; the three Acme tickets are one client-day question (the sync weighs more)
  assert.deepEqual([d.get('h1')!.label, d.get('h1')!.ask?.group, d.get('h1')!.ask?.guess, d.get('h1')!.ask?.form], ['acme/shop', `umb:acme:${D1}`, 'acme/erp-sync', 'confirm']);

  // t4-kind: the floor's own rung label is what J agrees with (the bot's sender rung at .90)
  const t = newRun(G());
  const t4 = [item('k0', D1, 'Nightly build finished K0', { isBot: true, author: 'Build Bot' }), item('k1', D1, 'Could you send the invoice K1')];
  await decide(t, D1, t4, 't4-kind');
  const g4 = guard(t, 't4-kind');
  assert.deepEqual([g4.today.get('k0')!.key, g4.today.get('k0')!.prior], ['t4|AA|agree:sender', 0.9]);
  assert.deepEqual([g4.today.get('k1')!.key, g4.today.get('k1')!.prior], ['t4|AA|silent', PRIOR_MEAN.AA]);
});

test('a cell decides only once its Wilson lower bound over RANDOM checks reaches τ — not before, whatever J’s own confidence says', async () => {
  // z .5 and no prior pseudo-counts so that five right probes earn the right: wilson(5, 5, .5).lo = .952 ≥ τ > .941 = 4/4
  const r = newRun(G({ z: 0.5, priorN: 0, probes: 1 }));
  const KEY = 'item-human|AA+g|silent';
  const earnedOn: number[] = [];
  let gatedSeen = false;
  for (let i = 0; i < 7; i++) {
    const day = dayN(i);
    const units = [0, 1, 2].map((k) => item(`u${i}${k}`, day, `Stock sync lags again Q1`));
    const d = await decide(r, day, units);
    const gs = guard(r);
    const lb = gs.cells.lower(KEY, PRIOR_MEAN['AA+g']);
    const decided = units.filter((u) => auto(d.get(u.id)));
    assert.equal(decided.length, lb >= TAU ? 3 : 0, `day ${i}: J decides exactly when the bound holds (lb ${lb.toFixed(3)})`);
    if (decided.length) {
      earnedOn.push(i);
      for (const u of units) assert.match(d.get(u.id)!.why!, new RegExp(`guard ${KEY.replace(/[|+]/g, '\\$&')} \\d+/\\d+ lb 0\\.9`));
      assert.ok(d.get(units[0]!.id)!.conf >= TAU && d.get(units[0]!.id)!.conf <= lb);
    } else {
      // J's own cell climbs on the answers (ordinary ones included) and passes τ — held just under it, a confirm question
      if (units.some((u) => /gated 0\.9[5-9]/.test(d.get(u.id)!.why ?? ''))) gatedSeen = true;
      const probes = units.filter((u) => d.get(u.id)!.ask?.group === `probe:${u.id}`);
      assert.equal(probes.length, 1, `day ${i}: one probe`);
    }
    await nightly(r, day, answers(day, d.values(), () => 'acme/erp-sync'));
  }
  assert.ok(gatedSeen, 'J’s own confidence crossed τ before the guard let it decide');
  assert.deepEqual(earnedOn, [5, 6], 'five right probes (days 0–4) earn the right on day 5');
  assert.deepEqual(guard(r).cells.evidence(KEY), { right: 5, n: 5 }, 'the ordinary answers of the same days never counted');
});

test('ordinary answers never move the right to decide: a week of right answers, no probes — the unguarded hybrid decides, hybrid-g does not', async () => {
  const dir = fixture();
  const g = newRun(G({ z: 0.5, priorN: 0, probes: 0 }), dir);
  const h = newRun(makeHybrid({ floor: fakeFloor }), dir);
  let hybridDecided = 0;
  for (let i = 0; i < 6; i++) {
    const day = dayN(i);
    const units = [0, 1, 2].map((k) => item(`o${i}${k}`, day, `Stock sync lags again Q1`));
    const dg = await decide(g, day, units);
    const dh = await decide(h, day, units);
    assert.ok(units.every((u) => !auto(dg.get(u.id))), `day ${i}: hybrid-g asks`);
    hybridDecided += units.filter((u) => auto(dh.get(u.id))).length;
    await nightly(g, day, answers(day, dg.values(), () => 'acme/erp-sync'));
    await nightly(h, day, answers(day, dh.values(), () => 'acme/erp-sync'));
  }
  assert.ok(hybridDecided > 0, 'J’s own cell crossed τ on ordinary answers: the hybrid decides');
  assert.deepEqual(guard(g).cells.evidence('item-human|AA+g|silent'), { right: 0, n: 0 });
  assert.equal(guard(g).totals.probes, 0);
});

test('probes are asked and counted: a one-unit confirm at the top of the queue; its answer — right or wrong — is the cell’s random check, an ordinary answer is not', async () => {
  const r = newRun(G({ probes: 1 })); // the defaults: z 1.96, prior strength 10
  const SYNC = 'item-human|AA+g|silent';
  const NONE = 'item-human|AA-none|silent';
  const day0 = [item('a1', D1, 'Stock sync stalls Q1'), item('a2', D1, 'Stock sync retry Q1'), item('b1', D1, 'Lunch on Friday? Q3')];
  const d0 = await decide(r, D1, day0);
  const probe0 = day0.find((u) => d0.get(u.id)!.ask?.group === `probe:${u.id}`)!;
  assert.ok(probe0.id.startsWith('a'), 'the cell with more candidates first');
  const p0 = d0.get(probe0.id)!;
  assert.deepEqual([p0.label, p0.ask?.guess, p0.ask?.form], ['acme/erp-sync', 'acme/erp-sync', 'confirm']);
  assert.ok(p0.ask!.value! >= PROBE_VALUE && p0.conf < TAU);
  // the person says the probe is the shop (J wrong); the other sync ticket, answered as an ordinary question, is right
  await nightly(r, D1, answers(D1, d0.values(), (id) => (id === probe0.id ? 'acme/shop' : id === 'b1' ? 'none' : 'acme/erp-sync')));
  assert.deepEqual(guard(r).cells.evidence(SYNC), { right: 0, n: 1 }, 'the probe counted wrong; the ordinary answer not at all');
  assert.deepEqual(guard(r).cells.evidence(NONE), { right: 0, n: 0 });

  const D2 = dayN(1);
  const day1 = [item('a3', D2, 'Stock sync stalls Q1'), item('a4', D2, 'Stock sync retry Q1'), item('b2', D2, 'Lunch on Monday? Q3')];
  const d1 = await decide(r, D2, day1);
  assert.equal(d1.get('b2')!.ask?.group, 'probe:b2', 'rotation: the cell not probed yet');
  await nightly(r, D2, answers(D2, d1.values(), (id) => (id === 'b2' ? 'none' : 'acme/erp-sync')));
  assert.deepEqual(guard(r).cells.evidence(NONE), { right: 1, n: 1 });
  assert.deepEqual(guard(r).totals, { decided: 0, probes: 2, probeAnswers: 2, probeRight: 1, audits: 0, auditRight: 0 });
  // an unanswered probe is asked but never counted
  const D3 = dayN(2);
  const d2 = await decide(r, D3, [item('a5', D3, 'Stock sync stalls Q1')]);
  assert.equal(d2.get('a5')!.ask?.group, 'probe:a5');
  await nightly(r, D3, []);
  assert.deepEqual(guard(r).cells.evidence(SYNC), { right: 0, n: 1 });
});

test('an audit of a J decision is a random check too: a wrong one takes the right back the next day', async () => {
  const r = newRun(G({ z: 0.5, priorN: 0, probes: 1 }));
  const KEY = 'item-human|AA+g|silent';
  let d = new Map<string, Prediction>();
  let units: ItemUnit[] = [];
  for (let i = 0; i < 6; i++) {
    const day = dayN(i);
    units = [0, 1].map((k) => item(`w${i}${k}`, day, `Stock sync lags again Q1`));
    d = await decide(r, day, units);
    if (i < 5) await nightly(r, day, answers(day, d.values(), () => 'acme/erp-sync'));
  }
  assert.ok(units.every((u) => auto(d.get(u.id))), 'earned on day 5');
  assert.equal(guard(r).decided.size, 2);
  // the day's audit finds one of J's decisions wrong
  const audited = d.get(units[0]!.id)!;
  await nightly(r, dayN(5), [{ id: audited.id, label: 'acme/shop', source: 'human', audit: true, answer: `${dayN(5)}:audit:${audited.id}`, ...said(audited) }]);
  assert.deepEqual(guard(r).cells.evidence(KEY), { right: 5, n: 6 });
  const next = [item('w60', dayN(6), 'Stock sync lags again Q1')];
  const d6 = await decide(r, dayN(6), next);
  assert.ok(!auto(d6.get('w60')), 'the right is gone');
  assert.equal(d6.get('w60')!.ask?.guess, 'acme/erp-sync');
});

test('the runner: machine rows (memory loop, machineWeight=1) never move hybrid-g — it replays exactly like memory none; probes and audits included', async () => {
  const dir = fixture();
  const days = [0, 1, 2, 3].map(dayN);
  const units = days.flatMap((day, i) => [
    item(`r${i}a`, day, 'Stock sync stalls Q1'),
    item(`r${i}b`, day, 'Stock sync retry Q1'),
    item(`r${i}c`, day, `AC-${20 + i}: checkout fails in the shop`),
    item(`r${i}d`, day, 'Lunch on Friday? Q3'),
  ]);
  const gold: Record<string, string> = Object.fromEntries(units.map((u) => [u.id, u.id.endsWith('c') ? 'acme/shop' : u.id.endsWith('d') ? 'none' : 'acme/erp-sync']));
  saveMeta(dir, { ...META, counts: { item: units.length } });
  writeJsonl(join(dir, 'units', 'item.jsonl'), units);
  writeJsonl(
    join(dir, 'gold', 't1-item.jsonl'),
    units.map((u) => ({ id: u.id, task: 't1-item', label: gold[u.id], tier: 'synthetic' })),
  );
  const ds = loadDataset(dir);
  const run = (memory: 'none' | 'loop') => runTask(ds, G({ z: 0.5, priorN: 0 }), 't1-item', { mode: 'replay', memory, questionsPerDay: 3, auditShare: 0.5, llm: cannedModel(), runName: `hybrid-g-${memory}`, log: () => {}, labDir: dir });
  process.env.LAB_OPT_machineWeight = '1';
  try {
    const none = await run('none');
    const loop = await run('loop');
    const view = (p: Prediction) => ({ label: p.label, conf: p.conf, rung: p.rung, ask: p.ask });
    assert.deepEqual(loop.predictions.map(view), none.predictions.map(view));
    assert.deepEqual(loop.answered, none.answered);
    assert.deepEqual(loop.audited, none.audited);
    assert.ok(none.predictions.some((p) => p.ask?.group?.startsWith('probe:')), 'probes were asked');
    assert.ok(none.perDay.some((d) => d.decided > 0), 'something was decided (the spine’s key at least)');
  } finally {
    delete process.env.LAB_OPT_machineWeight;
  }
});

test('the hybrid without a guard keeps no guard state (its defaults are the iteration-3 hybrid’s)', async () => {
  const r = newRun(makeHybrid({ floor: fakeFloor }));
  await decide(r, D1, [item('z1', D1, 'Stock sync stalls Q1')]);
  await nightly(r, D1, []);
  assert.equal(hybridState(r).guard, undefined);
});
