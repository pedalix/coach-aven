// Pure scheduling logic for the report jobs: parse a friendly schedule into cron, match
// cron against wall-clock time in a timezone. No Slack/Daytona deps, so it's unit-testable
// in isolation (see schedule.test.ts).

// Wall-clock parts a cron is matched against (day-of-week: Sun=0).
export interface TimeParts {
  mi: number;
  ho: number;
  dom: number;
  mon: number;
  dow: number;
}

const DOW: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

// Parse a friendly schedule into a 5-field cron ("min hour dom mon dow") + a label.
// Forms: `daily HH:MM` | `weekdays HH:MM` | `weekly <mon..sun> HH:MM` | `cron <5 fields>`.
export function parseSchedule(input: string): { cron: string; spec: string } | { error: string } {
  const s = input.trim();
  const hm = (t: string): [string, string] | undefined => {
    const m = t.match(/^(\d{1,2}):(\d{2})$/);
    if (!m) return undefined;
    const hh = Number(m[1]);
    const mm = Number(m[2]);
    return hh > 23 || mm > 59 ? undefined : [String(mm), String(hh)];
  };
  let m: RegExpMatchArray | null;
  if ((m = s.match(/^daily\s+(\S+)$/i))) {
    const t = hm(m[1]);
    return t ? { cron: `${t[0]} ${t[1]} * * *`, spec: `daily ${m[1]}` } : { error: `bad time "${m[1]}" — use HH:MM` };
  }
  if ((m = s.match(/^weekdays?\s+(\S+)$/i))) {
    const t = hm(m[1]);
    return t ? { cron: `${t[0]} ${t[1]} * * 1-5`, spec: `weekdays ${m[1]}` } : { error: `bad time "${m[1]}" — use HH:MM` };
  }
  if ((m = s.match(/^weekly\s+([a-z]{3})\s+(\S+)$/i))) {
    const d = DOW[m[1].toLowerCase()];
    if (d === undefined) return { error: `bad day "${m[1]}" — use mon..sun` };
    const t = hm(m[2]);
    return t
      ? { cron: `${t[0]} ${t[1]} * * ${d}`, spec: `weekly ${m[1].toLowerCase()} ${m[2]}` }
      : { error: `bad time "${m[2]}" — use HH:MM` };
  }
  if ((m = s.match(/^cron\s+(.+)$/i))) {
    const f = m[1].trim().split(/\s+/);
    return f.length === 5 ? { cron: f.join(' '), spec: `cron ${f.join(' ')}` } : { error: 'cron needs 5 fields: min hour dom mon dow' };
  }
  return {
    error: 'schedule must be `daily HH:MM`, `weekdays HH:MM`, `weekly <mon..sun> HH:MM`, or `cron <5 fields>`',
  };
}

// Match one cron field (`*`, `5`, `1-5`, `0,30`, `*/15`) against a value.
export function cronFieldMatch(field: string, value: number): boolean {
  return field.split(',').some((part) => {
    const [rangePart, stepPart] = part.split('/');
    const step = stepPart ? Number(stepPart) || 1 : 1;
    if (rangePart === '*') return value % step === 0;
    const [a, b] = rangePart.includes('-') ? rangePart.split('-').map(Number) : [Number(rangePart), Number(rangePart)];
    if (value < a || value > b) return false;
    return (value - a) % step === 0;
  });
}

// Current wall-clock parts in an IANA tz, via Intl — no tz library needed. The formatter is
// cached per tz: the catch-up walk below (lastOccurrence) calls this hundreds of times a tick.
const WEEKDAY_NUM: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const PARTS_FMT = new Map<string, Intl.DateTimeFormat>();
export function nowParts(tz: string, now: Date): TimeParts {
  let fmt = PARTS_FMT.get(tz);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hour12: false,
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      day: '2-digit',
      month: '2-digit',
    });
    PARTS_FMT.set(tz, fmt);
  }
  const parts = fmt.formatToParts(now);
  const get = (t: string): string => parts.find((p) => p.type === t)?.value ?? '';
  let ho = Number(get('hour'));
  if (ho === 24) ho = 0; // some runtimes render midnight as "24"
  return { mi: Number(get('minute')), ho, dom: Number(get('day')), mon: Number(get('month')), dow: WEEKDAY_NUM[get('weekday')] ?? 0 };
}

// Does a 5-field cron match the given wall-clock parts? (Friendly specs restrict only one
// of dom/dow, so a plain AND is correct here; raw cron with BOTH set uses AND too — a
// minor deviation from cron's dom-OR-dow rule, acceptable for these report jobs.)
export function cronMatches(cron: string, p: TimeParts): boolean {
  const [mi, ho, dom, mon, dow] = cron.split(/\s+/);
  return (
    cronFieldMatch(mi, p.mi) &&
    cronFieldMatch(ho, p.ho) &&
    cronFieldMatch(dom, p.dom) &&
    cronFieldMatch(mon, p.mon) &&
    (cronFieldMatch(dow, p.dow) || (p.dow === 0 && cronFieldMatch(dow, 7))) // cron Sunday = 0 or 7
  );
}

// "month-day hour:minute" — identifies one wall-clock minute, for once-per-minute dedup.
export function minuteKey(p: TimeParts): string {
  return `${p.mon}-${p.dom} ${p.ho}:${p.mi}`;
}

// The fields the scheduler needs to decide whether a routine should fire.
export interface SchedulableRoutine {
  id: string;
  enabled: boolean;
  cron: string;
  tz: string;
}

// Pure decision for the scheduler tick: which routines are due at `now`. Skips disabled
// routines, ones whose cron doesn't match the current minute (in their tz), and ones
// already fired this wall-clock minute (per `firedThisMinute`, which is read, not mutated —
// the caller records the fire). Returns each due routine with its minute key.
export function dueRoutines<T extends SchedulableRoutine>(
  routines: T[],
  now: Date,
  firedThisMinute: Map<string, string>,
): { routine: T; key: string }[] {
  const out: { routine: T; key: string }[] = [];
  for (const r of routines) {
    if (!r.enabled) continue;
    const p = nowParts(r.tz, now);
    if (!cronMatches(r.cron, p)) continue;
    const key = minuteKey(p);
    if (firedThisMinute.get(r.id) === key) continue;
    out.push({ routine: r, key });
  }
  return out;
}

// The start of the wall-clock minute `at` falls in (the instant a cron slot is identified by).
export function minuteStart(at: Date): Date {
  return new Date(Math.floor(at.getTime() / 60_000) * 60_000);
}

// The most recent instant at or before `now` whose wall-clock minute (in `tz`) matches `cron`,
// looking back at most `maxBackMinutes` — undefined when there is none in that span. A plain
// minute-by-minute walk: the routines here fire a few times a day and callers bound the walk by
// their grace window, so it is a few hundred cheap steps — and it is right across DST shifts by
// construction (instants step, the wall-clock is re-derived per step).
export function lastOccurrence(cron: string, tz: string, now: Date, maxBackMinutes: number): Date | undefined {
  let t = minuteStart(now);
  for (let i = 0; i <= maxBackMinutes; i++, t = new Date(t.getTime() - 60_000)) {
    if (cronMatches(cron, nowParts(tz, t))) return t;
  }
  return undefined;
}

// What the missed-fire catch-up needs on top of the scheduler fields.
export interface CatchupRoutine extends SchedulableRoutine {
  lastRunAt?: string; // ISO of the last fire — stamped at FIRE, not at success (pollers.ts)
  createdAt?: string; // ISO — a slot older than the routine itself was never owed
}

// Pure: routines whose most recent cron occurrence — strictly before the current minute (that one
// is dueRoutines' job) and no older than `graceHours` — is later than their last fire. That is a
// slot the process never observed: the host was asleep or the bot was down/restarting at that
// minute, or the fire was skipped because the previous run was still in flight. Because
// `lastRunAt` is stamped at fire, a run that fired and FAILED is not "missed" (the retry in
// routineguard.ts owns that case), and a routine that has never fired is owed only slots after
// its creation. Disabled routines are skipped, as in dueRoutines. Each hit carries its slot.
export function missedRoutines<T extends CatchupRoutine>(
  routines: T[],
  now: Date,
  graceHours: number,
): { routine: T; slot: Date }[] {
  const out: { routine: T; slot: Date }[] = [];
  const before = new Date(minuteStart(now).getTime() - 60_000);
  const maxBack = Math.max(0, Math.round(graceHours * 60) - 1);
  for (const r of routines) {
    if (!r.enabled) continue;
    const slot = lastOccurrence(r.cron, r.tz, before, maxBack);
    if (!slot) continue;
    const stamps = [r.lastRunAt, r.createdAt].map((s) => Date.parse(s ?? '')).filter(Number.isFinite);
    if (!stamps.length) continue; // nothing to measure against — never owed
    if (slot.getTime() > Math.max(...stamps)) out.push({ routine: r, slot });
  }
  return out;
}

// Group routines by project slug, sorted by slug — for the fleet-wide `/aven routines all`
// view and the per-project job counts in `/aven status`.
export function groupRoutinesBySlug<T extends { slug: string }>(routines: T[]): { slug: string; routines: T[] }[] {
  const by = new Map<string, T[]>();
  for (const r of routines) {
    const list = by.get(r.slug);
    if (list) list.push(r);
    else by.set(r.slug, [r]);
  }
  return [...by.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([slug, rs]) => ({ slug, routines: rs }));
}

// `/aven schedule [task] <when> | <prompt>` body (the text after "schedule"). A leading `task`
// makes a routine that MAY edit and commit (kind 'task'); without it the routine is the
// classic read-only digest (kind 'report'). Pure so the command parser is testable.
export type ScheduleCommand =
  | { kind: 'report' | 'task'; when: string; prompt: string }
  | { error: 'usage' };
export function parseScheduleCommand(rest: string): ScheduleCommand {
  let body = rest.trim();
  let kind: 'report' | 'task' = 'report';
  const m = /^task\b\s*/i.exec(body);
  if (m) {
    kind = 'task';
    body = body.slice(m[0].length);
  }
  const bar = body.indexOf('|');
  if (bar < 0) return { error: 'usage' };
  const when = body.slice(0, bar).trim();
  const prompt = body.slice(bar + 1).trim();
  if (!when || !prompt) return { error: 'usage' };
  return { kind, when, prompt };
}
