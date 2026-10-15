// `annotations/attribution.json` — the tenant's switch and settings for the attribution layer (data
// only; the presence of the file turns the layer on for the project):
//   { "subject": "<person_id>",          whose days are fragmented (a person in annotations/people.json)
//     "since": "YYYY-MM-DD",             horizon start (default: 30 days back)
//     "threadGapMinutes": 45,            a gap longer than this ends a run of messages
//     "substance": true,                 drop or attach greeting-only runs
//     "pinAfterDays": 1,                 a day's rule decisions stay live this many full days after it ends, then are pinned
//     "parallelSessions": "sum",         timelog: parallel work on different initiatives counts in full ("sum") or is
//                                        scaled so a day never exceeds wall-clock ("wallclock")
//     "budgets": [                       what the timelog is reconciled against, per umbrella (optional):
//       { "umbrella": "x", "unit": "hour" | "half_day", "unitMinutes": 240, "perMonth": 24,
//         "overrides": { "YYYY-MM": 20 }, "by": "initiative" | "billing_code" } ]
//     "admin": { "<umbrella>": "<initiative>" },   each umbrella's non-billable admin bucket (optional)
//     "items": { "days": 30 },           item mode (attribution/items.ts): the stage-0 floor per stream item — every
//                                        message, ticket, comment, recording — of the last `days` local days (1–90,
//                                        default 30); absent = off
//     "learn": { "mode": "shadow",       the learning loop (attribution/learn.ts + learn-load.ts): answers in the ledger
//       "questionsPerDay": 3,            (fragments.jsonl, labels.jsonl) earn typed keys and calibrate the floor's rung
//       "auditShare": 0.15,              instances, re-derived on every build. "shadow" — the only mode yet — computes it,
//       "siblingAware": true } }         stores it (att_learn) and shows it (`attribution({learn: true})`); the plan, the
//                                        pins and the timelog never read it. Absent = off. questionsPerDay 0–50 (3),
//                                        auditShare 0–1 (.15: that share of the budget re-asks auto-decided units),
//                                        siblingAware (true: a structural rung of a client with sibling initiatives
//                                        decides the umbrella, not the initiative — notes/20-iter2.md K2a)
export interface AttributionConfig {
  subject: string;
  since?: string;
  threadGapMinutes: number;
  substance: boolean;
  pinAfterDays: number;
  parallelSessions: 'sum' | 'wallclock';
  admin?: Record<string, string>;
  budgets?: Budget[];
  items?: { days: number };
  learn?: LearnConfig;
}

/** The learning loop's switch and budget (`learn` in attribution.json). Shadow only: nothing it says reaches a decision. */
export interface LearnConfig {
  mode: 'shadow';
  questionsPerDay: number;
  auditShare: number;
  siblingAware: boolean;
}

/** A billing frame the timelog is reconciled against — never used to bend the minutes. */
export interface Budget {
  umbrella: string;
  unit: 'hour' | 'half_day';
  /** Minutes per unit (hour 60, half_day 240 by default). */
  unitMinutes?: number;
  /** Units per month; absent = report only (hourly work without a cap). */
  perMonth?: number;
  /** Month (YYYY-MM) → units, for renegotiated months. */
  overrides?: Record<string, number>;
  /** Breakdown and rounding key: per initiative (default) or per billing code. */
  by?: 'initiative' | 'billing_code';
}

const PERSON_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

export function parseAttributionConfig(raw: unknown, where = 'annotations/attribution.json'): AttributionConfig {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`${where}: expected an object`);
  const r = raw as Record<string, unknown>;
  if (typeof r.subject !== 'string' || !PERSON_RE.test(r.subject)) throw new Error(`${where}: "subject" must be a person id from people.json`);
  const out: AttributionConfig = { subject: r.subject, threadGapMinutes: 45, substance: true, pinAfterDays: 1, parallelSessions: 'sum' };
  if (r.since !== undefined) {
    if (typeof r.since !== 'string' || !DAY_RE.test(r.since) || Number.isNaN(Date.parse(r.since))) throw new Error(`${where}: "since" must be YYYY-MM-DD`);
    out.since = r.since;
  }
  // One zone per tenant, presentation only: `sources.timezone` in the project config (storage is UTC).
  if (r.timezone !== undefined) throw new Error(`${where}: "timezone" moved to the project's sources.timezone — one zone per tenant`);
  if (r.threadGapMinutes !== undefined) {
    if (!Number.isInteger(r.threadGapMinutes) || (r.threadGapMinutes as number) < 1 || (r.threadGapMinutes as number) > 1440) throw new Error(`${where}: "threadGapMinutes" must be an integer in [1, 1440]`);
    out.threadGapMinutes = r.threadGapMinutes as number;
  }
  if (r.substance !== undefined) {
    if (typeof r.substance !== 'boolean') throw new Error(`${where}: "substance" must be true or false`);
    out.substance = r.substance;
  }
  if (r.pinAfterDays !== undefined) {
    if (!Number.isInteger(r.pinAfterDays) || (r.pinAfterDays as number) < 0 || (r.pinAfterDays as number) > 60) throw new Error(`${where}: "pinAfterDays" must be an integer in [0, 60]`);
    out.pinAfterDays = r.pinAfterDays as number;
  }
  if (r.parallelSessions !== undefined) {
    if (r.parallelSessions !== 'sum' && r.parallelSessions !== 'wallclock') throw new Error(`${where}: "parallelSessions" must be "sum" or "wallclock"`);
    out.parallelSessions = r.parallelSessions;
  }
  if (r.budgets !== undefined) {
    if (!Array.isArray(r.budgets)) throw new Error(`${where}: "budgets" must be an array`);
    out.budgets = r.budgets.map((b, i) => {
      const w = `${where}: budgets[${i}]`;
      if (!b || typeof b !== 'object' || Array.isArray(b)) throw new Error(`${w} must be an object`);
      const x = b as Record<string, unknown>;
      if (typeof x.umbrella !== 'string' || !x.umbrella) throw new Error(`${w}: "umbrella" is required`);
      if (x.unit !== 'hour' && x.unit !== 'half_day') throw new Error(`${w}: "unit" must be "hour" or "half_day"`);
      const num = (k: string) => {
        if (x[k] === undefined) return undefined;
        if (typeof x[k] !== 'number' || !Number.isFinite(x[k] as number) || (x[k] as number) < 0) throw new Error(`${w}: "${k}" must be a non-negative number`);
        return x[k] as number;
      };
      const overrides = x.overrides;
      if (overrides !== undefined && (!overrides || typeof overrides !== 'object' || Array.isArray(overrides) || Object.entries(overrides).some(([k, v]) => !/^\d{4}-\d{2}$/.test(k) || typeof v !== 'number'))) throw new Error(`${w}: "overrides" must map YYYY-MM to a number`);
      if (x.by !== undefined && x.by !== 'initiative' && x.by !== 'billing_code') throw new Error(`${w}: "by" must be "initiative" or "billing_code"`);
      const unitMinutes = num('unitMinutes');
      if (unitMinutes === 0) throw new Error(`${w}: "unitMinutes" must be positive`);
      const perMonth = num('perMonth');
      return { umbrella: x.umbrella, unit: x.unit, ...(unitMinutes !== undefined ? { unitMinutes } : {}), ...(perMonth !== undefined ? { perMonth } : {}), ...(overrides ? { overrides: overrides as Record<string, number> } : {}), ...(x.by ? { by: x.by as 'initiative' | 'billing_code' } : {}) };
    });
  }
  if (r.admin !== undefined) {
    const a = r.admin;
    if (!a || typeof a !== 'object' || Array.isArray(a) || Object.values(a).some((v) => typeof v !== 'string' || !v)) throw new Error(`${where}: "admin" must map umbrellas to initiative ids`);
    out.admin = { ...(a as Record<string, string>) };
  }
  if (r.items !== undefined) {
    const it = r.items;
    if (!it || typeof it !== 'object' || Array.isArray(it)) throw new Error(`${where}: "items" must be an object like {"days": 30}`);
    const days = (it as Record<string, unknown>).days;
    if (days !== undefined && (!Number.isInteger(days) || (days as number) < 1 || (days as number) > 90)) throw new Error(`${where}: "items.days" must be an integer in [1, 90]`);
    out.items = { days: (days as number | undefined) ?? 30 };
  }
  if (r.learn !== undefined) out.learn = parseLearn(r.learn, where);
  return out;
}

/** `learn`: a mode is required (no accidental live switch later); every number is bounded so a typo cannot flood the queue. */
function parseLearn(raw: unknown, where: string): LearnConfig {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`${where}: "learn" must be an object like {"mode": "shadow"}`);
  const l = raw as Record<string, unknown>;
  if (l.mode !== 'shadow') throw new Error(`${where}: "learn.mode" must be "shadow" (the only mode so far)`);
  const out: LearnConfig = { mode: 'shadow', questionsPerDay: 3, auditShare: 0.15, siblingAware: true };
  if (l.questionsPerDay !== undefined) {
    if (!Number.isInteger(l.questionsPerDay) || (l.questionsPerDay as number) < 0 || (l.questionsPerDay as number) > 50) throw new Error(`${where}: "learn.questionsPerDay" must be an integer in [0, 50]`);
    out.questionsPerDay = l.questionsPerDay as number;
  }
  if (l.auditShare !== undefined) {
    if (typeof l.auditShare !== 'number' || !Number.isFinite(l.auditShare) || l.auditShare < 0 || l.auditShare > 1) throw new Error(`${where}: "learn.auditShare" must be a number in [0, 1]`);
    out.auditShare = l.auditShare;
  }
  if (l.siblingAware !== undefined) {
    if (typeof l.siblingAware !== 'boolean') throw new Error(`${where}: "learn.siblingAware" must be true or false`);
    out.siblingAware = l.siblingAware;
  }
  return out;
}
