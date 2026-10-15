// The attribution layer's IO half: read the tenant's inputs, compute the plan over the store for the
// horizon, write the derived tables. Called from the store build (store.ts buildStore) on the bot host —
// tenant DATA only, no tenant code, no model. Mirrors how the owen-ops CLI planned a daily review window
// (src/review/load.ts + cli.ts draftsSettled), so its ledger attaches: the subject's messages (calendar
// replies dropped), participants of a container as seen in a window around the message's day plus the
// names a DM/chat container id encodes, meetings deduped by overlap, activity blocks routed by repo/path.
import type { DatabaseSync } from 'node:sqlite';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseAttributionConfig, type AttributionConfig } from './config.js';
import { parseRegistry, Registry, type RegistryData } from './registry.js';
import { containerPeople, dedupeMeetings, meetingFragments, messageFragments, settleLowSubstance, workFragments, type FragmentDraft, type MeetingIn, type MsgIn, type WorkBlock } from './fragment.js';
import { planFragments, proposeRules, STATES, type LedgerRecord, type State } from './plan.js';
import type { MarkedPerson, RuleRecord } from './ladder.js';
import { resolveIdentity, type Person } from '../people.js';
import type { Fragment } from '../annotations.js';

export interface AttributionFiles {
  /** The tenant checkout's root (initiatives.json lives here). */
  tenantRoot: string;
  /** Its annotations directory (attribution.json, rules.json). */
  annotationsDir: string;
  /** The tenant's zone (sources.timezone, else the bot's AVEN_TZ): where days are cut. Storage stays UTC. */
  timezone?: string;
}

export interface AttributionInputs {
  config: AttributionConfig;
  registry: RegistryData;
  rules: RuleRecord[];
  /** The tenant's zone: the horizon's days are cut here; nothing local is stored. */
  timezone: string;
}

export interface AttributionSummary {
  since: string;
  until: string;
  fragments: number;
  states: Record<State, number>;
  proposals: number;
}

function parseRules(raw: unknown, where = 'annotations/rules.json'): RuleRecord[] {
  const list = Array.isArray(raw) ? raw : raw && typeof raw === 'object' ? (raw as { rules?: unknown }).rules : undefined;
  if (!Array.isArray(list)) throw new Error(`${where}: expected an array of rules`);
  return list.filter((r): r is RuleRecord => !!r && typeof r === 'object' && typeof (r as RuleRecord).id === 'string' && !!(r as RuleRecord).when && !!(r as RuleRecord).then);
}

/**
 * The tenant's inputs, or undefined when it ships no `annotations/attribution.json` (the layer is off).
 * `text` is everything the result depends on besides the store, for the build's fingerprint. Throws on a
 * malformed file — the build logs it and keeps the previous tables.
 */
export function readAttributionInputs(f: AttributionFiles): { inputs: AttributionInputs; text: string } | undefined {
  const cfgPath = join(f.annotationsDir, 'attribution.json');
  if (!existsSync(cfgPath)) return undefined;
  const read = (p: string, fallback: string) => (existsSync(p) ? readFileSync(p, 'utf8') : fallback);
  const cfgText = read(cfgPath, '{}');
  const regText = read(join(f.tenantRoot, 'initiatives.json'), '[]');
  const rulesText = read(join(f.annotationsDir, 'rules.json'), '[]');
  const config = parseAttributionConfig(JSON.parse(cfgText));
  return {
    inputs: { config, registry: parseRegistry(JSON.parse(regText)), rules: parseRules(JSON.parse(rulesText)), timezone: f.timezone ?? 'UTC' },
    text: [cfgText, regText, rulesText, f.timezone ?? 'UTC'].join('\0'),
  };
}

/** YYYY-MM-DD of an instant in a zone. */
export function localDay(iso: string, tz: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));
}
export function plusDays(day: string, n: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
}

/** Calendar replies in Sent Items are not conversation. */
const CALENDAR_REPLY = /^(accepted|declined|tentative|akzeptiert|abgelehnt|mit vorbehalt|angenommen)\s*:/i;
type Row = Record<string, unknown>;
const str = (v: unknown) => (v == null ? '' : String(v));

function parseList(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => (typeof x === 'string' ? x : ((x as { email?: string }).email ?? (x as { name?: string }).name ?? ''))).filter(Boolean);
  try {
    const j = JSON.parse(str(v));
    return Array.isArray(j) ? parseList(j) : [];
  } catch {
    return [];
  }
}

/** Compute and write the layer for the horizon (config `since`, default 30 days back, to today in the tenant's zone). */
export function recomputeAttribution(db: DatabaseSync, inputs: AttributionInputs, people: readonly Person[], ledgerRecords: readonly Fragment[], now: Date = new Date()): AttributionSummary {
  const { config, rules } = inputs;
  const reg = new Registry(inputs.registry);
  const tz = inputs.timezone;
  const until = localDay(now.toISOString(), tz);
  const since = config.since ?? plusDays(until, -30);
  const lo = plusDays(since, -1);
  const hi = plusDays(until, 2);

  const marked = new Map<string, MarkedPerson>(people.map((p) => [p.person_id, { person_id: p.person_id, name: p.name, marker: p.marker ? { type: p.marker.type, initiatives: [...p.marker.initiatives] } : { type: 'broad', initiatives: [] } }]));
  const names = new Map(people.map((p) => [p.person_id, p.name]));
  const index = new Map((db.prepare('SELECT identity, person_id FROM identities').all() as { identity: string; person_id: string }[]).map((r) => [r.identity, r.person_id]));
  const who = (raw: string): string | null => (raw ? (resolveIdentity(raw, index) ?? null) : null);

  // The subject's own messages; participants of each container in a window around the message's day
  // (the CLI looked one day back and two ahead of its daily window), plus names encoded in DM/chat ids.
  const partStmt = db.prepare('SELECT DISTINCT author_raw, author_person FROM messages WHERE container = ? AND ts >= ? AND ts < ?');
  const partCache = new Map<string, string[]>();
  const participants = (container: string, day: string): string[] => {
    const key = `${container}\0${day}`;
    let ids = partCache.get(key);
    if (!ids) {
      const set = new Set<string>();
      for (const x of partStmt.all(container, plusDays(day, -1), plusDays(day, 2)) as Row[]) {
        const p = str(x.author_person) || who(str(x.author_raw));
        if (p) set.add(p);
      }
      for (const name of containerPeople(container)) {
        const p = who(name);
        if (p) set.add(p);
      }
      ids = [...set];
      partCache.set(key, ids);
    }
    return ids;
  };
  const msgs: MsgIn[] = (db.prepare('SELECT ref, source, container, thread_id, ts, subject, text FROM messages WHERE author_person = ? AND deleted = 0 AND ts >= ? AND ts < ? ORDER BY ts').all(config.subject, lo, hi) as Row[])
    .filter((r) => !CALENDAR_REPLY.test(str(r.subject)))
    .map((r) => ({ ref: str(r.ref), source: str(r.source), container: str(r.container), thread_id: str(r.thread_id), ts: str(r.ts), subject: str(r.subject), text: str(r.text), participants: participants(str(r.container), localDay(str(r.ts), tz)) }));

  const meetings: MeetingIn[] = (db.prepare('SELECT source, id, ref, title, start, "end", attendees, summary, transcript FROM meetings WHERE deleted = 0 AND start >= ? AND start < ?').all(lo, hi) as Row[]).map((r) => {
    const attendees = parseList(r.attendees);
    return { source: str(r.source) || 'meeting', id: str(r.id ?? r.ref), title: str(r.title), start: str(r.start), end: str(r.end), attendees, summary: str(r.summary), transcriptChars: str(r.transcript).length, participants: [...new Set(attendees.map(who).filter((x): x is string => !!x))] };
  });

  const blocks: WorkBlock[] = (db.prepare('SELECT source, id, container, start, "end", title FROM activity WHERE deleted = 0 AND start >= ? AND start < ?').all(lo, hi) as Row[]).map((r) => {
    const container = str(r.container);
    const byRepo = reg.routeRepo(container);
    return { start: str(r.start), end: str(r.end) || str(r.start), title: str(r.title) || container, ref: `activity:${str(r.source)}:${str(r.id)}`, workKey: container || null, route: byRepo.confidence !== 'none' ? byRepo : reg.routePath(container) };
  });

  const inHorizon = (d: FragmentDraft) => {
    const day = localDay(d.start, tz);
    return day >= since && day <= until;
  };
  let drafts = [...dedupeMeetings(meetings).flatMap(meetingFragments), ...messageFragments(msgs, config.threadGapMinutes), ...workFragments(blocks)].filter(inHorizon);
  if (config.substance) drafts = settleLowSubstance(drafts, config.subject, names).kept;

  const ledger = new Map<string, LedgerRecord>(ledgerRecords.map((f) => [f.id, { id: f.id, kind: f.kind, refs: f.refs, attributions: f.attributions, decided_by: f.decided_by, rule_id: f.rule_id ?? null, rationale: f.rationale ?? '', status: f.status }]));
  const ctx = { rules, people: marked, reg, self: config.subject, ...(config.admin ? { admin: config.admin } : {}) };
  const planned = planFragments(drafts, ledger, ctx);
  const proposals = proposeRules(drafts, ledger, ctx);

  const states = Object.fromEntries(STATES.map((s) => [s, 0])) as Record<State, number>;
  db.exec('BEGIN');
  try {
    db.exec('DELETE FROM att_fragments; DELETE FROM att_proposals;');
    const ins = db.prepare(
      'INSERT OR REPLACE INTO att_fragments(id, kind, start, "end", title, source, container, refs, participants, project_keys, weight, state, decided_by, attributions, rule_id, rationale, candidates, hint, ledger_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    );
    for (const p of planned) {
      const d = p.draft;
      states[p.state]++;
      ins.run(d.id, d.kind, d.start, d.end, d.title, d.source, d.container, JSON.stringify(d.refs), JSON.stringify(d.participants), JSON.stringify(d.projectKeys), d.weight, p.state, p.decided_by, JSON.stringify(p.attributions), p.rule_id, p.rationale, JSON.stringify(p.candidates), p.hint, p.ledger_id);
    }
    const pins = db.prepare('INSERT OR REPLACE INTO att_proposals(id, question, options, refs) VALUES (?, ?, ?, ?)');
    for (const x of proposals) pins.run(x.id, x.question, JSON.stringify(x.options), JSON.stringify(x.refs));
    const meta = db.prepare('INSERT OR REPLACE INTO sync_state(key, value) VALUES (?, ?)');
    meta.run('att:subject', config.subject);
    meta.run('att:since', since);
    meta.run('att:until', until);
    meta.run('att:computed_at', now.toISOString());
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return { since, until, fragments: planned.length, states, proposals: proposals.length };
}

/** The layer switched off (the tenant removed its config): no rows, no meta — the tool then says "not configured". */
export function clearAttribution(db: DatabaseSync): void {
  db.exec("DELETE FROM att_fragments; DELETE FROM att_proposals; DELETE FROM sync_state WHERE key LIKE 'att:%';");
}
