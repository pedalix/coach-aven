// `annotations/attribution.json` — the tenant's switch and settings for the attribution layer (data
// only; the presence of the file turns the layer on for the project):
//   { "subject": "<person_id>",          whose days are fragmented (a person in annotations/people.json)
//     "since": "YYYY-MM-DD",             horizon start (default: 30 days back)
//     "threadGapMinutes": 45,            a gap longer than this ends a run of messages
//     "substance": true,                 drop or attach greeting-only runs
//     "pinAfterDays": 1,                 a day's rule decisions stay live this many full days after it ends, then are pinned
//     "parallelSessions": "sum",         timelog: parallel work on different initiatives counts in full ("sum") or is
//                                        scaled so a day never exceeds wall-clock ("wallclock")
//     "admin": { "<umbrella>": "<initiative>" } }   each umbrella's non-billable admin bucket (optional)
export interface AttributionConfig {
  subject: string;
  since?: string;
  threadGapMinutes: number;
  substance: boolean;
  pinAfterDays: number;
  parallelSessions: 'sum' | 'wallclock';
  admin?: Record<string, string>;
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
  if (r.admin !== undefined) {
    const a = r.admin;
    if (!a || typeof a !== 'object' || Array.isArray(a) || Object.values(a).some((v) => typeof v !== 'string' || !v)) throw new Error(`${where}: "admin" must map umbrellas to initiative ids`);
    out.admin = { ...(a as Record<string, string>) };
  }
  return out;
}
