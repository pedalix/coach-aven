// Routine delivery guard — the deterministic half of "a scheduled run lands, or says why not"
// (docs/runtime-config.md → *Routine delivery guard*). Three pieces, all pure decisions over the
// routine record in state.json, wired by pollers.ts:
//   • missed-fire catch-up: a cron minute the process did not observe (host asleep, restart,
//     in-flight skip) is fired on the next tick as a "late run", inside a grace window;
//   • outcome + one retry: every run records how it settled (ok / error / canceled) on its
//     routine, and a scheduled run that errored is re-fired ONCE after a delay while its slot
//     is still inside the grace window;
//   • a "previous run" preamble the BOT renders from that record and prepends to the routine
//     prompt, so the agent never guesses whether yesterday's run happened.
// Everything sits behind ONE switch, ROUTINE_GUARD=1, read once at boot. With it off every
// function here collapses to today's behaviour — the scheduler fires the current minute only,
// the prompt is framing + routine prompt, the fire stamp is lastRunAt alone — and
// routineguard.test.ts pins that, because this code also runs the production bot, where the
// switch stays off until the guard has proven itself on the home bot.
import { dueRoutines, lastOccurrence, minuteStart, missedRoutines, nowParts, type CatchupRoutine } from './schedule.js';

export interface RoutineGuard {
  enabled: boolean;
  catchupHours: number; // how long after its slot a missed run is still fired (and a retry still allowed)
  retryMinutes: number; // minimum delay before the one retry of a failed run
  // ROUTINE_SKIP_EMPTY=1 (needs the guard): a scheduled/late slot with nothing new in the
  // project's sources and nothing due in its tenant ledgers posts one line instead of a turn.
  skipEmpty: boolean;
}

export const GUARD_OFF: RoutineGuard = { enabled: false, catchupHours: 6, retryMinutes: 15, skipEmpty: false };

// Pure: env → switch. Only "1"/"true" turns it on; malformed tuning falls back to the defaults
// rather than disabling anything.
export function readRoutineGuard(env: Record<string, string | undefined>): RoutineGuard {
  const num = (v: string | undefined, dflt: number): number => {
    const n = Number(v);
    return v !== undefined && v.trim() !== '' && Number.isFinite(n) && n > 0 ? n : dflt;
  };
  const enabled = env.ROUTINE_GUARD === '1' || env.ROUTINE_GUARD === 'true';
  return {
    enabled,
    catchupHours: num(env.ROUTINE_GUARD_CATCHUP_HOURS, GUARD_OFF.catchupHours),
    retryMinutes: num(env.ROUTINE_GUARD_RETRY_MINUTES, GUARD_OFF.retryMinutes),
    skipEmpty: enabled && (env.ROUTINE_SKIP_EMPTY === '1' || env.ROUTINE_SKIP_EMPTY === 'true'),
  };
}

// Read once at boot — a restart applies a change, like every other env switch of the bot.
export const routineGuard: RoutineGuard = readRoutineGuard(process.env);

// 'skipped' = the empty-slot skip (no turn ran; the last DELIVERED run's fields stay as they were).
export type RoutineOutcome = 'ok' | 'error' | 'canceled' | 'skipped';
export type FireMode = 'scheduled' | 'late' | 'retry' | 'manual';

// The routine fields the guard reads and writes (state.ts' RoutineRecord satisfies it).
export interface GuardedRoutine extends CatchupRoutine {
  kind?: string;
  prompt: string;
  lastOutcome?: RoutineOutcome;
  lastReason?: string;
  lastDeliveredAt?: string;
  lastSummary?: string;
  lastFire?: FireMode;
  retry?: { at: string; slot: string };
  // Empty-slot skip: opt-out, and the raw-record count of the replica when the last run was delivered.
  skipEmpty?: boolean;
  lastDeliveredRawCount?: number;
}

// The fields the guard writes (what firePatch/settlePatch return — assignable to a RoutineRecord patch).
export type GuardPatch = Partial<Pick<GuardedRoutine, 'lastRunAt' | 'lastOutcome' | 'lastReason' | 'lastDeliveredAt' | 'lastSummary' | 'lastFire' | 'retry' | 'lastDeliveredRawCount'>>;

// One fire: WHY it fires and, unless manual, the cron slot it serves.
export interface Fire {
  mode: FireMode;
  slot?: Date;
}
export const MANUAL_FIRE: Fire = { mode: 'manual' };

export interface PlannedFire<T> extends Fire {
  routine: T;
  key?: string; // the minute key for firedThisMinute — due fires only
}
export interface PlannedSkip<T> {
  routine: T;
  reason: string;
  clearRetry?: boolean; // a stale retry record the tick should drop
}

// Only report/task routines run a Slack turn; dreams and housekeeping have their own silent
// paths, and a nightly job caught up at noon is noise, not delivery.
const turnKind = (kind: string | undefined): boolean => kind === undefined || kind === 'report' || kind === 'task';

// The scheduler tick's whole decision. Guard off: exactly dueRoutines (the current minute, once
// per minute, in-memory dedupe) — nothing else. Guard on, additionally:
//   • a due routine whose last fire is already stamped at/after this minute was fired by a
//     previous process (the bot restarted inside the fire minute) — skipped, not double-posted;
//   • missed slots inside the grace window fire as late runs (schedule.ts missedRoutines);
//   • a pending retry fires once its time has come — unless the routine was disabled since, the
//     slot's grace window has passed, or the last run did not actually fail (stale record).
// A routine is planned at most once per tick.
export function plannedFires<T extends GuardedRoutine>(
  routines: T[],
  now: Date,
  firedThisMinute: Map<string, string>,
  guard: RoutineGuard,
): { fires: PlannedFire<T>[]; skips: PlannedSkip<T>[] } {
  const minute = minuteStart(now);
  const due: PlannedFire<T>[] = dueRoutines(routines, now, firedThisMinute).map((d) => ({
    routine: d.routine,
    key: d.key,
    mode: 'scheduled' as const,
    slot: minute,
  }));
  const skips: PlannedSkip<T>[] = [];
  if (!guard.enabled) return { fires: due, skips };
  const fires: PlannedFire<T>[] = [];
  const planned = new Set<string>();
  for (const f of due) {
    const last = Date.parse(f.routine.lastRunAt ?? '');
    if (Number.isFinite(last) && last >= minute.getTime()) {
      skips.push({ routine: f.routine, reason: 'already fired this minute by a previous process' });
      continue;
    }
    fires.push(f);
    planned.add(f.routine.id);
  }
  for (const { routine, slot } of missedRoutines(routines, now, guard.catchupHours)) {
    if (planned.has(routine.id) || !turnKind(routine.kind)) continue;
    fires.push({ routine, mode: 'late', slot });
    planned.add(routine.id);
  }
  for (const r of routines) {
    if (!r.retry || planned.has(r.id) || !turnKind(r.kind)) continue;
    const at = Date.parse(r.retry.at);
    const slot = Date.parse(r.retry.slot);
    if (!Number.isFinite(at) || !Number.isFinite(slot)) {
      skips.push({ routine: r, reason: 'retry record unreadable — dropped', clearRetry: true });
      continue;
    }
    if (at > now.getTime()) continue; // not yet
    if (!r.enabled) {
      skips.push({ routine: r, reason: 'retry due but the routine is disabled — dropped', clearRetry: true });
      continue;
    }
    if (now.getTime() > slot + guard.catchupHours * 3_600_000) {
      skips.push({ routine: r, reason: `retry due but the grace window of the ${slotClock(new Date(slot), r.tz, now)} slot has passed — dropped`, clearRetry: true });
      continue;
    }
    if (r.lastOutcome !== 'error') {
      skips.push({ routine: r, reason: 'retry due but the last run did not fail — dropped', clearRetry: true });
      continue;
    }
    fires.push({ routine: r, mode: 'retry', slot: new Date(slot) });
    planned.add(r.id);
  }
  return { fires, skips };
}

const DOW_NAME = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const pad = (n: number): string => String(n).padStart(2, '0');

// "08:30" in the routine's tz — "Mon 18:30" when the slot is not on today's local date.
export function slotClock(slot: Date, tz: string, now: Date): string {
  const p = nowParts(tz, slot);
  const n = nowParts(tz, now);
  const hm = `${pad(p.ho)}:${pad(p.mi)}`;
  return p.dom === n.dom && p.mon === n.mon ? hm : `${DOW_NAME[p.dow]} ${hm}`;
}

// The parent message's label for this fire: the routine's own label for a scheduled or manual
// run (today's text), a visible marker for a late run or a retry.
export function fireLabel(base: string, fire: Fire, tz: string, now: Date): string {
  if (fire.mode === 'late' && fire.slot) return `${base} · late run (missed ${slotClock(fire.slot, tz, now)})`;
  if (fire.mode === 'retry') return `${base} · retry`;
  return base;
}

// One-line description of a fire for the log.
export function fireNote(fire: Fire, tz: string, now: Date): string {
  if (fire.mode === 'late' && fire.slot) return `late run (missed ${slotClock(fire.slot, tz, now)})`;
  if (fire.mode === 'retry' && fire.slot) return `retry of the ${slotClock(fire.slot, tz, now)} slot`;
  return fire.mode;
}

// "2026-10-13T05:31:12Z (08:31 Europe/Moscow)" — the stored ISO (UTC, seconds) plus the local
// clock, so the agent reads it right whatever its own shell's tz is.
function stamp(iso: string, tz: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  const p = nowParts(tz, new Date(t));
  return `${new Date(t).toISOString().replace(/\.\d{3}Z$/, 'Z')} (${pad(p.ho)}:${pad(p.mi)} ${tz})`;
}

// How far back the "previous slot" lookup walks (covers weekly routines).
const PREVIOUS_SLOT_LOOKBACK_MINUTES = 8 * 24 * 60;

// The deterministic preamble: what happened to the previous run of this routine, from state —
// never from the agent's memory of yesterday. The slot before the one this fire serves (a manual
// fire serves "now") decides "missed": if it is later than the last fire — and the routine
// already existed then — nothing ran for it. Otherwise the recorded outcome of the last fire is
// reported as is, including "outcome not recorded" (the bot restarted mid-run) and "none
// recorded" (a routine that has not run under the guard yet). A late run or a retry says so too.
export function previousRunLine(r: GuardedRoutine, fire: Fire, now: Date): string {
  const lastRun = Date.parse(r.lastRunAt ?? '');
  const created = Date.parse(r.createdAt ?? '');
  const anchor = fire.slot ?? minuteStart(now);
  const prev = lastOccurrence(r.cron, r.tz, new Date(anchor.getTime() - 60_000), PREVIOUS_SLOT_LOOKBACK_MINUTES);
  const at = r.lastRunAt ? stamp(r.lastRunAt, r.tz) : 'an unknown time';
  let state: string;
  if (prev && (!Number.isFinite(lastRun) || prev.getTime() > lastRun) && (!Number.isFinite(created) || prev.getTime() > created)) {
    state = `missed at ${stamp(prev.toISOString(), r.tz)} — the scheduled run did not fire`;
  } else if (r.lastOutcome === 'ok') {
    state = `ok at ${at} (delivered: ${r.lastDeliveredAt ? stamp(r.lastDeliveredAt, r.tz) : 'unknown'})`;
  } else if (r.lastOutcome === 'error') {
    state = `error at ${at} (not delivered: ${r.lastReason ?? 'unknown error'}${r.lastFire === 'retry' ? '; that was already the automatic retry' : ''})`;
  } else if (r.lastOutcome === 'skipped') {
    state = `skipped at ${at} — nothing new in the sources and nothing due, so no run (last delivered: ${r.lastDeliveredAt ? stamp(r.lastDeliveredAt, r.tz) : 'unknown'})`;
  } else if (r.lastOutcome === 'canceled') {
    state = `canceled at ${at} (not delivered)`;
  } else if (r.lastRunAt) {
    state = `started at ${at}, outcome not recorded`;
  } else {
    state = 'none recorded';
  }
  let thisRun = '';
  if (fire.mode === 'late' && fire.slot) thisRun = ` This run is a late catch-up of the ${slotClock(fire.slot, r.tz, now)} slot, fired at ${stamp(now.toISOString(), r.tz)}.`;
  else if (fire.mode === 'retry') thisRun = ' This run is the automatic retry of that failed attempt.';
  return `[Routine state] Previous run of this routine: ${state}.${thisRun}`;
}

// The prompt a fire sends. Guard off: framing + routine prompt, byte for byte what pollers.ts
// always sent. Guard on: the state line first, then the same text.
export function routinePrompt(framing: string, r: GuardedRoutine, fire: Fire, guard: RoutineGuard, now: Date): string {
  if (!guard.enabled) return framing + r.prompt;
  return `${previousRunLine(r, fire, now)}\n\n${framing}${r.prompt}`;
}

// The routine patch at fire time. Guard off: today's stamp and nothing else. Guard on: a new run
// whose outcome is unknown until it settles — the previous run's fields must not masquerade as
// this one's, so they are cleared (a restart mid-run leaves "outcome not recorded", which is the
// truth), and a pending retry is consumed by whatever fire this is.
export function firePatch(now: Date, fire: Fire, guard: RoutineGuard): GuardPatch & { lastRunAt: string } {
  const lastRunAt = now.toISOString();
  if (!guard.enabled) return { lastRunAt };
  return { lastRunAt, lastFire: fire.mode, lastOutcome: undefined, lastReason: undefined, lastDeliveredAt: undefined, lastSummary: undefined, retry: undefined };
}

export interface SettleInfo {
  headline?: string; // ok: the answer's first line (routinerun.ts headline)
  reason?: string; // error: the failure, already shortened to one line
  key?: string; // the run's conversation key
  // Tasks the run sent to other agents (agent-messaging D15): their answers continue in its thread,
  // so a failed run that sent any is not retried — the retry would send them again.
  startedTasks?: number;
}

// The routine patch when its turn settles, plus a one-line log note. An error schedules the ONE
// retry — ≥ retryMinutes later, only for a scheduled or late fire whose slot is still inside the
// grace window at that time. A retry's own failure, a manual run's failure and a cancel stay as
// they are: recorded, not re-fired.
export function settlePatch(
  fire: Fire,
  outcome: RoutineOutcome,
  info: SettleInfo,
  now: Date,
  guard: RoutineGuard,
): { patch: GuardPatch; note: string } {
  if (outcome === 'ok') {
    return {
      patch: { lastOutcome: 'ok', lastDeliveredAt: now.toISOString(), lastSummary: info.headline || undefined, lastReason: undefined },
      note: `delivered${info.headline ? ` — ${info.headline}` : ''}`,
    };
  }
  if (outcome === 'canceled') return { patch: { lastOutcome: 'canceled', lastReason: undefined }, note: 'canceled' };
  const reason = (info.reason || 'unknown error').slice(0, 200);
  const patch: GuardPatch = { lastOutcome: 'error', lastReason: reason };
  if (fire.mode === 'retry') return { patch, note: `retry failed — giving up: ${reason}` };
  if ((info.startedTasks ?? 0) > 0) return { patch, note: `failed after sending ${info.startedTasks} task(s) to other agents — no retry (their answers continue in its thread): ${reason}` };
  if (fire.mode === 'manual' || !fire.slot) return { patch, note: `failed (manual run — no automatic retry): ${reason}` };
  const retryAt = now.getTime() + guard.retryMinutes * 60_000;
  const until = fire.slot.getTime() + guard.catchupHours * 3_600_000;
  if (retryAt > until) return { patch, note: `failed — the slot's grace window is over, no retry: ${reason}` };
  patch.retry = { at: new Date(retryAt).toISOString(), slot: fire.slot.toISOString() };
  return { patch, note: `failed — one retry at ${patch.retry.at}: ${reason}` };
}

// ── empty-slot skip (ROUTINE_SKIP_EMPTY=1, docs/runtime-config.md) ──────────────────────
// A scheduled run costs a full model turn even when the world did not move (the 2026-10-14
// 09:04 brief: "almost nothing new since 08:31"). The fingerprint is exact and host-side: the
// replica's raw-record count since the routine's last delivered run (every pulled line is one
// row, inserts only, so the count is monotonic between rebuilds) plus what the tenant ledgers
// say is due. Nothing is judged by content — that stays with the agent, which is why a manual
// fire, a retry, a stale source, an unreadable replica/tenant, or a routine that opted out all
// fire normally. The channel still gets one line, so silence is never ambiguous.

export interface SourceFreshness {
  kind: string;
  ok: boolean;
  ageMinutes?: number; // undefined = never pulled
}

export interface EmptySkipInputs {
  fire: Fire;
  routine: GuardedRoutine;
  hasSources: boolean;
  /** Raw-record count of the replica now; undefined = replica missing/unreadable. */
  rawCount?: number;
  /** Open escalations and commitments due on/before today; undefined = tenant checkout unreadable. */
  due?: { escalationsOpen: number; commitmentsDue: number };
  sources: SourceFreshness[];
  intervalMinutes: number;
}

export type EmptySkip = { skip: true; message: string } | { skip: false; reason: string };

/** Today's date in `tz` as YYYY-MM-DD — the "due on or before today" boundary of the tenant ledgers. */
export function localDate(tz: string, now: Date): string {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}

/** A source is fresh when its last pass was ok and finished within two intervals (one tick of slack). */
export function staleSources(sources: readonly SourceFreshness[], intervalMinutes: number): string[] {
  return sources
    .filter((s) => !s.ok || s.ageMinutes === undefined || s.ageMinutes > 2 * intervalMinutes)
    .map((s) => (s.ageMinutes === undefined ? `${s.kind} never pulled` : !s.ok ? `${s.kind} last pass failed` : `${s.kind} ${Math.round(s.ageMinutes)} min`));
}

export function emptySkipDecision(inp: EmptySkipInputs, guard: RoutineGuard, now: Date, tz: string): EmptySkip {
  const r = inp.routine;
  if (!guard.enabled || !guard.skipEmpty) return { skip: false, reason: 'empty-skip off' };
  if (inp.fire.mode === 'manual') return { skip: false, reason: 'manual fire' };
  if (inp.fire.mode === 'retry') return { skip: false, reason: 'retry of a failed run' };
  if (!turnKind(r.kind)) return { skip: false, reason: 'not a turn routine' };
  if (r.skipEmpty === false) return { skip: false, reason: 'routine opted out (skipEmpty: false)' };
  if (!inp.hasSources) return { skip: false, reason: 'project has no sources' };
  if (!r.lastDeliveredAt || r.lastDeliveredRawCount === undefined) return { skip: false, reason: 'no delivered run on record to compare with' };
  if (inp.rawCount === undefined) return { skip: false, reason: 'replica unreadable' };
  if (inp.rawCount < r.lastDeliveredRawCount) return { skip: false, reason: `store rebuilt (${inp.rawCount} < ${r.lastDeliveredRawCount} raw records)` };
  const delta = inp.rawCount - r.lastDeliveredRawCount;
  if (delta > 0) return { skip: false, reason: `${delta} new raw record(s) since the last delivered run` };
  if (!inp.due) return { skip: false, reason: 'tenant checkout unreadable' };
  if (inp.due.escalationsOpen > 0 || inp.due.commitmentsDue > 0) {
    return { skip: false, reason: `due: ${inp.due.escalationsOpen} open escalation(s), ${inp.due.commitmentsDue} commitment(s) due` };
  }
  const stale = staleSources(inp.sources, inp.intervalMinutes);
  if (stale.length) return { skip: false, reason: `stale source(s): ${stale.join(', ')}` };
  const fresh = inp.sources.map((s) => `${s.kind} ${Math.round(s.ageMinutes ?? 0)} min`).join(', ');
  return { skip: true, message: `⏭ nothing new since ${stamp(r.lastDeliveredAt, tz)}${fresh ? ` (sources: ${fresh})` : ''}` };
}

// The routine patch for a skipped slot: the slot counts as served (lastRunAt, so neither the
// minute dedupe nor the catch-up fires it again) with outcome 'skipped'; the last DELIVERED
// run's fields are kept so the next real run's preamble still names it.
export function skipPatch(now: Date, fire: Fire): GuardPatch & { lastRunAt: string } {
  return { lastRunAt: now.toISOString(), lastFire: fire.mode, lastOutcome: 'skipped', lastReason: undefined, retry: undefined };
}

