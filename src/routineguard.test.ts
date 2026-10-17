import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  emptySkipDecision,
  skipPatch,
  staleSources,
  GUARD_OFF,
  readRoutineGuard,
  plannedFires,
  fireLabel,
  fireNote,
  slotClock,
  previousRunLine,
  routinePrompt,
  firePatch,
  settlePatch,
  MANUAL_FIRE,
  type GuardedRoutine,
  type RoutineGuard,
} from './routineguard.js';
import { dueRoutines } from './schedule.js';
import { REPORT_FRAMING } from './prompts.js';

// 2026-10-12 is a Monday. Europe/Moscow is UTC+3 all year, so 08:30 MSK = 05:30Z.
const ON: RoutineGuard = { enabled: true, catchupHours: 6, retryMinutes: 15, skipEmpty: false };
const ON_SKIP: RoutineGuard = { ...ON, skipEmpty: true };
const MSK = 'Europe/Moscow';
const brief = (over: Partial<GuardedRoutine> = {}): GuardedRoutine & { slug: string } => ({
  id: 'r1',
  slug: 'owen-ops',
  enabled: true,
  cron: '30 8 * * 1-5',
  tz: MSK,
  prompt: 'Morning brief: calls, mail, tasks',
  createdAt: '2026-10-01T00:00:00.000Z',
  ...over,
});
const d = (iso: string): Date => new Date(iso);

test('readRoutineGuard — off unless ROUTINE_GUARD=1; tuning falls back to defaults', () => {
  assert.deepEqual(readRoutineGuard({}), GUARD_OFF);
  assert.deepEqual(readRoutineGuard({ ROUTINE_GUARD: '0' }), GUARD_OFF);
  assert.deepEqual(readRoutineGuard({ ROUTINE_GUARD: '1' }), { enabled: true, catchupHours: 6, retryMinutes: 15, skipEmpty: false });
  assert.equal(readRoutineGuard({ ROUTINE_GUARD: 'true' }).enabled, true);
  assert.deepEqual(readRoutineGuard({ ROUTINE_GUARD: '1', ROUTINE_GUARD_CATCHUP_HOURS: '3', ROUTINE_GUARD_RETRY_MINUTES: '30' }), {
    enabled: true,
    catchupHours: 3,
    retryMinutes: 30,
    skipEmpty: false,
  });
  const junk = readRoutineGuard({ ROUTINE_GUARD: '1', ROUTINE_GUARD_CATCHUP_HOURS: 'abc', ROUTINE_GUARD_RETRY_MINUTES: '0' });
  assert.deepEqual(junk, { enabled: true, catchupHours: 6, retryMinutes: 15, skipEmpty: false });
});

// ── the production guarantee: guard off == today's scheduler, prompt, label and stamp ────────

test('plannedFires — guard off is exactly dueRoutines, whatever the records carry (prod byte-identity)', () => {
  const now = d('2026-10-13T07:00:00Z'); // Tue 10:00 MSK: the 08:30 slot was missed
  const routines = [
    brief({ lastRunAt: '2026-10-12T05:30:05.000Z' }), // missed today's slot (guard-on would fire it late)
    brief({ id: 'r2', cron: '* * * * *', lastOutcome: 'error', retry: { at: '2026-10-13T06:00:00.000Z', slot: '2026-10-13T05:45:00.000Z' } }), // due + a retry pending
    brief({ id: 'r3', cron: '* * * * *', enabled: false }),
  ];
  const fired = new Map<string, string>();
  const expected = dueRoutines(routines, now, fired).map((x) => ({ routine: x.routine, key: x.key, mode: 'scheduled', slot: d('2026-10-13T07:00:00Z') }));
  assert.deepEqual(plannedFires(routines, now, fired, GUARD_OFF), { fires: expected, skips: [] });
  assert.deepEqual(expected.map((f) => f.routine.id), ['r2']); // the missed r1 stays missed, the retry never fires
});

test('routinePrompt / fireLabel / firePatch — guard off: framing + prompt, bare label, lastRunAt alone (prod byte-identity)', () => {
  const r = brief({ lastRunAt: '2026-10-09T05:30:05.000Z', lastOutcome: 'error', lastReason: 'boom' });
  const now = d('2026-10-13T05:30:10Z');
  const fire = { mode: 'scheduled' as const, slot: d('2026-10-13T05:30:00Z') };
  assert.equal(routinePrompt(REPORT_FRAMING, r, fire, GUARD_OFF, now), REPORT_FRAMING + r.prompt);
  assert.equal(routinePrompt(REPORT_FRAMING, r, MANUAL_FIRE, GUARD_OFF, now), REPORT_FRAMING + r.prompt);
  assert.equal(fireLabel('📋 Morning brief', fire, MSK, now), '📋 Morning brief');
  assert.equal(fireLabel('📋 Morning brief', MANUAL_FIRE, MSK, now), '📋 Morning brief');
  assert.deepEqual(firePatch(now, fire, GUARD_OFF), { lastRunAt: '2026-10-13T05:30:10.000Z' });
  assert.deepEqual(Object.keys(firePatch(now, MANUAL_FIRE, GUARD_OFF)), ['lastRunAt']);
});

// ── guard on ────────────────────────────────────────────────────────────────────────────────

test('plannedFires — a slot the bot slept through fires as a late run; one it already served does not', () => {
  const now = d('2026-10-13T07:00:00Z');
  const missed = brief({ lastRunAt: '2026-10-12T05:30:05.000Z' });
  const served = brief({ id: 'r2', lastRunAt: '2026-10-13T05:30:04.000Z', lastOutcome: 'ok' });
  const failed = brief({ id: 'r3', lastRunAt: '2026-10-13T05:30:04.000Z', lastOutcome: 'error' }); // the retry path's, not catch-up's
  const { fires, skips } = plannedFires([missed, served, failed], now, new Map(), ON);
  assert.deepEqual(skips, []);
  assert.deepEqual(
    fires.map((f) => ({ id: f.routine.id, mode: f.mode, slot: f.slot?.toISOString(), key: f.key })),
    [{ id: 'r1', mode: 'late', slot: '2026-10-13T05:30:00.000Z', key: undefined }],
  );
});

test('plannedFires — a due routine is fired once per minute even across a restart (lastRunAt dedupe), and a due routine is never also "late"', () => {
  const now = d('2026-10-13T05:30:40Z');
  // The previous process fired this minute at :05 and was restarted — the new process must not post again.
  const r = brief({ lastRunAt: '2026-10-13T05:30:05.000Z' });
  const plan = plannedFires([r], now, new Map(), ON);
  assert.deepEqual(plan.fires, []);
  assert.deepEqual(plan.skips.map((s) => [s.routine.id, s.reason]), [['r1', 'already fired this minute by a previous process']]);
  // Not fired yet this minute → the ordinary scheduled fire, with the dedupe key for firedThisMinute.
  const fresh = plannedFires([brief({ lastRunAt: '2026-10-12T05:30:05.000Z' })], now, new Map(), ON);
  assert.equal(fresh.fires.length, 1);
  assert.equal(fresh.fires[0]!.mode, 'scheduled');
  assert.ok(fresh.fires[0]!.key);
});

test('plannedFires — a pending retry fires at its time, inside the grace window, for a failed enabled routine', () => {
  const retry = { at: '2026-10-13T05:45:05.000Z', slot: '2026-10-13T05:30:00.000Z' };
  const r = brief({ lastRunAt: '2026-10-13T05:30:05.000Z', lastOutcome: 'error', lastReason: 'gh down', retry });
  const ids = (p: ReturnType<typeof plannedFires<typeof r>>) => p.fires.map((f) => [f.routine.id, f.mode, f.slot?.toISOString()]);
  assert.deepEqual(ids(plannedFires([r], d('2026-10-13T05:40:00Z'), new Map(), ON)), []); // not yet
  assert.deepEqual(ids(plannedFires([r], d('2026-10-13T05:46:00Z'), new Map(), ON)), [['r1', 'retry', '2026-10-13T05:30:00.000Z']]);
  // Disabled since / grace window over / last run did not fail / unreadable → dropped, with the record cleared.
  const dropped = [
    plannedFires([{ ...r, enabled: false }], d('2026-10-13T05:46:00Z'), new Map(), ON),
    plannedFires([r], d('2026-10-13T12:00:00Z'), new Map(), ON),
    plannedFires([{ ...r, lastOutcome: 'ok' }], d('2026-10-13T05:46:00Z'), new Map(), ON),
    plannedFires([{ ...r, retry: { at: 'nope', slot: 'nope' } }], d('2026-10-13T05:46:00Z'), new Map(), ON),
  ];
  for (const p of dropped) {
    assert.deepEqual(p.fires, []);
    assert.equal(p.skips.length, 1);
    assert.equal(p.skips[0]!.clearRetry, true);
  }
  assert.match(dropped[1]!.skips[0]!.reason, /grace window of the 08:30 slot has passed/);
});

test('plannedFires — dreams and housekeeping are never caught up or retried', () => {
  const now = d('2026-10-13T02:00:00Z'); // 05:00 MSK; the 03:00 MSK dream slot is two hours old
  const dream = brief({ id: 'r9', kind: 'dream', cron: '0 3 * * *', lastRunAt: '2026-10-11T00:00:03.000Z' });
  assert.deepEqual(plannedFires([dream], now, new Map(), ON).fires, []);
  const hk = brief({ id: 'r8', kind: 'housekeeping', cron: '0 3 * * *', lastRunAt: '2026-10-11T00:00:03.000Z', lastOutcome: 'error', retry: { at: '2026-10-13T00:15:00.000Z', slot: '2026-10-13T00:00:00.000Z' } });
  assert.deepEqual(plannedFires([hk], now, new Map(), ON).fires, []);
});

test('slotClock / fireLabel / fireNote — local clock, weekday when not today, late and retry markers', () => {
  const now = d('2026-10-13T07:00:00Z');
  assert.equal(slotClock(d('2026-10-13T05:30:00Z'), MSK, now), '08:30');
  assert.equal(slotClock(d('2026-10-12T15:30:00Z'), MSK, now), 'Mon 18:30');
  assert.equal(fireLabel('📋 Morning brief', { mode: 'late', slot: d('2026-10-13T05:30:00Z') }, MSK, now), '📋 Morning brief · late run (missed 08:30)');
  assert.equal(fireLabel('📋 Evening close', { mode: 'late', slot: d('2026-10-12T15:30:00Z') }, MSK, now), '📋 Evening close · late run (missed Mon 18:30)');
  assert.equal(fireLabel('📋 Morning brief', { mode: 'retry', slot: d('2026-10-13T05:30:00Z') }, MSK, now), '📋 Morning brief · retry');
  assert.equal(fireNote({ mode: 'late', slot: d('2026-10-13T05:30:00Z') }, MSK, now), 'late run (missed 08:30)');
  assert.equal(fireNote({ mode: 'retry', slot: d('2026-10-13T05:30:00Z') }, MSK, now), 'retry of the 08:30 slot');
  assert.equal(fireNote(MANUAL_FIRE, MSK, now), 'manual');
  assert.equal(fireNote({ mode: 'scheduled', slot: now }, MSK, now), 'scheduled');
});

test('previousRunLine — the state line is rendered from the record, never guessed', () => {
  const tue = { mode: 'scheduled' as const, slot: d('2026-10-13T05:30:00Z') };
  const now = d('2026-10-13T05:30:10Z');
  const P = '[Routine state] Previous run of this routine: ';
  // Delivered yesterday.
  assert.equal(
    previousRunLine(brief({ lastRunAt: '2026-10-12T05:30:05.000Z', lastOutcome: 'ok', lastDeliveredAt: '2026-10-12T05:33:40.000Z' }), tue, now),
    `${P}ok at 2026-10-12T05:30:05Z (08:30 Europe/Moscow) (delivered: 2026-10-12T05:33:40Z (08:33 Europe/Moscow)).`,
  );
  // Yesterday's slot never fired (last fire was Friday's): a miss, not "ok".
  assert.equal(
    previousRunLine(brief({ lastRunAt: '2026-10-09T05:30:05.000Z', lastOutcome: 'ok', lastDeliveredAt: '2026-10-09T05:33:40.000Z' }), tue, now),
    `${P}missed at 2026-10-12T05:30:00Z (08:30 Europe/Moscow) — the scheduled run did not fire.`,
  );
  // Failed yesterday, and that was already the retry.
  assert.equal(
    previousRunLine(brief({ lastRunAt: '2026-10-12T05:45:10.000Z', lastOutcome: 'error', lastReason: 'gh auth login failed', lastFire: 'retry' }), tue, now),
    `${P}error at 2026-10-12T05:45:10Z (08:45 Europe/Moscow) (not delivered: gh auth login failed; that was already the automatic retry).`,
  );
  assert.equal(previousRunLine(brief({ lastRunAt: '2026-10-12T05:30:05.000Z', lastOutcome: 'canceled' }), tue, now), `${P}canceled at 2026-10-12T05:30:05Z (08:30 Europe/Moscow) (not delivered).`);
  // Fired, but the bot restarted mid-run: no outcome on record — say so.
  assert.equal(previousRunLine(brief({ lastRunAt: '2026-10-12T05:30:05.000Z' }), tue, now), `${P}started at 2026-10-12T05:30:05Z (08:30 Europe/Moscow), outcome not recorded.`);
  // Created after yesterday's slot → nothing was owed, nothing recorded.
  assert.equal(previousRunLine(brief({ createdAt: '2026-10-13T04:00:00.000Z' }), tue, now), `${P}none recorded.`);
});

test('previousRunLine — a late run and a retry announce themselves; a manual fire anchors on now', () => {
  const ok = brief({ lastRunAt: '2026-10-12T05:30:05.000Z', lastOutcome: 'ok', lastDeliveredAt: '2026-10-12T05:33:40.000Z' });
  const late = previousRunLine(ok, { mode: 'late', slot: d('2026-10-13T05:30:00Z') }, d('2026-10-13T07:00:00Z'));
  assert.ok(late.startsWith('[Routine state] Previous run of this routine: ok at 2026-10-12T05:30:05Z'));
  assert.ok(late.endsWith(' This run is a late catch-up of the 08:30 slot, fired at 2026-10-13T07:00:00Z (10:00 Europe/Moscow).'));
  const failed = brief({ lastRunAt: '2026-10-13T05:30:05.000Z', lastOutcome: 'error', lastReason: 'boom', lastFire: 'scheduled' });
  const retry = previousRunLine(failed, { mode: 'retry', slot: d('2026-10-13T05:30:00Z') }, d('2026-10-13T05:46:00Z'));
  assert.equal(retry, '[Routine state] Previous run of this routine: error at 2026-10-13T05:30:05Z (08:30 Europe/Moscow) (not delivered: boom). This run is the automatic retry of that failed attempt.');
  // Manual at 09:00 after an on-time 08:30: the previous slot ran → its outcome.
  const manual = previousRunLine(brief({ lastRunAt: '2026-10-13T05:30:05.000Z', lastOutcome: 'ok', lastDeliveredAt: '2026-10-13T05:33:00.000Z' }), MANUAL_FIRE, d('2026-10-13T06:00:00Z'));
  assert.ok(manual.startsWith('[Routine state] Previous run of this routine: ok at 2026-10-13T05:30:05Z'));
});

test('routinePrompt — guard on: the state line, a blank line, then the historical framing + prompt', () => {
  const r = brief({ lastRunAt: '2026-10-12T05:30:05.000Z', lastOutcome: 'ok', lastDeliveredAt: '2026-10-12T05:33:40.000Z' });
  const fire = { mode: 'scheduled' as const, slot: d('2026-10-13T05:30:00Z') };
  const p = routinePrompt(REPORT_FRAMING, r, fire, ON, d('2026-10-13T05:30:10Z'));
  assert.equal(p, `${previousRunLine(r, fire, d('2026-10-13T05:30:10Z'))}\n\n${REPORT_FRAMING}${r.prompt}`);
  assert.ok(p.startsWith('[Routine state] '));
});

test('firePatch — guard on: stamps the fire kind and clears the previous run\'s outcome and any pending retry', () => {
  const p = firePatch(d('2026-10-13T07:00:00Z'), { mode: 'late', slot: d('2026-10-13T05:30:00Z') }, ON);
  assert.equal(p.lastRunAt, '2026-10-13T07:00:00.000Z');
  assert.equal(p.lastFire, 'late');
  for (const k of ['lastOutcome', 'lastReason', 'lastDeliveredAt', 'lastSummary', 'retry'] as const) {
    assert.ok(k in p, `${k} present`);
    assert.equal(p[k], undefined, `${k} cleared`);
  }
});

test('settlePatch — ok records delivery + headline; canceled records; error schedules the one retry only while it fits the grace window', () => {
  const slot = d('2026-10-13T05:30:00Z');
  const sched = { mode: 'scheduled' as const, slot };
  const ok = settlePatch(sched, 'ok', { headline: 'Утро, 13 октября — звонков 3' }, d('2026-10-13T05:33:40Z'), ON);
  assert.deepEqual(ok.patch, { lastOutcome: 'ok', lastDeliveredAt: '2026-10-13T05:33:40.000Z', lastSummary: 'Утро, 13 октября — звонков 3', lastReason: undefined });
  assert.equal(ok.note, 'delivered — Утро, 13 октября — звонков 3');
  assert.deepEqual(settlePatch(sched, 'canceled', {}, d('2026-10-13T05:33:40Z'), ON).patch, { lastOutcome: 'canceled', lastReason: undefined });
  // Error 2 min in → retry 15 min later, well inside the 6 h window.
  const err = settlePatch(sched, 'error', { reason: 'gh auth login failed (exit 1): EOF' }, d('2026-10-13T05:32:00Z'), ON);
  assert.deepEqual(err.patch, { lastOutcome: 'error', lastReason: 'gh auth login failed (exit 1): EOF', retry: { at: '2026-10-13T05:47:00.000Z', slot: '2026-10-13T05:30:00.000Z' } });
  assert.match(err.note, /one retry at 2026-10-13T05:47:00\.000Z/);
  // A late run that fails 5 h 50 min after its slot: the retry would land past the window → none.
  const lateFail = settlePatch({ mode: 'late', slot }, 'error', { reason: 'x' }, d('2026-10-13T11:20:00Z'), ON);
  assert.equal(lateFail.patch.retry, undefined);
  assert.match(lateFail.note, /grace window is over/);
  // A late run that fails early enough still gets its retry.
  assert.ok(settlePatch({ mode: 'late', slot }, 'error', { reason: 'x' }, d('2026-10-13T07:00:00Z'), ON).patch.retry);
  // The retry's own failure, and a manual run's, are final.
  assert.equal(settlePatch({ mode: 'retry', slot }, 'error', { reason: 'x' }, d('2026-10-13T05:47:00Z'), ON).patch.retry, undefined);
  assert.match(settlePatch({ mode: 'retry', slot }, 'error', { reason: 'x' }, d('2026-10-13T05:47:00Z'), ON).note, /giving up/);
  assert.equal(settlePatch(MANUAL_FIRE, 'error', { reason: 'x' }, d('2026-10-13T05:47:00Z'), ON).patch.retry, undefined);
  // The reason is bounded and never empty.
  assert.equal(settlePatch(sched, 'error', {}, d('2026-10-13T05:32:00Z'), ON).patch.lastReason, 'unknown error');
  assert.equal(settlePatch(sched, 'error', { reason: 'y'.repeat(500) }, d('2026-10-13T05:32:00Z'), ON).patch.lastReason!.length, 200);
});

// ── empty-slot skip ──────────────────────────────────────────────────────────────────────
const delivered = (over: Partial<GuardedRoutine> = {}): GuardedRoutine & { slug: string } =>
  brief({ lastRunAt: '2026-10-14T05:30:05Z', lastOutcome: 'ok', lastDeliveredAt: '2026-10-14T05:31:40Z', lastDeliveredRawCount: 1000, ...over });
const SCHEDULED = { mode: 'scheduled' as const, slot: d('2026-10-14T15:30:00Z') };
const FRESH = [{ kind: 'slack', ok: true, ageMinutes: 3 }, { kind: 'youtrack', ok: true, ageMinutes: 12 }];
const quiet = (over: Partial<Parameters<typeof emptySkipDecision>[0]> = {}) => ({
  fire: SCHEDULED, routine: delivered(), hasSources: true, rawCount: 1000, due: { escalationsOpen: 0, commitmentsDue: 0 }, sources: FRESH, intervalMinutes: 15, ...over,
});

test('readRoutineGuard — ROUTINE_SKIP_EMPTY needs the guard; off otherwise', () => {
  assert.equal(readRoutineGuard({ ROUTINE_GUARD: '1', ROUTINE_SKIP_EMPTY: '1' }).skipEmpty, true);
  assert.equal(readRoutineGuard({ ROUTINE_GUARD: '1' }).skipEmpty, false);
  assert.equal(readRoutineGuard({ ROUTINE_SKIP_EMPTY: '1' }).skipEmpty, false, 'the skip rides on the guard: no guard, no skip');
  assert.equal(readRoutineGuard({}).skipEmpty, false);
});

test('emptySkipDecision — skips only a scheduled/late slot with the guard+flag on, a delivered baseline, zero delta, nothing due and fresh sources', () => {
  const now = d('2026-10-14T15:30:02Z');
  const yes = emptySkipDecision(quiet(), ON_SKIP, now, MSK);
  assert.equal(yes.skip, true);
  assert.equal((yes as { message: string }).message, '⏭ nothing new since 2026-10-14T05:31:40Z (08:31 Europe/Moscow) (sources: slack 3 min, youtrack 12 min)');
  assert.equal(emptySkipDecision(quiet({ fire: { mode: 'late', slot: d('2026-10-14T15:30:00Z') } }), ON_SKIP, now, MSK).skip, true, 'a late catch-up of an empty slot is skipped too');
  const no = (over: Parameters<typeof quiet>[0], guard = ON_SKIP) => (emptySkipDecision(quiet(over), guard, now, MSK) as { skip: false; reason: string });
  assert.match(no({}, ON).reason, /empty-skip off/);
  assert.match(no({}, { ...ON_SKIP, enabled: false }).reason, /empty-skip off/, 'flag without the guard is off');
  assert.match(no({ fire: { mode: 'manual' } }).reason, /manual/);
  assert.match(no({ fire: { mode: 'retry', slot: d('2026-10-14T15:30:00Z') } }).reason, /retry/);
  assert.match(no({ routine: delivered({ kind: 'dream' }) }).reason, /not a turn routine/);
  assert.match(no({ routine: delivered({ skipEmpty: false }) }).reason, /opted out/);
  assert.match(no({ hasSources: false }).reason, /no sources/);
  assert.match(no({ routine: delivered({ lastDeliveredRawCount: undefined }) }).reason, /no delivered run/);
  assert.match(no({ routine: delivered({ lastDeliveredAt: undefined }) }).reason, /no delivered run/);
  assert.match(no({ rawCount: undefined }).reason, /replica unreadable/);
  assert.match(no({ rawCount: 900 }).reason, /store rebuilt/);
  assert.match(no({ rawCount: 1007 }).reason, /7 new raw record/);
  assert.match(no({ due: undefined }).reason, /tenant checkout unreadable/);
  assert.match(no({ due: { escalationsOpen: 1, commitmentsDue: 0 } }).reason, /1 open escalation/);
  assert.match(no({ due: { escalationsOpen: 0, commitmentsDue: 2 } }).reason, /2 commitment/);
  assert.match(no({ sources: [{ kind: 'slack', ok: true, ageMinutes: 31 }] }).reason, /stale source\(s\): slack 31 min/);
  assert.match(no({ sources: [{ kind: 'gmail', ok: false, ageMinutes: 2 }] }).reason, /gmail last pass failed/);
  assert.match(no({ sources: [{ kind: 'jira', ok: true }] }).reason, /jira never pulled/);
  assert.deepEqual(staleSources(FRESH, 15), []);
});

test('skipPatch — the slot counts as served with outcome skipped; the delivered run\'s fields are not in the patch', () => {
  const patch = skipPatch(d('2026-10-14T15:30:02Z'), SCHEDULED);
  assert.deepEqual(patch, { lastRunAt: '2026-10-14T15:30:02.000Z', lastFire: 'scheduled', lastOutcome: 'skipped', lastReason: undefined, retry: undefined });
  assert.ok(!('lastDeliveredAt' in patch) && !('lastDeliveredRawCount' in patch) && !('lastSummary' in patch));
});

test('previousRunLine — after a skip the next run names the skip AND the last delivered run; the skipped slot is not "missed"', () => {
  const r = delivered({ lastRunAt: '2026-10-14T15:30:02Z', lastOutcome: 'skipped', lastFire: 'scheduled' });
  const line = previousRunLine(r, { mode: 'scheduled', slot: d('2026-10-14T16:30:00Z') }, d('2026-10-14T16:30:01Z'));
  assert.match(line, /skipped at 2026-10-14T15:30:02Z \(18:30 Europe\/Moscow\) — nothing new in the sources and nothing due, so no run \(last delivered: 2026-10-14T05:31:40Z \(08:31 Europe\/Moscow\)\)/);
  assert.doesNotMatch(line, /missed/);
});


test('settlePatch — routine gathers answers: a failed run that already sent tasks to other agents is not retried; one without retries as today (agent-messaging D15)', () => {
  const slot = d('2026-10-13T05:30:00Z');
  const fire = { mode: 'scheduled' as const, slot };
  const withTasks = settlePatch(fire, 'error', { reason: 'boom', startedTasks: 3 }, d('2026-10-13T05:32:00Z'), ON);
  assert.equal(withTasks.patch.retry, undefined);
  assert.equal(withTasks.patch.lastOutcome, 'error');
  assert.match(withTasks.note, /failed after sending 3 task\(s\) to other agents — no retry/);
  const without = settlePatch(fire, 'error', { reason: 'boom' }, d('2026-10-13T05:32:00Z'), ON);
  assert.ok(without.patch.retry, 'a run without tasks keeps its one retry');
});
