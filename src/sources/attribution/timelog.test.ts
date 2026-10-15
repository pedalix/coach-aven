// The timelog readout's merge rules, ported from the owen-ops CLI's timelog tests (src/timelog.test.ts):
// calls in full, coding unioned per initiative minus call time, split aliases, co-activity, wall-clock policy.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTimelog, fragmentsToEvidence, resolveByCoActivity, routeOfAttributions, type TlEvidence, type TlRoute } from '../../../snapshot/plain/sources-mcp.mjs';

const reg = {
  'acme/b/p5': { umbrella: 'acme', billing_code: 'P5' },
  'acme/s/p1': { umbrella: 'acme', billing_code: 'P1' },
  'acme/y/p3': { umbrella: 'acme', billing_code: 'P3' },
  'acme/l/onb': { umbrella: 'acme', split_into: { 'acme/s/p1': 0.5, 'acme/y/p3': 0.5 } },
  'acme/b/zoo': { umbrella: 'acme', alias_of: 'acme/b/p5' },
  'globex/a/a': { umbrella: 'globex', billing_code: 'a' },
};
const R = (initiative: string | null, confidence = 'exact', extra: Partial<TlRoute> = {}): TlRoute => ({ initiative, confidence, candidates: initiative ? [initiative] : [], ...extra });
const ev = (kind: TlEvidence['kind'], start: string, end: string, route: TlRoute, ref: string, workKey?: string): TlEvidence => ({ kind, start, end, minutes: Math.round((Date.parse(end) - Date.parse(start)) / 60_000), title: ref, ref, route, ...(workKey ? { workKey } : {}) });
const frag = (id: string, kind: string, start: string, end: string, atts: [string, number][], refs: string[] = [`r:${id}`], state = 'decided', candidates: string[] = []) => ({ id, kind, start, end, state, attributions: atts.map(([initiative, share]) => ({ initiative, share })), candidates, refs });

test('calls count in full; overlapping work is trimmed; runs ∪ work of one initiative are unioned', () => {
  const entries = buildTimelog([
    ev('meeting', '2026-10-05T08:00:00Z', '2026-10-05T09:00:00Z', R('acme/b/p5', 'default'), 'm1'),
    ev('session', '2026-10-05T08:30:00Z', '2026-10-05T11:00:00Z', R('acme/b/p5'), 's1', 'fragment:work'),
    ev('session', '2026-10-05T10:00:00Z', '2026-10-05T12:00:00Z', R('acme/b/p5'), 's2', 'fragment:thread'),
  ], reg, 'UTC');
  assert.equal(entries.length, 1);
  assert.equal(entries[0]!.minutes, 60 + 180);
  assert.equal(entries[0]!.confidence, 'default');
  assert.deepEqual([entries[0]!.umbrella, entries[0]!.billing_code], ['acme', 'P5']);
});

test('a split alias distributes by weight; unattributed time is its own row with candidates', () => {
  const entries = buildTimelog([
    ev('meeting', '2026-10-06T08:00:00Z', '2026-10-06T09:00:00Z', R(null, 'exact', { split: { 'acme/s/p1': 0.5, 'acme/y/p3': 0.5 }, candidates: ['acme/s/p1', 'acme/y/p3'] }), 'm2'),
    ev('session', '2026-10-06T12:00:00Z', '2026-10-06T13:00:00Z', R(null, 'none'), 'x', 'fragment:work'),
    ev('session', '2026-10-06T14:00:00Z', '2026-10-06T14:30:00Z', R(null, 'open', { candidates: ['acme/s/p1', 'acme/y/p3'] }), 'q', 'fragment:thread'),
  ], reg, 'UTC');
  const by = Object.fromEntries(entries.map((e) => [e.initiative ?? e.confidence, e.minutes]));
  assert.deepEqual(by, { 'acme/s/p1': 30, 'acme/y/p3': 30, none: 60, open: 30 });
  assert.deepEqual(entries.find((e) => e.confidence === 'open')!.candidates, ['acme/s/p1', 'acme/y/p3']);
});

test('co-activity: open work in a shared repo follows the one candidate active that day; both/neither stays open; runs never', () => {
  const shared = (ref: string, workKey = 'fragment:work') => ev('session', '2026-10-01T09:00:00Z', '2026-10-01T10:00:00Z', R(null, 'open', { candidates: ['globex/a/a', 'acme/b/p5'] }), ref, workKey);
  const active = (ini: string, at: string) => ev('session', `2026-10-01T${at}:00:00Z`, `2026-10-01T${at}:30:00Z`, R(ini), `a-${ini}`, 'fragment:work');
  const one = resolveByCoActivity([shared('g1'), active('globex/a/a', '11')]);
  assert.deepEqual([one[0]!.route.initiative, one[0]!.route.confidence], ['globex/a/a', 'default']);
  assert.equal(resolveByCoActivity([shared('g2'), active('globex/a/a', '11'), active('acme/b/p5', '13')])[0]!.route.confidence, 'open');
  assert.equal(resolveByCoActivity([shared('g3')])[0]!.route.confidence, 'open');
  assert.equal(resolveByCoActivity([shared('t', 'fragment:thread'), active('globex/a/a', '11')])[0]!.route.confidence, 'open', 'a conversation is not a repo');
});

test("policy 'wallclock' scales coding so the day equals wall-clock; calls untouched", () => {
  const evs = [
    ev('meeting', '2026-10-05T07:00:00Z', '2026-10-05T08:00:00Z', R('acme/s/p1', 'default'), 'm'),
    ev('session', '2026-10-05T08:00:00Z', '2026-10-05T12:00:00Z', R('acme/b/p5'), 'a', 'fragment:work'),
    ev('session', '2026-10-05T10:00:00Z', '2026-10-05T12:00:00Z', R('acme/y/p3'), 'b', 'fragment:work'),
  ];
  assert.equal(buildTimelog(evs, reg, 'UTC', 'sum').reduce((a, e) => a + e.minutes, 0), 60 + 240 + 120);
  const by = Object.fromEntries(buildTimelog(evs, reg, 'UTC', 'wallclock').map((e) => [e.initiative, e.minutes]));
  assert.equal(by['acme/s/p1'], 60);
  assert.deepEqual([by['acme/b/p5'], by['acme/y/p3']], [160, 80]);
});

test('call topics are one meeting split by their shares; aliases resolve; pins and rule decisions count as decided', () => {
  const ev1 = fragmentsToEvidence([
    frag('c1', 'call', '2026-10-05T08:00:00Z', '2026-10-05T09:00:00Z', [['acme/s/p1', 0.5]], ['meeting:granola:x']),
    frag('c2', 'call', '2026-10-05T08:00:00Z', '2026-10-05T09:00:00Z', [['acme/b/zoo', 0.25], ['acme/l/onb', 0.25]], ['meeting:granola:x'], 'rule'),
  ], reg);
  assert.equal(ev1.length, 1);
  assert.deepEqual(ev1[0]!.route.split, { 'acme/s/p1': 0.625, 'acme/b/p5': 0.25, 'acme/y/p3': 0.125 });
  assert.equal(buildTimelog(ev1, reg, 'UTC').find((e) => e.initiative === 'acme/s/p1')!.minutes, 38);
  assert.deepEqual(routeOfAttributions([{ initiative: 'acme/b/zoo', share: 1 }], reg), { initiative: 'acme/b/p5', confidence: 'exact', candidates: ['acme/b/p5'] });
});

test('runs and work are scalable; calls win overlaps; escalated and open keep candidates', () => {
  const evs = fragmentsToEvidence([
    frag('m', 'call', '2026-10-06T10:00:00Z', '2026-10-06T11:00:00Z', [['acme/s/p1', 1]], ['meeting:g:m']),
    frag('w', 'work', '2026-10-06T09:00:00Z', '2026-10-06T12:00:00Z', [['acme/b/p5', 1]]),
    frag('e', 'thread', '2026-10-06T15:00:00Z', '2026-10-06T15:30:00Z', [], ['slack:t1'], 'escalated', ['acme/s/p1', 'globex/a/a']),
    frag('o', 'thread', '2026-10-06T16:00:00Z', '2026-10-06T16:20:00Z', [], ['slack:t2'], 'open', ['acme/y/p3']),
  ], reg);
  const entries = buildTimelog(evs, reg, 'UTC');
  assert.equal(entries.find((e) => e.initiative === 'acme/s/p1')!.minutes, 60);
  assert.equal(entries.find((e) => e.initiative === 'acme/b/p5')!.minutes, 120);
  const esc = entries.find((e) => e.confidence === 'escalated')!;
  assert.deepEqual([esc.minutes, esc.candidates], [30, ['acme/s/p1', 'globex/a/a']]);
  assert.deepEqual(entries.find((e) => e.confidence === 'open')!.candidates, ['acme/y/p3']);
});

test('days are cut in the given zone: an hour of work at 22:30 UTC is the next day in Moscow', () => {
  const e = [ev('session', '2026-10-05T22:30:00Z', '2026-10-05T23:30:00Z', R('acme/b/p5'), 'late', 'fragment:work')];
  assert.equal(buildTimelog(e, reg, 'UTC')[0]!.day, '2026-10-05');
  assert.equal(buildTimelog(e, reg, 'Europe/Moscow')[0]!.day, '2026-10-06');
});
