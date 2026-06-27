import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseSchedule,
  cronFieldMatch,
  cronMatches,
  nowParts,
  dueRoutines,
  minuteKey,
  groupRoutinesBySlug,
  type TimeParts,
  type SchedulableRoutine,
} from './schedule.js';

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
