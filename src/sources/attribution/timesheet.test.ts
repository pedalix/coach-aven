// Timesheets (OpenSpec `timesheets`): the sheet rules as tenant data (sheets.ts), the re-keying of timelog evidence and
// the layout (pure, in the sources MCP), and the `timesheet` readout over a store — with what was handed in.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../store.js';
import { parseSheets, parseSubmitted, sheetsForStore } from './sheets.js';
import { buildTimelog, fitToTotal, layoutSheet, reconcile, repoTailMatches, runTimelog, runTimesheet, sheetEvidence, withSubmitted, type TlEvidence, type TsSheet } from '../../../snapshot/plain/sources-mcp.mjs';

const registry = {
  initiatives: [
    { id: 'northwind/shop', umbrella: 'northwind', billing_code: 'shop', sources: {} },
    { id: 'northwind/cms', umbrella: 'northwind', billing_code: 'cms', sources: {} },
    { id: 'northwind/infra', umbrella: 'northwind', billing_code: 'infra', sources: {} },
    { id: 'northwind/admin', umbrella: 'northwind', sources: {} },
    { id: 'acme/p1', umbrella: 'acme', billing_code: 'P1', sources: {} },
    { id: 'acme/p3', umbrella: 'acme', billing_code: 'P3', sources: {} },
  ],
};
const reg = Object.fromEntries(registry.initiatives.map((i) => [i.id, { umbrella: i.umbrella, ...(i.billing_code ? { billing_code: i.billing_code } : {}) }]));

const northwindRaw = {
  id: 'northwind',
  umbrella: 'northwind',
  unit: 'hour',
  step: 1,
  columns: ['date', 'comment', 'project', 'who', 'units'],
  who: 'Jane',
  dateFormat: 'DD/MM/YYYY',
  projects: [
    { initiative: 'northwind/shop', match: { keys: ['NS'] }, project: 'shop-north' },
    { initiative: 'northwind/shop', match: { keys: ['SS'] }, project: 'shop-south' },
    { initiative: 'northwind/shop', sameDay: true },
    { initiative: 'northwind/shop', project: 'shop-general' },
    { initiative: 'northwind/cms', match: { repos: ['north-cms-sync'] }, project: 'cms-north' },
    { initiative: 'northwind/cms', match: { title: 'south' }, project: 'cms-south' },
    { initiative: 'northwind/infra', project: 'Internal' },
  ],
};
const acmeRaw = { id: 'acme', umbrella: 'acme', unit: 'half_day', columns: ['date', 'comment', 'project', 'skip', 'who', 'units'], who: 'Jane', layout: { weekends: 'shift', maxUnitsPerDay: 2 }, projects: [{ projectFrom: 'billing_code' }] };

test('sheets.json: defaults filled; every mistake names the sheet and the rule', () => {
  const [nw, acme] = parseSheets({ sheets: [northwindRaw, acmeRaw] }, registry);
  assert.deepEqual([nw!.unitMinutes, nw!.step, nw!.layout, nw!.comment], [60, 1, { weekends: 'keep' }, { language: 'en' }]);
  assert.deepEqual([acme!.unitMinutes, acme!.step, acme!.dateFormat, nw!.projects[0]!.initiatives], [240, 0.5, 'YYYY-MM-DD', ['northwind/shop']]);
  const bad = (sheet: Record<string, unknown>, re: RegExp) => assert.throws(() => parseSheets({ sheets: [sheet] }, registry), re);
  bad({ ...northwindRaw, colour: 'red' }, /sheet "northwind": unknown key "colour"/);
  bad({ ...northwindRaw, umbrella: 'globex' }, /no initiative in the registry has umbrella "globex"/);
  bad({ ...northwindRaw, projects: [{ initiative: 'acme/p1', project: 'x' }] }, /projects\[0\]: initiative "acme\/p1" is not in the registry under umbrella "northwind"/);
  bad({ ...northwindRaw, projects: [{ project: 'x', sameDay: true }] }, /projects\[0\]: exactly one of/);
  bad({ ...northwindRaw, projects: [{ project: 'tbd' }, { initiative: 'northwind/shop', project: 'shop' }] }, /projects\[1\]: unreachable — projects\[0\]/);
  bad({ ...northwindRaw, projects: [{ initiative: 'northwind/cms', match: { title: '(' }, project: 'x' }] }, /projects\[0\]\.match: "title" is not a valid regular expression/);
  bad({ ...acmeRaw, layout: { maxUnitsPerDay: 1.25 } }, /"maxUnitsPerDay" must be a multiple of "step" \(0\.5\)/);
  bad({ ...northwindRaw, who: undefined }, /the "who" column needs "who"/);
  bad({ ...acmeRaw, monthRange: { min: 30, max: 24 } }, /"min" must not exceed "max"/);
  bad({ ...acmeRaw, monthRange: { max: 24.25 } }, /"max" must be a number ≥ 0 and a multiple of "step"/);
  // the build stores a broken file as its error, never throws (the layer keeps building)
  assert.match((sheetsForStore('{"sheets": [{"id": "x"}]}', registry) as { error: string }).error, /sheet "x": "umbrella" is required/);
});

test('submitted.jsonl: the last line per id wins; a bad line is named and skipped, the rest kept', () => {
  const line = (o: Record<string, unknown>) => JSON.stringify({ id: 'nw-10a', sheet: 'northwind', since: '2026-10-01', until: '2026-10-15', rows: [{ date: '2026-10-02', project: 'shop-north', units: 3 }], ...o });
  const text = [line({}), '{oops', line({ rows: [{ date: '2026-10-02', project: 'shop-north', units: 4, comment: 'Checkout fixes' }] }), line({ id: 'nw-10b', since: '2026-10-16', until: '2026-10-31', rows: [{ date: '2026-09-30', project: 'x', units: 1 }] })].join('\n');
  const { periods, errors } = parseSubmitted(text);
  assert.deepEqual(periods.map((p) => [p.id, p.rows[0]!.units, p.rows[0]!.comment]), [['nw-10a', 4, 'Checkout fixes']]);
  assert.deepEqual(errors, ['ledger/submitted.jsonl:2: not JSON', 'ledger/submitted.jsonl:4: rows[0] 2026-09-30 is outside 2026-10-16..2026-10-31']);
});

const R = (initiative: string | null, split?: Record<string, number>) => ({ initiative, confidence: 'exact', candidates: initiative ? [initiative] : Object.keys(split ?? {}), ...(split ? { split } : {}) });
const ev = (start: string, end: string, route: TlEvidence['route'], facets: Partial<NonNullable<TlEvidence['facets']>> = {}, kind: TlEvidence['kind'] = 'session'): TlEvidence => ({
  kind, start, end, minutes: Math.round((Date.parse(end) - Date.parse(start)) / 60_000), title: start, ref: `fragment:${start}`, route, ...(kind === 'session' ? { workKey: 'fragment:work' } : {}),
  facets: { titles: [], container: null, keys: [], ...facets },
});
const dayOf = (iso: string) => iso.slice(0, 10);

test('re-keying: keys, repos and titles pick the project; sameDay follows the day; other umbrellas and non-billable time keep their routes', () => {
  const [sheet] = parseSheets({ sheets: [northwindRaw] }, registry) as unknown as TsSheet[];
  const out = sheetEvidence([
    ev('2026-10-05T08:00:00Z', '2026-10-05T10:00:00Z', R('northwind/shop'), { keys: ['NS'], container: 'github.com/northwind/shop' }),
    ev('2026-10-05T10:00:00Z', '2026-10-05T10:30:00Z', R('northwind/shop'), { container: 'dm:@kim' }), // no key: the day's shop work was north
    ev('2026-10-06T10:00:00Z', '2026-10-06T10:30:00Z', R('northwind/shop'), { container: 'dm:@kim' }), // nothing that day → general
    ev('2026-10-05T11:00:00Z', '2026-10-05T12:00:00Z', R('northwind/cms'), { container: 'github.com/northwind/north-cms-sync' }),
    ev('2026-10-05T12:00:00Z', '2026-10-05T13:00:00Z', R('northwind/cms'), { titles: ['South CMS import'] }),
    ev('2026-10-05T13:00:00Z', '2026-10-05T14:00:00Z', R('northwind/cms'), { titles: ['a call about CMS'] }), // no rule → unmapped
    ev('2026-10-05T14:00:00Z', '2026-10-05T15:00:00Z', R('northwind/admin')),
    ev('2026-10-05T15:00:00Z', '2026-10-05T16:00:00Z', R('acme/p1')),
    ev('2026-10-05T16:00:00Z', '2026-10-05T17:00:00Z', R(null, { 'northwind/infra': 0.5, 'acme/p3': 0.5 }), {}, 'meeting'),
  ], sheet!, reg, dayOf);
  assert.deepEqual(out.map((e) => e.route.initiative ?? e.route.split), [
    'sheet:shop-north', 'sheet:shop-north', 'sheet:shop-general', 'sheet:cms-north', 'sheet:cms-south', 'unmapped:northwind/cms', 'northwind/admin', 'acme/p1', { 'sheet:Internal': 0.5, 'acme/p3': 0.5 },
  ]);
  assert.equal(repoTailMatches('northwind/north-*', 'github.com/Northwind/north-cms-sync'), true);
  assert.equal(repoTailMatches('cms-sync', 'github.com/northwind/north-cms-sync'), false);
});

test('wall-clock holds across sheet projects: overlapping work of two projects is scaled to the day', () => {
  const [sheet] = parseSheets({ sheets: [northwindRaw] }, registry) as unknown as TsSheet[];
  const evs = sheetEvidence([
    ev('2026-10-05T08:00:00Z', '2026-10-05T12:00:00Z', R('northwind/shop'), { keys: ['NS'] }),
    ev('2026-10-05T08:00:00Z', '2026-10-05T12:00:00Z', R('northwind/shop'), { keys: ['SS'] }),
  ], sheet!, reg, dayOf);
  const entries = buildTimelog(evs, reg, 'UTC', 'wallclock');
  assert.deepEqual(entries.map((e) => [e.initiative, e.minutes]), [['sheet:shop-north', 120], ['sheet:shop-south', 120]]);
});

test('layout: Saturday to Friday, Sunday to Monday, the month edge the other way; rounding keeps each project\'s total', () => {
  const sheet = { step: 1, unitMinutes: 60, layout: { weekends: 'shift' as const } };
  // 2026-10-03 is a Saturday, 2026-10-04 a Sunday, 2026-10-31 a Saturday (its Monday is outside the window)
  const out = layoutSheet([
    { date: '2026-10-02', project: 'shop', minutes: 100 },
    { date: '2026-10-03', project: 'shop', minutes: 50 },
    { date: '2026-10-04', project: 'shop', minutes: 20 },
    { date: '2026-10-31', project: 'shop', minutes: 70 },
  ], sheet, { since: '2026-10-01', until: '2026-10-31' });
  assert.equal(out.shifted, true);
  assert.deepEqual(out.rows.map((r) => [r.date, r.units, r.minutes, r.source_days]), [['2026-10-02', 3, 150, ['2026-10-02', '2026-10-03']], ['2026-10-30', 1, 70, ['2026-10-31']]]);
  assert.deepEqual(out.folded, [{ date: '2026-10-05', project: 'shop', minutes: 20 }], '20 minutes alone are under a step: carried by the total (240 min → 4 h)');
  assert.equal(out.rows.reduce((a, r) => a + r.units, 0), 4);
  // a period starting on a Saturday moves its Saturday forward, not before the window
  assert.deepEqual(layoutSheet([{ date: '2026-08-01', project: 'shop', minutes: 60 }], sheet, { since: '2026-08-01', until: '2026-08-31' }).rows.map((r) => r.date), ['2026-08-03']);
  // keep: weekends stay
  assert.deepEqual(layoutSheet([{ date: '2026-10-03', project: 'shop', minutes: 60 }], { ...sheet, layout: { weekends: 'keep' as const } }, { since: '2026-10-01', until: '2026-10-31' }).rows.map((r) => [r.date, r.source_days]), [['2026-10-03', undefined]]);
});

test('layout: largest remainder per project, ties to the bigger row; the per-day cap moves whole steps to the nearest day with room', () => {
  const half = { step: 0.5, unitMinutes: 240, layout: { weekends: 'shift' as const, maxUnitsPerDay: 2 } };
  // three rows of about a third of a step each → 127 min ≈ 1 step: the biggest remainder takes it
  const r1 = layoutSheet([
    { date: '2026-10-05', project: 'P1', minutes: 40 },
    { date: '2026-10-06', project: 'P1', minutes: 45 },
    { date: '2026-10-07', project: 'P1', minutes: 42 },
  ], half, { since: '2026-10-01', until: '2026-10-31' });
  assert.deepEqual(r1.rows.map((r) => [r.date, r.units]), [['2026-10-06', 0.5]]);
  // Monday 10-05 has 3 half-days of P5 and 1 of P3: 2 over the cap
  const r2 = layoutSheet([
    { date: '2026-10-05', project: 'P5', minutes: 720, evidence: [{ title: 'platform' }] },
    { date: '2026-10-05', project: 'P3', minutes: 240 },
    { date: '2026-10-06', project: 'P5', minutes: 240 },
  ], half, { since: '2026-10-01', until: '2026-10-31' });
  // the 2 half-days over the cap: the next weekday first (Tuesday, already P5, has room for 1), then the nearest with room
  // (the weekend is no target when weekends shift) — Wednesday
  assert.deepEqual(r2.rows.map((r) => [r.date, r.project, r.units, r.moved_in, r.moved_out]), [
    ['2026-10-05', 'P3', 1, undefined, undefined],
    ['2026-10-05', 'P5', 1, undefined, 2],
    ['2026-10-06', 'P5', 2, [{ from: '2026-10-05', units: 1 }], undefined],
    ['2026-10-07', 'P5', 1, [{ from: '2026-10-05', units: 1 }], undefined],
  ]);
  assert.equal(r2.rows.reduce((a, r) => a + r.units, 0), 5, 'the cap moves units, never drops them');
  assert.deepEqual(r2.rows.find((r) => r.date === '2026-10-07')!.evidence, [{ title: 'platform' }], 'a row made by the cap carries the evidence it came from');
  // no room anywhere (a one-day window): said, not dropped
  const r3 = layoutSheet([{ date: '2026-10-05', project: 'P5', minutes: 960 }], half, { since: '2026-10-05', until: '2026-10-05' });
  assert.deepEqual([r3.rows[0]!.units, r3.over_cap_days], [4, [{ date: '2026-10-05', units: 2 }]]);
  // a blocked day (already handed in) is never a target
  const r4 = layoutSheet([{ date: '2026-10-03', project: 'P5', minutes: 240 }], half, { since: '2026-10-01', until: '2026-10-31', blocked: (d) => d === '2026-10-02' });
  assert.deepEqual(r4.rows.map((r) => r.date), ['2026-10-05']);
});

test('a month above its range shrinks to the max by largest remainder; nothing ever grows', () => {
  const rows = [
    { date: '2026-10-01', project: 'P5', units: 2 },
    { date: '2026-10-02', project: 'P5', units: 2 },
    { date: '2026-10-05', project: 'P3', units: 1 },
    { date: '2026-10-06', project: 'AA', units: 0.5 },
  ];
  // 11 steps to 9: shares 3.27, 3.27, 1.64, 0.82 → floors 3, 3, 1, 0 and the two largest remainders (AA, P3) get a step
  const fit = fitToTotal(rows, 4.5, 0.5);
  assert.deepEqual(fit.rows.map((r) => [r.date, r.units, r.computed_units]), [['2026-10-01', 1.5, 2], ['2026-10-02', 1.5, 2], ['2026-10-05', 1, undefined], ['2026-10-06', 0.5, undefined]]);
  assert.deepEqual(fit.dropped, []);
  // 11 steps to 4: shares 1.45, 1.45, 0.73, 0.36 → P3 first, then the tie goes to the earlier day; AA ends at zero
  const tight = fitToTotal(rows, 2, 0.5);
  assert.deepEqual(tight.rows.map((r) => [r.date, r.units]), [['2026-10-01', 1], ['2026-10-02', 0.5], ['2026-10-05', 0.5]]);
  assert.deepEqual(tight.dropped, [{ date: '2026-10-06', project: 'AA', units: 0.5 }]);
  assert.equal(fitToTotal(rows, 10, 0.5).rows, rows, 'under the max: the same rows');
});

test('reconcile with what was handed in: submitted + open judge the cap; budgets without a period are untouched', () => {
  const budgets = [{ umbrella: 'acme', unit: 'half_day' as const, perMonth: 24, by: 'billing_code' as const }, { umbrella: 'northwind', unit: 'hour' as const, perMonth: 70 }];
  const entries = buildTimelog([
    ev('2026-10-05T08:00:00Z', '2026-10-05T16:00:00Z', R('acme/p1')),
    ev('2026-10-22T08:00:00Z', '2026-10-22T14:00:00Z', R('acme/p1')),
    ev('2026-10-22T14:00:00Z', '2026-10-22T16:00:00Z', R('northwind/shop')),
  ], reg, 'UTC').map((e) => ({ ...e }));
  const rec = reconcile(entries, budgets, '2026-10');
  const periods = [{ id: 'a-1', sheet: 'acme', since: '2026-10-01', until: '2026-10-20', rows: [{ date: '2026-10-05', units: 23 }] }];
  const out = withSubmitted(rec, entries, budgets, '2026-10', [{ id: 'acme', umbrella: 'acme' }], periods);
  assert.deepEqual({ ...out.budgets[0] }, { ...rec.budgets[0], submitted: 23, open: 1.5, committed: 24.5, remaining: -0.5 });
  assert.equal(out.budgets[1], rec.budgets[1], 'no sheet period for northwind: the same object');
});

// ── the readout over a store ──────────────────────────────────────────────────────────────

function storeWith(meta: Record<string, string>, frags: Array<Record<string, unknown>>) {
  const db = openStore(join(mkdtempSync(join(tmpdir(), 'ts-store-')), 'store.sqlite'));
  const m = db.prepare('INSERT OR REPLACE INTO sync_state(key, value) VALUES (?, ?)');
  for (const [k, v] of Object.entries({ 'att:subject': 'jane', 'att:since': '2026-10-01', 'att:until': '2026-10-31', 'att:policy': 'wallclock', 'att:registry': JSON.stringify(reg), ...meta })) m.run(k, v);
  const ins = db.prepare('INSERT INTO att_fragments(id, kind, start, "end", title, source, container, refs, participants, project_keys, weight, state, attributions, candidates) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)');
  for (const f of frags) ins.run(f.id as string, (f.kind as string) ?? 'work', f.start as string, f.end as string, (f.title as string) ?? '', 'activity', (f.container as string) ?? null, '[]', '[]', JSON.stringify(f.keys ?? []), (f.state as string) ?? 'decided', JSON.stringify(f.atts ?? []), JSON.stringify(f.candidates ?? []));
  return db;
}
const NOW = new Date('2026-10-31T12:00:00Z');
const frag = (id: string, start: string, end: string, initiative: string, extra: Record<string, unknown> = {}) => ({ id, start, end, atts: [{ initiative, share: 1 }], ...extra });

test('timesheet: not configured, no sheets, a broken file, an unknown sheet — each says so', () => {
  const none = openStore(join(mkdtempSync(join(tmpdir(), 'ts-none-')), 'store.sqlite'));
  assert.equal(runTimesheet(none, {}, NOW).configured, false);
  none.close();
  const db = storeWith({}, []);
  assert.match(String(runTimesheet(db, {}, NOW).note), /no sheets configured/);
  db.prepare("INSERT INTO sync_state(key, value) VALUES ('att:sheets', ?)").run(JSON.stringify({ error: 'annotations/sheets.json: sheet "x": "umbrella" is required' }));
  assert.match(String(runTimesheet(db, {}, NOW).error), /sheets\.json is invalid.*sheet "x"/);
  db.prepare("UPDATE sync_state SET value = ? WHERE key = 'att:sheets'").run(JSON.stringify(sheetsForStore(JSON.stringify({ sheets: [northwindRaw, acmeRaw] }), registry)));
  assert.deepEqual(runTimesheet(db, {}, NOW), { error: 'name the sheet', sheets: ['northwind', 'acme'] });
  assert.match(String(runTimesheet(db, { sheet: 'globex' }, NOW).error), /unknown sheet "globex"/);
  db.close();
});

test('timesheet: rows with evidence, unmapped and undecided said, handed-in days left out, the month against the cap', () => {
  const sheets = JSON.stringify(sheetsForStore(JSON.stringify({ sheets: [northwindRaw, acmeRaw] }), registry));
  const submitted = JSON.stringify(parseSubmitted(JSON.stringify({ id: 'nw-1', sheet: 'northwind', since: '2026-10-01', until: '2026-10-09', rows: [{ date: '2026-10-05', project: 'shop-north', units: 30 }] })));
  const budgets = JSON.stringify([{ umbrella: 'northwind', unit: 'hour', perMonth: 70 }, { umbrella: 'acme', unit: 'half_day', perMonth: 24, by: 'billing_code' }]);
  const db = storeWith({ 'att:sheets': sheets, 'att:submitted': submitted, 'att:budgets': budgets, 'att:policy': 'wallclock' }, [
    frag('f1', '2026-10-05T08:00:00Z', '2026-10-05T10:00:00Z', 'northwind/shop', { keys: ['NS'] }), // handed in
    frag('f2', '2026-10-12T08:00:00Z', '2026-10-12T10:30:00Z', 'northwind/shop', { keys: ['NS'], title: 'north-shop: 4 commits — NS-41 checkout fix', container: 'github.com/northwind/shop' }),
    frag('f3', '2026-10-12T11:00:00Z', '2026-10-12T11:40:00Z', 'northwind/shop', { kind: 'thread', title: 'dm:@kim — re: the north checkout', container: 'dm:@kim' }),
    frag('f4', '2026-10-13T09:00:00Z', '2026-10-13T10:00:00Z', 'northwind/cms', { title: 'a call about the CMS', kind: 'call' }),
    frag('f5', '2026-10-13T10:00:00Z', '2026-10-13T11:00:00Z', 'northwind/admin', { title: 'invoices' }),
    { id: 'f6', start: '2026-10-14T09:00:00Z', end: '2026-10-14T09:45:00Z', state: 'open', atts: [], candidates: ['northwind/shop', 'acme/p1'], title: 'dm:@lee' },
    frag('f7', '2026-10-17T09:00:00Z', '2026-10-17T11:00:00Z', 'northwind/infra', { title: 'Saturday upgrade' }),
  ]);
  try {
    const out = runTimesheet(db, { sheet: 'northwind', since: '2026-10-01', until: '2026-10-31' }, NOW);
    assert.deepEqual(out.rows!.map((r) => [r.date, r.project, r.units, r.minutes, r.source_days]), [['2026-10-12', 'shop-north', 3, 190, undefined], ['2026-10-17', 'Internal', 2, 120, undefined]]);
    assert.deepEqual(out.rows![0]!.evidence.map((e) => [e.kind, e.title, e.minutes]), [['work', 'north-shop: 4 commits — NS-41 checkout fix', 150], ['thread', 'dm:@kim — re: the north checkout', 40]]);
    assert.deepEqual([out.columns, out.who, out.date_format, out.layout], [['date', 'comment', 'project', 'who', 'units'], 'Jane', 'DD/MM/YYYY', 'kept']);
    assert.deepEqual(out.unmapped!.map((u) => [u.date, u.initiative, u.minutes]), [['2026-10-13', 'northwind/cms', 60]]);
    assert.deepEqual(out.undecided!.map((u) => [u.date, u.minutes, u.confidence]), [['2026-10-14', 45, 'open']]);
    assert.deepEqual(out.submitted, [{ id: 'nw-1', since: '2026-10-01', until: '2026-10-09', units: 30 }]);
    assert.deepEqual(out.cap, { month: '2026-10', cap: 70, submitted: 30, rows: 5, left: 35 });
    assert.deepEqual(out.totals, { units: 5, minutes: 310, by_project: { 'shop-north': { units: 3, minutes: 190 }, Internal: { units: 2, minutes: 120 } } });
    // include_submitted lays out the handed-in days too (to compare)
    assert.deepEqual(runTimesheet(db, { sheet: 'northwind', since: '2026-10-01', until: '2026-10-31', include_submitted: true }, NOW).rows!.map((r) => r.date), ['2026-10-05', '2026-10-12', '2026-10-17']);
    // the month's reconciliation counts what was handed in
    const rec = runTimelog(db, { since: '2026-10-01', until: '2026-10-31' }, NOW).reconciliation as { budgets: Array<Record<string, unknown>> };
    assert.deepEqual([rec.budgets[0]!.submitted, rec.budgets[0]!.open, rec.budgets[0]!.committed, rec.budgets[0]!.remaining], [30, 6.2, 36.2, 33.8], 'open: the budget counts the unmapped CMS hour too — it is billable time');
    assert.equal(rec.budgets[1]!.submitted, undefined, 'acme has no handed-in period');
  } finally {
    db.close();
  }
});

test('timesheet: monthRange shrinks the month to its max and says what moved; below its min it says by how much', () => {
  const ranged = { ...acmeRaw, monthRange: { min: 2, max: 2.5 } };
  const frags = [
    frag('a1', '2026-10-05T06:00:00Z', '2026-10-05T14:00:00Z', 'acme/p1', { title: 'security review' }), // 2 half-days
    frag('a2', '2026-10-06T06:00:00Z', '2026-10-06T10:00:00Z', 'acme/p3', { title: 'portfolio scorecard' }), // 1
    frag('a3', '2026-10-07T06:00:00Z', '2026-10-07T08:00:00Z', 'acme/p3', { title: 'portfolio write-up' }), // 0.5
  ];
  const db = storeWith({ 'att:sheets': JSON.stringify(sheetsForStore(JSON.stringify({ sheets: [ranged] }), registry)), 'att:budgets': JSON.stringify([{ umbrella: 'acme', unit: 'half_day', perMonth: 24 }]) }, frags);
  try {
    const out = runTimesheet(db, { since: '2026-10-01', until: '2026-10-31' }, NOW);
    assert.equal(out.totals!.units, 2.5);
    assert.deepEqual(out.range, { month: '2026-10', min: 2, max: 2.5, submitted: 0, computed: 3.5, total: 2.5, status: 'scaled' });
    assert.ok(out.rows!.some((r) => r.computed_units !== undefined), 'a shrunk row says what it was');
    assert.equal(out.cap, undefined, 'a range replaces the budget line');
    const below = runTimesheet(db, { since: '2026-10-07', until: '2026-10-31' }, NOW);
    assert.deepEqual([below.range!.status, below.range!.below_by, below.totals!.units], ['below', 1.5, 0.5], 'never padded');
  } finally {
    db.close();
  }
});

test('timesheet: with include_submitted the handed-in days are shown as they were and never count twice against the range', () => {
  const ranged = { ...acmeRaw, monthRange: { max: 4 } };
  const frags = [
    frag('a1', '2026-10-05T06:00:00Z', '2026-10-05T14:00:00Z', 'acme/p1'), // 2 half-days, handed in
    frag('a2', '2026-10-06T06:00:00Z', '2026-10-06T10:00:00Z', 'acme/p3'), // 1, handed in
    frag('a3', '2026-10-07T06:00:00Z', '2026-10-07T08:00:00Z', 'acme/p3'), // 0.5, open
  ];
  const submitted = JSON.stringify(parseSubmitted(JSON.stringify({ id: 'a-1', sheet: 'acme', since: '2026-10-01', until: '2026-10-06', rows: [{ date: '2026-10-05', project: 'P1', units: 2 }, { date: '2026-10-06', project: 'P3', units: 1 }] })));
  const db = storeWith({ 'att:sheets': JSON.stringify(sheetsForStore(JSON.stringify({ sheets: [ranged] }), registry)), 'att:submitted': submitted }, frags);
  try {
    const open = runTimesheet(db, { since: '2026-10-01', until: '2026-10-31' }, NOW);
    const all = runTimesheet(db, { since: '2026-10-01', until: '2026-10-31', include_submitted: true }, NOW);
    assert.deepEqual(open.range, { month: '2026-10', max: 4, submitted: 3, computed: 0.5, total: 3.5, status: 'within' });
    assert.deepEqual(all.range, open.range, 'the comparison view judges the month the same way');
    assert.deepEqual(all.rows!.map((r) => [r.date, r.units, r.computed_units]), [['2026-10-05', 2, undefined], ['2026-10-06', 1, undefined], ['2026-10-07', 0.5, undefined]]);
  } finally {
    db.close();
  }
});

test('timesheet: without the ledger the reconciliation is exactly today\'s', () => {
  const frags = [frag('f2', '2026-10-12T08:00:00Z', '2026-10-12T10:30:00Z', 'northwind/shop', { keys: ['NS'] })];
  const budgets = JSON.stringify([{ umbrella: 'northwind', unit: 'hour', perMonth: 70 }]);
  const plain = storeWith({ 'att:budgets': budgets }, frags);
  const withSheets = storeWith({ 'att:budgets': budgets, 'att:sheets': JSON.stringify(sheetsForStore(JSON.stringify({ sheets: [northwindRaw] }), registry)) }, frags);
  try {
    assert.deepEqual(runTimelog(withSheets, {}, NOW).reconciliation, runTimelog(plain, {}, NOW).reconciliation);
    assert.deepEqual(Object.keys((runTimelog(plain, {}, NOW).reconciliation as { budgets: object[] }).budgets[0]!), ['umbrella', 'unit', 'minutes', 'used', 'cap', 'cap_source', 'remaining', 'by']);
  } finally {
    plain.close();
    withSheets.close();
  }
});
