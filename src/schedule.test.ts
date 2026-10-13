import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseSchedule,
  cronFieldMatch,
  cronMatches,
  nowParts,
  dueRoutines,
  minuteKey,
  minuteStart,
  lastOccurrence,
  missedRoutines,
  groupRoutinesBySlug,
  type TimeParts,
  type SchedulableRoutine,
  type CatchupRoutine,
} from './schedule.js';
import { parseScheduleCommand } from './schedule.js';

// Base parts representing Wed 2026-06-24 09:00 (dow: Sun=0 → Wed=3). Override per-case.
const at = (over: Partial<TimeParts>): TimeParts => ({ mi: 0, ho: 9, dom: 24, mon: 6, dow: 3, ...over });

test('parseSchedule — friendly forms → cron', () => {
  assert.deepEqual(parseSchedule('daily 9:00'), { cron: '0 9 * * *', spec: 'daily 9:00' });
  assert.deepEqual(parseSchedule('weekdays 09:30'), { cron: '30 9 * * 1-5', spec: 'weekdays 09:30' });
  assert.deepEqual(parseSchedule('weekday 9:00'), { cron: '0 9 * * 1-5', spec: 'weekdays 9:00' }); // singular ok
  assert.deepEqual(parseSchedule('weekly mon 9:00'), { cron: '0 9 * * 1', spec: 'weekly mon 9:00' });
  assert.deepEqual(parseSchedule('weekly SUN 23:15'), { cron: '15 23 * * 0', spec: 'weekly sun 23:15' });
  assert.deepEqual(parseSchedule('cron 0 9 * * 1-5'), { cron: '0 9 * * 1-5', spec: 'cron 0 9 * * 1-5' });
  assert.deepEqual(parseSchedule('  daily 9:00  '), { cron: '0 9 * * *', spec: 'daily 9:00' }); // trims
});

test('parseSchedule — invalid input → error', () => {
  assert.ok('error' in parseSchedule('daily 25:00'));
  assert.ok('error' in parseSchedule('daily 9:99'));
  assert.ok('error' in parseSchedule('daily noon'));
  assert.ok('error' in parseSchedule('weekly xyz 9:00'));
  assert.ok('error' in parseSchedule('cron 0 9 * *')); // 4 fields
  assert.ok('error' in parseSchedule('every blue moon'));
  assert.ok('error' in parseSchedule(''));
});

test('cronFieldMatch — wildcards, ranges, lists, steps', () => {
  assert.equal(cronFieldMatch('*', 7), true);
  assert.equal(cronFieldMatch('5', 5), true);
  assert.equal(cronFieldMatch('5', 6), false);
  assert.equal(cronFieldMatch('1-5', 3), true);
  assert.equal(cronFieldMatch('1-5', 6), false);
  assert.equal(cronFieldMatch('0,30', 30), true);
  assert.equal(cronFieldMatch('0,30', 15), false);
  assert.equal(cronFieldMatch('*/15', 0), true);
  assert.equal(cronFieldMatch('*/15', 30), true);
  assert.equal(cronFieldMatch('*/15', 7), false);
});

test('cronMatches — minute/hour gating', () => {
  const cron = '0 9 * * *';
  assert.equal(cronMatches(cron, at({})), true);
  assert.equal(cronMatches(cron, at({ mi: 1 })), false);
  assert.equal(cronMatches(cron, at({ ho: 10 })), false);
});

test('cronMatches — weekdays excludes weekend', () => {
  const cron = '0 9 * * 1-5';
  assert.equal(cronMatches(cron, at({ dow: 1 })), true); // Mon
  assert.equal(cronMatches(cron, at({ dow: 5 })), true); // Fri
  assert.equal(cronMatches(cron, at({ dow: 6 })), false); // Sat
  assert.equal(cronMatches(cron, at({ dow: 0 })), false); // Sun
});

test('cronMatches — Sunday is both 0 and 7', () => {
  assert.equal(cronMatches('0 9 * * 0', at({ dow: 0 })), true);
  assert.equal(cronMatches('0 9 * * 7', at({ dow: 0 })), true); // 7 also matches Sunday
  assert.equal(cronMatches('0 9 * * 1', at({ dow: 0 })), false);
});

test('nowParts — converts a UTC instant into tz wall-clock', () => {
  // 2026-06-26 is a Friday; Europe/Zurich is UTC+2 in June (DST).
  const utc0730 = new Date('2026-06-26T07:30:00Z');
  assert.deepEqual(nowParts('UTC', utc0730), { mi: 30, ho: 7, dom: 26, mon: 6, dow: 5 });
  assert.deepEqual(nowParts('Europe/Zurich', utc0730), { mi: 30, ho: 9, dom: 26, mon: 6, dow: 5 });
});

test('nowParts — crosses the day boundary in a forward tz', () => {
  // 23:30 UTC Fri → 01:30 Sat in Zurich (+2): day, month, and weekday all roll over.
  const lateFri = new Date('2026-06-26T23:30:00Z');
  assert.deepEqual(nowParts('Europe/Zurich', lateFri), { mi: 30, ho: 1, dom: 27, mon: 6, dow: 6 });
});

const route = (over: Partial<SchedulableRoutine>): SchedulableRoutine => ({
  id: 'r1',
  enabled: true,
  cron: '* * * * *',
  tz: 'UTC',
  ...over,
});

test('dueRoutines — fires enabled + matching, skips disabled + non-matching', () => {
  const now = new Date('2026-06-26T09:00:00Z');
  const routines = [
    route({ id: 'r1' }), // every minute, enabled → due
    route({ id: 'r2', enabled: false }), // disabled → skip
    route({ id: 'r3', cron: '0 0 1 1 *' }), // Jan 1 00:00 → not now → skip
  ];
  const due = dueRoutines(routines, now, new Map());
  assert.deepEqual(
    due.map((d) => d.routine.id),
    ['r1'],
  );
});

test('dueRoutines — does not re-fire within the same minute (dedup)', () => {
  const now = new Date('2026-06-26T09:00:00Z');
  const routines = [route({ id: 'r1' })];
  const fired = new Map<string, string>();

  const first = dueRoutines(routines, now, fired);
  assert.equal(first.length, 1);
  fired.set('r1', first[0].key); // caller records the fire

  const second = dueRoutines(routines, now, fired);
  assert.equal(second.length, 0, 'same minute → no second fire');

  // A minute later, the key changes and it becomes due again.
  const later = dueRoutines(routines, new Date('2026-06-26T09:01:00Z'), fired);
  assert.equal(later.length, 1, 'next minute → fires again');
});

test('minuteKey — distinct per wall-clock minute', () => {
  const a: TimeParts = { mi: 0, ho: 9, dom: 26, mon: 6, dow: 5 };
  const b: TimeParts = { mi: 1, ho: 9, dom: 26, mon: 6, dow: 5 };
  assert.notEqual(minuteKey(a), minuteKey(b));
  assert.equal(minuteKey(a), minuteKey({ ...a }));
});

test('groupRoutinesBySlug — groups by slug, sorted, preserves per-slug order', () => {
  const rs = [
    { id: 'r1', slug: 'dorfberg' },
    { id: 'r2', slug: 'caldora' },
    { id: 'r3', slug: 'dorfberg' },
  ];
  assert.deepEqual(groupRoutinesBySlug(rs), [
    { slug: 'caldora', routines: [{ id: 'r2', slug: 'caldora' }] },
    { slug: 'dorfberg', routines: [{ id: 'r1', slug: 'dorfberg' }, { id: 'r3', slug: 'dorfberg' }] },
  ]);
  assert.deepEqual(groupRoutinesBySlug([]), []);
});

test('parseScheduleCommand: classic digest form stays a report', () => {
  assert.deepEqual(parseScheduleCommand(' weekdays 9:00 | status of open PRs '), { kind: 'report', when: 'weekdays 9:00', prompt: 'status of open PRs' });
});
test('parseScheduleCommand: leading task makes a task routine', () => {
  assert.deepEqual(parseScheduleCommand('task weekdays 19:30 | review session'), { kind: 'task', when: 'weekdays 19:30', prompt: 'review session' });
  assert.deepEqual(parseScheduleCommand('TASK cron 30 19 * * 1-5 | x'), { kind: 'task', when: 'cron 30 19 * * 1-5', prompt: 'x' });
});
test('parseScheduleCommand: "taskforce" is not the task keyword; missing bar/when/prompt → usage', () => {
  assert.deepEqual(parseScheduleCommand('taskforce | x'), { kind: 'report', when: 'taskforce', prompt: 'x' });
  assert.deepEqual(parseScheduleCommand('task weekdays 9:00'), { error: 'usage' });
  assert.deepEqual(parseScheduleCommand('task | x'), { error: 'usage' });
  assert.deepEqual(parseScheduleCommand('daily 9:00 |  '), { error: 'usage' });
});

// ── missed-fire catch-up (routine delivery guard) ────────────────────────────────────────────
// 2026-10-12 is a Monday; Europe/Moscow is UTC+3 year-round, so 08:30 MSK = 05:30Z.

test('minuteStart / lastOccurrence — the most recent matching minute at or before now, in the routine tz', () => {
  assert.equal(minuteStart(new Date('2026-10-13T05:30:45.500Z')).toISOString(), '2026-10-13T05:30:00.000Z');
  const brief = '30 8 * * 1-5';
  assert.equal(lastOccurrence(brief, 'Europe/Moscow', new Date('2026-10-13T07:00:00Z'), 24 * 60)?.toISOString(), '2026-10-13T05:30:00.000Z');
  assert.equal(lastOccurrence(brief, 'Europe/Moscow', new Date('2026-10-13T05:30:45Z'), 24 * 60)?.toISOString(), '2026-10-13T05:30:00.000Z'); // "at" counts
  assert.equal(lastOccurrence(brief, 'Europe/Moscow', new Date('2026-10-13T07:00:00Z'), 60), undefined); // outside the walk
  assert.equal(lastOccurrence(brief, 'Europe/Moscow', new Date('2026-10-10T12:00:00Z'), 3 * 24 * 60)?.toISOString(), '2026-10-09T05:30:00.000Z'); // Sat → Friday's
  assert.equal(lastOccurrence('30 8 * * *', 'UTC', new Date('2026-10-13T07:00:00Z'), 24 * 60)?.toISOString(), '2026-10-12T08:30:00.000Z');
});

const owed = (over: Partial<CatchupRoutine>): CatchupRoutine => ({
  id: 'r1',
  enabled: true,
  cron: '30 8 * * 1-5',
  tz: 'Europe/Moscow',
  createdAt: '2026-10-01T00:00:00.000Z',
  ...over,
});
const slots = (rs: CatchupRoutine[], now: string, grace = 6) => missedRoutines(rs, new Date(now), grace).map((m) => [m.routine.id, m.slot.toISOString()]);

test('missedRoutines — a slot the process did not observe is owed, inside the grace window only', () => {
  const r = owed({ lastRunAt: '2026-10-12T05:30:05.000Z' }); // last fire: Monday's
  assert.deepEqual(slots([r], '2026-10-13T07:00:00Z'), [['r1', '2026-10-13T05:30:00.000Z']]); // 10:00 MSK, 1.5 h late
  assert.deepEqual(slots([r], '2026-10-13T11:30:00Z'), [['r1', '2026-10-13T05:30:00.000Z']]); // exactly 6 h: still owed
  assert.deepEqual(slots([r], '2026-10-13T12:00:00Z'), []); // 6.5 h: the window has closed
  assert.deepEqual(slots([r], '2026-10-13T12:00:00Z', 8), [['r1', '2026-10-13T05:30:00.000Z']]); // a wider window
});

test('missedRoutines — fired (even if it failed), running now, disabled, or not yet created → not owed', () => {
  assert.deepEqual(slots([owed({ lastRunAt: '2026-10-13T05:30:05.000Z' })], '2026-10-13T07:00:00Z'), []); // fired on time
  assert.deepEqual(slots([owed({ lastRunAt: '2026-10-13T05:30:05.000Z' })], '2026-10-13T07:00:00Z'), []); // a failed fire is still a fire (the retry's job)
  assert.deepEqual(slots([owed({ lastRunAt: '2026-10-12T05:30:05.000Z' })], '2026-10-13T05:30:20Z'), []); // the current minute is dueRoutines' job
  assert.deepEqual(slots([owed({ lastRunAt: '2026-10-12T05:30:05.000Z', enabled: false })], '2026-10-13T07:00:00Z'), []);
  assert.deepEqual(slots([owed({ createdAt: '2026-10-13T06:00:00.000Z' })], '2026-10-13T07:00:00Z'), []); // created after the slot
  assert.deepEqual(slots([owed({ createdAt: '2026-10-13T04:00:00.000Z' })], '2026-10-13T07:00:00Z'), [['r1', '2026-10-13T05:30:00.000Z']]); // created before it, never ran
  assert.deepEqual(slots([owed({ createdAt: undefined })], '2026-10-13T07:00:00Z'), []); // nothing to measure against
  // A fire skipped because the previous run was still in flight (lastRunAt not stamped) is owed too.
  assert.deepEqual(slots([owed({ lastRunAt: '2026-10-13T05:29:50.000Z' })], '2026-10-13T05:31:00Z'), [['r1', '2026-10-13T05:30:00.000Z']]);
});
