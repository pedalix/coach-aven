// The learning loop end to end (learn.ts) on a fictional agency: evidence only, one answer = one observation, the replay
// and its trials, demotion of a contradicted rung instance, sibling-aware trust with its client-day questions and the
// route's repair, grouping and ranking, a seeded audit sample, rule candidates.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { learn, type Evidence, type InitiativeInfo, type LearnOpts, type LearnUnit } from './learn.js';

const TODAY = '2026-03-10';
const INI: InitiativeInfo[] = [
  { id: 'acme/shop', umbrella: 'acme', company: 'acme', active: true, cues: ['Online shop', 'checkout', 'key:AC', '#ext-acme'] },
  { id: 'acme/sync', umbrella: 'acme', company: 'acme', active: true, cues: ['ERP stock sync'] },
  { id: 'acme/admin', umbrella: 'acme', company: 'acme', active: true, cues: [], admin: true },
  { id: 'globex/portal', umbrella: 'globex', company: 'globex', active: true, cues: ['portal', 'key:GP'] },
  { id: 'globex/admin', umbrella: 'globex', company: 'globex', active: true, cues: [] },
];
const OPTS = (over: Partial<LearnOpts> = {}): LearnOpts => ({ tau: 0.95, today: TODAY, questionsPerDay: 3, auditShare: 0.15, seed: 'acme', initiatives: INI, siblingAware: true, ...over });
const unit = (id: string, over: Partial<LearnUnit> = {}): LearnUnit => ({ id, unit: 'item', day: TODAY, label: null, conf: 0, rung: 'abstain', structural: false, candidates: [], caseKey: `thread:${id}`, keys: {}, ...over });
const ans = (id: string, label: string, answer: string, day = '2026-03-09', over: Partial<Evidence> = {}): Evidence => ({ id, day, label, source: 'human', answer, ...over });
const ac = (id: string, text: string, over: Partial<LearnUnit> = {}): LearnUnit => unit(id, { label: 'acme/shop', conf: 0.98, rung: 'key:AC', structural: true, text, ...over });
const of = (r: ReturnType<typeof learn>, id: string) => r.units.find((u) => u.id === id)!;

test('evidence only: twenty floor decisions teach a key nothing — one answer from a person does; machine rows are dropped', () => {
  const fam = { family: 'uptime|<n> down|portal.globex.example' };
  const decided = Array.from({ length: 20 }, (_, i) => unit(`d${i}`, { day: '2026-03-09', label: 'globex/portal', conf: 0.99, rung: 'host:portal.globex.example', keys: fam }));
  const open = unit('open', { keys: fam });
  let r = learn([...decided, open], [], OPTS());
  assert.deepEqual([of(r, 'open').label, of(r, 'open').conf], [null, 0], 'the floor’s own labels are not evidence');
  const smuggled = { id: 'd1', day: '2026-03-09', label: 'globex/portal', source: 'machine', answer: 'auto-1' } as unknown as Evidence;
  r = learn([...decided, open], [smuggled], OPTS());
  assert.equal(of(r, 'open').label, null);
  assert.equal(r.stats!.evidence, 0, 'a machine row is no evidence, however it got in');
  r = learn([...decided, open], [ans('d1', 'globex/portal', 'q1')], OPTS());
  assert.deepEqual([of(r, 'open').label, of(r, 'open').rung], ['globex/portal', 'earned:family']);
  assert.ok(of(r, 'open').conf >= 0.95);
});

test('one answer is one observation: twelve units answered together do not make a channel speak, a second answer does', () => {
  const chan = { container: 'C0ACMEWEB1' };
  const group = Array.from({ length: 12 }, (_, i) => unit(`m${i}`, { day: '2026-03-08', keys: chan }));
  const later = unit('later', { keys: chan });
  const ev = group.map((u) => ans(u.id, 'acme/shop', 'q-0308', '2026-03-08'));
  let r = learn([...group, later], ev, OPTS());
  assert.equal(of(r, 'later').label, null, 'a container needs k = 2 independent answers');
  assert.equal(r.stats!.answers, 1);
  const m12 = unit('m12', { day: '2026-03-09', keys: chan });
  r = learn([...group, m12, later], [...ev, ans('m12', 'acme/shop', 'q-0309')], OPTS());
  assert.deepEqual([of(r, 'later').label, of(r, 'later').rung], ['acme/shop', 'guess:container']);
  assert.ok(of(r, 'later').conf < 0.95, 'consistent, but a channel is only .80 sure: a guess, i.e. a question');
});

test('the replay: a key that predicted a unit before its answer gets a trial; an answered unit shows what the loop said before', () => {
  const fam = { family: 'deploy|<n> deployed|acme-api' };
  const a = unit('a', { day: '2026-03-08', keys: fam });
  const b = unit('b', { day: '2026-03-09', keys: fam });
  const c = unit('c', { keys: fam });
  const r = learn([a, b, c], [ans('a', 'acme/shop', 'q1', '2026-03-08'), ans('b', 'acme/sync', 'q2', '2026-03-09')], OPTS());
  assert.deepEqual([of(r, 'b').label, of(r, 'b').rung, of(r, 'b').answered], ['acme/shop', 'earned:family', 'acme/sync'], 'b was decided by the family key, then a person said otherwise');
  const family = r.keyTypes.find((t) => t.type === 'family')!;
  assert.deepEqual([family.a, family.b, family.deciding], [19, 2, false], 'one failed trial: the type is no longer sure enough to decide');
  assert.equal(of(r, 'c').label === null || of(r, 'c').conf < 0.95, true, 'the contradicted key decides nothing');
  assert.deepEqual(r.stats!.trials, { success: 0, failure: 1 });
  // A correction supersedes: only b's latest label counts.
  const r2 = learn([a, b, c], [ans('a', 'acme/shop', 'q1', '2026-03-08'), ans('b', 'acme/sync', 'q2', '2026-03-09'), ans('b', 'acme/shop', 'q3', '2026-03-09')], OPTS());
  assert.equal(r2.stats!.superseded, 1);
  assert.deepEqual([of(r2, 'c').label, of(r2, 'c').rung], ['acme/shop', 'earned:family']);
});

test('a rung instance that answers and audits contradict is demoted: its units become questions with its label as the guess', () => {
  const old = ['t1', 't2', 't3'].map((id) => unit(id, { day: '2026-03-05', label: 'globex/portal', conf: 0.97, rung: 'key:GP', structural: true }));
  const now = unit('t4', { label: 'globex/portal', conf: 0.97, rung: 'key:GP', structural: true });
  assert.ok(of(learn([...old, now], [], OPTS()), 't4').conf >= 0.95, 'nobody said anything yet: the route decides');
  const ev = [ans('t1', 'globex/admin', 'audit-t1', '2026-03-05', { audit: true }), ans('t2', 'unregistered', 'q2', '2026-03-06'), ans('t3', 'globex/portal', 'q3', '2026-03-07')];
  const r = learn([...old, now], ev, OPTS());
  const row = r.calibration.find((c) => c.instance === 'key:GP')!;
  assert.deepEqual([row.demoted, row.right, row.wrong], [true, 1, 2]);
  assert.ok(Math.abs(row.a - 20.4) < 1e-9 && Math.abs(row.b - 2.6) < 1e-9, 'Beta(20·.97 + 1, 20·.03 + 2)');
  assert.equal(r.calibration[0]!.instance, 'key:GP', 'demoted instances lead the readout');
  const t4 = of(r, 't4');
  assert.ok(t4.conf < 0.95);
  assert.deepEqual([t4.label, t4.ask?.guess, t4.ask?.form], ['globex/portal', 'globex/portal', 'confirm']);
  assert.match(t4.why!, /demoted/);
  // Seeds never grade the floor: the same rows as seeds leave the instance alone.
  const seeded = learn([...old, now], ev.map((e) => ({ ...e, source: 'seed' as const })), OPTS());
  assert.equal(seeded.calibration.find((c) => c.instance === 'key:GP')!.demoted, false);
  // One wrong audit is enough to take even a .99 route below τ until people confirm it again.
  const host = (id: string, day: string) => unit(id, { day, label: 'globex/portal', conf: 0.99, rung: 'host:portal.globex.example', structural: true });
  const r3 = learn([host('h1', '2026-03-09'), host('h2', TODAY)], [ans('h1', 'acme/shop', 'audit-h1', '2026-03-09', { audit: true })], OPTS());
  assert.ok(of(r3, 'h2').conf < 0.95);
});

test('sibling-aware trust: the client is decided, the initiative only with a cue of its own; one question per client and day', () => {
  const units = [
    ac('own', 'AC-12 checkout broken in the online shop'),
    ac('sib', 'AC-13 ERP stock sync lags again'),
    ac('none', 'AC-14 please have a look'),
    ac('both', 'AC-15 checkout prices wrong after the ERP stock sync'),
    unit('gp', { label: 'globex/portal', conf: 0.97, rung: 'key:GP', structural: true, text: 'GP-3 login slow' }),
  ];
  const r = learn(units, [], OPTS());
  assert.deepEqual([of(r, 'own').label, of(r, 'own').conf], ['acme/shop', 0.98]);
  assert.deepEqual([of(r, 'sib').label, of(r, 'sib').conf, of(r, 'sib').rung], ['acme/sync', 0.6, 'cue:key:AC']);
  assert.deepEqual([of(r, 'none').label, of(r, 'none').conf], ['acme/shop', 0.85]);
  assert.deepEqual([of(r, 'both').label, of(r, 'both').conf], ['acme/shop', 0.85]);
  assert.deepEqual([of(r, 'gp').label, of(r, 'gp').conf], ['globex/portal', 0.97], 'no siblings: nothing changes');
  assert.deepEqual([of(r, 'none').umbrella, of(r, 'none').umbrellaConf], ['acme', 0.98]);
  const q = r.questions.find((x) => x.group === `client:acme:${TODAY}`)!;
  assert.deepEqual([...q.units].sort(), ['both', 'none', 'sib']);
  assert.deepEqual([q.guess, q.form], ['acme/shop', 'confirm'], 'the surest member’s guess');
  assert.equal(r.questions.length, 1, 'the kept and the sibling-free units are decided');
  const off = learn(units, [], OPTS({ siblingAware: false }));
  assert.ok(off.units.every((u) => u.conf >= 0.95), 'siblingAware off: the floor as it is');
});

test('trust repair: three agreeing answers on a route’s units restore it for units without cues; a contradiction revokes it', () => {
  const past = ['p1', 'p2', 'p3'].map((id, i) => ac(id, `AC-${20 + i} please have a look`, { day: `2026-03-0${6 + i}` }));
  const ev = past.map((u) => ans(u.id, 'acme/shop', `q-${u.id}`, u.day));
  const today = [ac('none', 'AC-30 one more thing'), ac('sib', 'AC-31 ERP stock sync lags again')];
  let r = learn([...past, ...today], ev, OPTS());
  assert.ok(of(r, 'none').conf >= 0.95, 'the route’s answers vouch for it');
  assert.equal(of(r, 'sib').label, 'acme/sync', 'but not against a sibling’s cue in the unit’s own words');
  const p4 = ac('p4', 'AC-24 please have a look', { day: '2026-03-09' });
  r = learn([...past, p4, ...today], [...ev, ans('p4', 'acme/sync', 'q-p4', '2026-03-09')], OPTS());
  assert.ok(of(r, 'none').conf < 0.95, 'one contradicting answer and the route is in doubt again');
  const row = r.calibration.find((c) => c.instance === 'key:AC')!;
  assert.deepEqual([row.right, row.wrong, row.demoted], [3, 1, true], '(19.6 + 3) / 24 < .95');
  assert.ok(row.clientMean! >= 0.95, 'still right about the client');
});

test('questions: an item asks about its best decidable key, a fragment about its case; ≤ 12 per group; ranked by value', () => {
  const fam = (id: string, day = TODAY) => unit(id, { day, keys: { family: 'uptime|<n> down|shop.acme.example', container: 'C0OPSALRT1' } });
  const alerts = [...Array.from({ length: 14 }, (_, i) => fam(`a${String(i).padStart(2, '0')}`)), fam('y1', '2026-03-09')];
  const topics = [unit('f1', { unit: 'fragment', caseKey: 'call:c1', minutes: 30, keys: { cpset: 'ana,bo' } }), unit('f2', { unit: 'fragment', caseKey: 'call:c1', minutes: 15, keys: { cpset: 'ana,bo' } })];
  const lone = unit('lone');
  const r = learn([...alerts, ...topics, lone], [], OPTS());
  const groups = Object.fromEntries(r.questions.map((q) => [q.group, q]));
  assert.equal(groups['family=uptime|<n> down|shop.acme.example']!.units.length, 12, 'the family (decidable after one answer) beats the channel');
  assert.equal(groups['family=uptime|<n> down|shop.acme.example#2']!.units.length, 2);
  assert.deepEqual(groups['call:c1']!.units, ['f1', 'f2'], 'a fragment asks about its call');
  assert.ok(groups['thread:lone']);
  assert.deepEqual(r.questions.map((q) => q.group), ['call:c1', 'family=uptime|<n> down|shop.acme.example', 'family=uptime|<n> down|shop.acme.example#2', 'thread:lone']);
  assert.ok(Math.abs(groups['family=uptime|<n> down|shop.acme.example']!.value - (12 + 0.5 * 15 * 0.95)) < 1e-9, '12 open units + the yield of a 15-unit family');
  assert.equal(groups['thread:lone']!.form, 'choose', 'no guess, no confirm');
  assert.equal(of(r, 'y1').ask, undefined, 'only today’s units are asked');
});

test('audits: a seeded sample of today’s auto-decided units, sized by the credit since the first answer', () => {
  const units = Array.from({ length: 20 }, (_, i) => unit(`g${i}`, { label: 'globex/portal', conf: 0.97, rung: 'key:GP', structural: true }));
  const first = [ans('x', 'globex/portal', 'q0', '2026-03-08')];
  const r = learn(units, first, OPTS());
  assert.equal(r.audits.length, 1, '.45 a day since 03-08: floor(1.35) − floor(0.9)');
  assert.deepEqual(learn(units, first, OPTS()).audits, r.audits, 'the same every build of the day');
  assert.equal(of(r, r.audits[0]!).audit, true);
  assert.deepEqual(learn(units, [], OPTS()).audits, [], 'nobody answered yet');
  assert.equal(learn(units, first, OPTS({ today: '2026-03-09' })).audits.length, 0);
  const seeds = new Set(['a', 'b', 'c', 'd', 'e', 'f'].map((seed) => learn(units, first, OPTS({ seed })).audits[0]));
  assert.ok(seeds.size > 1, 'the seed picks the sample');
});

test('rule candidates: keys three independent answers agree on, of a type measured ≥ .9', () => {
  const day = (i: number) => `2026-03-0${5 + i}`;
  const units = [0, 1, 2].map((i) => unit(`h${i}`, { day: day(i), keys: { host: 'shop.acme.example', container: 'C0ACMEWEB1', thread: 'slack:T0ACME/C0ACMEWEB1/1' } }));
  const r = learn(units, units.map((u, i) => ans(u.id, 'acme/shop', `q${i}`, day(i))), OPTS());
  assert.deepEqual(r.ruleCandidates, [{ key: 'host=shop.acme.example', label: 'acme/shop', support: 3 }], 'not the .80 channel, never the thread');
});

test('a doubted route’s question carries the route’s reach as yield: one answer calibrates all its units', () => {
  const past = Array.from({ length: 20 }, (_, i) => ac(`p${i}`, 'AC-1 auto', { day: `2026-03-0${1 + (i % 9)}` }));
  const doubted = ['d1', 'd2', 'd3'].map((id) => ac(id, `${id} please have a look`));
  const r = learn([...past, ...doubted, unit('lone')], [], OPTS());
  assert.deepEqual(r.questions.map((q) => q.group), [`client:acme:${TODAY}`, 'thread:lone']);
  assert.ok(Math.abs(r.questions[0]!.value - (3 * 0.15 + 0.5 * 23 * 0.8)) < 1e-9, '3 × (1 − .85) + ½ · 23 units of key:AC · h_ctx .80');
});

test('deterministic: the same ledger gives the same result in any input order', () => {
  const units = [
    ...['p1', 'p2', 'p3'].map((id, i) => ac(id, `AC-${i} please have a look`, { day: `2026-03-0${6 + i}` })),
    ac('none', 'AC-30 one more thing'),
    ac('sib', 'AC-31 ERP stock sync lags again'),
    ...Array.from({ length: 12 }, (_, i) => unit(`g${i}`, { label: 'globex/portal', conf: 0.97, rung: 'key:GP', structural: true, keys: { family: 'uptime|<n> down|portal.globex.example' } })),
  ];
  const ev = [ans('p1', 'acme/shop', 'q1', '2026-03-06'), ans('p2', 'acme/sync', 'q2', '2026-03-07'), ans('p3', 'acme/shop', 'q3', '2026-03-08', { audit: true })];
  const a = learn(units, ev, OPTS());
  const b = learn([...units].reverse(), [...ev].reverse(), OPTS());
  const byId = (r: ReturnType<typeof learn>) => Object.fromEntries(r.units.map((u) => [u.id, u]));
  assert.deepEqual(byId(b), byId(a));
  assert.deepEqual([b.questions, b.audits, b.calibration, b.keyTypes, b.ruleCandidates], [a.questions, a.audits, a.calibration, a.keyTypes, a.ruleCandidates]);
});

test('interleave — question kinds take turns, each in its own order', async () => {
  const { interleave } = await import('./learn.js');
  const qs = [
    { g: 'f1', k: 'fragment' },
    { g: 'f2', k: 'fragment' },
    { g: 'f3', k: 'fragment' },
    { g: 'i1', k: 'item' },
  ];
  assert.deepEqual(
    interleave(qs, (q) => q.k).map((q) => q.g),
    ['f1', 'i1', 'f2', 'f3'],
  );
  assert.deepEqual(interleave([], (q: { k: string }) => q.k), []);
});
