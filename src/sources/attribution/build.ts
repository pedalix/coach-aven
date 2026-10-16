// The attribution layer's IO half: read the tenant's inputs, compute the plan over the store for the
// horizon, write the derived tables. Called from the store build (store.ts buildStore) on the bot host —
// tenant DATA only, no tenant code, no model. Mirrors how the owen-ops CLI planned a daily review window
// (src/review/load.ts + cli.ts draftsSettled), so its ledger attaches: the subject's messages (calendar
// replies dropped), participants of a container as seen in a window around the message's day plus the
// names a DM/chat container id encodes plus whom each message was addressed to, recorder copies of one call
// merged by the store's call id, activity blocks routed by repo/path. People resolve through participants.ts
// (store-exact first, then folded, a person's name as an implicit identity); a call's people come from its
// attendees, its calendar event and its transcript's speakers.
import type { DatabaseSync } from 'node:sqlite';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseAttributionConfig, type AttributionConfig } from './config.js';
import { parseRegistry, Registry, type RegistryData } from './registry.js';
import { callBase, containerPeople, dedupeMeetings, meetingFragments, messageFragments, settleLowSubstance, workFragments, type FragmentDraft, type MeetingIn, type MsgIn, type WorkBlock } from './fragment.js';
import { buildResolver, callParticipants, indexEvents, linkedEvent, loadEvents, recipientsOf, speakerLabels } from './participants.js';
import { planFragments, proposeRules, STATES, type LedgerRecord, type Planned, type State } from './plan.js';
import { appendPinLines, pinsToAdd, readPins, rulesVersion } from './pins.js';
import type { LadderCtx, MarkedPerson, RuleRecord } from './ladder.js';
import type { Person } from '../people.js';
import { SOURCE_PRIORITY } from '../calls.js';
import { attributionRows, type Fragment } from '../annotations.js';
import { parseAttendee } from '../identities/attendees.js';
import { collectIdentities } from '../identities/collect.js';
import { loadObservations } from '../identities/observations.js';
import { attendeeNames, extractCommitments, subjectNames, type CallIn } from '../commitments.js';
import { recomputeItems, type ItemsSummary } from './items.js';
import { clearLearn, recomputeLearn, type LearnSummary } from './learn-load.js';

export interface AttributionFiles {
  /** The tenant checkout's root (initiatives.json lives here). */
  tenantRoot: string;
  /** Its annotations directory (attribution.json, rules.json). */
  annotationsDir: string;
  /** The tenant's zone (sources.timezone, else the bot's AVEN_TZ): where days are cut. Storage stays UTC. */
  timezone?: string;
  /** Pinned rule decisions (data/<slug>/attribution/pins.jsonl): outside the store, which is rebuilt at will. */
  pinsPath?: string;
}

export interface AttributionInputs {
  config: AttributionConfig;
  registry: RegistryData;
  rules: RuleRecord[];
  /** The tenant's zone: the horizon's days are cut here; nothing local is stored. */
  timezone: string;
  pinsPath?: string;
  /** The rules and registry texts and the config without items/learn (versionConfig) — with the people markers, the rules version a pin records. */
  versionText: string;
  /** annotations/labels.jsonl — people's answers about items; read only while the learning loop is on. */
  labelsText?: string;
}

export interface AttributionSummary {
  since: string;
  until: string;
  fragments: number;
  states: Record<State, number>;
  proposals: number;
  identities: { merges: number; questions: number };
  commitments: number;
  // Item mode (attribution.json `items`): null when off; an error never costs the fragments their tables.
  items?: ItemsSummary | { error: string } | null;
  // The learning loop (attribution.json `learn`), shadow: present only while it is on; an error costs the plan nothing.
  learn?: LearnSummary | { error: string };
}

function parseRules(raw: unknown, where = 'annotations/rules.json'): RuleRecord[] {
  const list = Array.isArray(raw) ? raw : raw && typeof raw === 'object' ? (raw as { rules?: unknown }).rules : undefined;
  if (!Array.isArray(list)) throw new Error(`${where}: expected an array of rules`);
  return list.filter((r): r is RuleRecord => !!r && typeof r === 'object' && typeof (r as RuleRecord).id === 'string' && !!(r as RuleRecord).when && !!(r as RuleRecord).then);
}

/**
 * attribution.json as a pin's rules version hashes it: parsed, without `items` and `learn`. Item mode and the shadow loop
 * decide nothing in the plan, so switching them on or off must not change the version the pins of closed days record
 * (the shadow promise: pins identical with the loop on or off); hashing the parsed object, formatting no longer moves
 * it either. (The raw text still feeds the build's fingerprint: any edit recomputes.)
 */
export function versionConfig(raw: unknown): string {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return JSON.stringify(raw);
  return JSON.stringify(Object.fromEntries(Object.entries(raw).filter(([k]) => k !== 'items' && k !== 'learn')));
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
  const cfgRaw = JSON.parse(cfgText) as unknown;
  const config = parseAttributionConfig(cfgRaw);
  // Pins change the result too: a redo between builds must recompute even when nothing else moved.
  const pinsText = f.pinsPath && existsSync(f.pinsPath) ? readFileSync(f.pinsPath, 'utf8') : '';
  // People's item answers move the loop's keys and calibration: part of the fingerprint, but only while the loop is on —
  // a tenant without `learn` keeps its fingerprint (and its builds) exactly as before.
  const labelsText = config.learn ? read(join(f.annotationsDir, 'labels.jsonl'), '') : undefined;
  return {
    inputs: { config, registry: parseRegistry(JSON.parse(regText)), rules: parseRules(JSON.parse(rulesText)), timezone: f.timezone ?? 'UTC', ...(f.pinsPath ? { pinsPath: f.pinsPath } : {}), versionText: [rulesText, regText, versionConfig(cfgRaw)].join('\0'), ...(labelsText !== undefined ? { labelsText } : {}) },
    text: [cfgText, regText, rulesText, f.timezone ?? 'UTC', pinsText, ...(labelsText !== undefined ? [labelsText] : [])].join('\0'),
  };
}

/** YYYY-MM-DD of an instant in a zone. */
export function localDay(iso: string, tz: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));
}
export function plusDays(day: string, n: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
}

/**
 * Recorder copies by start, then recorder priority (calls.ts SOURCE_PRIORITY: granola < wispr < gmeet), then id — never
 * rowid order, which flipped results between builds. The commitments take a call's start and title from its first copy
 * in this order (main's `ORDER BY start`); the fragmenter re-sorts by its own copy order (dedupeMeetings: a copy with a
 * window of its own before a Gemini doc without one).
 */
const COPY_ORDER = `start, CASE source ${Object.entries(SOURCE_PRIORITY).map(([s, n]) => `WHEN '${s}' THEN ${n}`).join(' ')} ELSE 9 END, id`;

/** Calendar replies in Sent Items are not conversation. */
const CALENDAR_REPLY = /^(accepted|declined|tentative|akzeptiert|abgelehnt|mit vorbehalt|angenommen)\s*:/i;
type Row = Record<string, unknown>;
const str = (v: unknown) => (v == null ? '' : String(v));

/** A JSON array column (attendees, next_steps) → its entries; anything else → none. */
function entries(v: unknown): unknown[] {
  try {
    const j = JSON.parse(str(v) || '[]') as unknown;
    return Array.isArray(j) ? j : [];
  } catch {
    return [];
  }
}

/** What the layer decides on: the horizon's fragments and the ladder's context, before any ledger, pin or write. */
export interface AttributionDrafts {
  /** The horizon in the tenant's zone: config `since` (default 30 days back) to today. */
  since: string;
  until: string;
  /** The UTC query window around it (a day before, two after): what the fragmenter read. */
  lo: string;
  hi: string;
  /** The subject's fragments starting in the horizon, low-substance runs already attached to a call or dropped. */
  drafts: FragmentDraft[];
  /** The calls as the fragmenter saw them (recorder copies merged: dedupeMeetings): the summaries topic sub-fragments were cut from. */
  meetings: MeetingIn[];
  ctx: LadderCtx;
}

/**
 * The DB → drafts half of the layer, read-only: the subject's messages, the meetings and the activity of the horizon cut
 * into fragments, plus the ladder's context. Exported so a bench (src/lab) can replay today's fragmenter and ladder over
 * a frozen store without writing anything; recomputeAttribution is this plus the plan, the pins and the writes.
 */
export function loadAttributionDrafts(db: DatabaseSync, inputs: AttributionInputs, people: readonly Person[], now: Date = new Date()): AttributionDrafts {
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
  // One resolver for every form below: the store's exact index first (nothing it resolves moves), then folded forms
  // and each person's name as an implicit identity (participants.ts).
  const resolver = buildResolver(people, index);
  const who = (raw: string): string | null => resolver.resolve(raw);
  const recipients = recipientsOf(db);

  // The subject's own messages; participants of each container in a window around the message's day
  // (the CLI looked one day back and two ahead of its daily window), plus names encoded in DM/chat ids,
  // plus whom the message itself was addressed to (message_people 'to': DM members, mentions, mail To/Cc) —
  // the container's authors alone miss a recipient who never wrote back.
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
    .map((r) => ({ ref: str(r.ref), source: str(r.source), container: str(r.container), thread_id: str(r.thread_id), ts: str(r.ts), subject: str(r.subject), text: str(r.text), participants: [...new Set([...participants(str(r.container), localDay(str(r.ts), tz)), ...recipients(str(r.ref))])] }));

  // Recorder copies, each with its people: attendee entries read by the one parser, its calendar event (same title,
  // ±15 min), its transcript's speakers. Which copy names a call is dedupeMeetings' copy order (a copy with a window
  // first, then start, recorder priority, id) — never the rows' insertion order.
  const calendar = indexEvents(loadEvents(db, lo, hi));
  const meetings: MeetingIn[] = (db.prepare(`SELECT source, id, ref, title, start, "end", attendees, summary, transcript, call_id FROM meetings WHERE deleted = 0 AND start >= ? AND start < ? ORDER BY ${COPY_ORDER}`).all(lo, hi) as Row[])
    .map((r) => {
      const stored = entries(r.attendees);
      const transcript = str(r.transcript);
      const event = linkedEvent({ title: str(r.title), start: str(r.start) }, calendar);
      return {
        source: str(r.source) || 'meeting',
        id: str(r.id ?? r.ref),
        title: str(r.title),
        start: str(r.start),
        end: str(r.end),
        attendees: stored.map((a) => parseAttendee(a).raw).filter(Boolean),
        summary: str(r.summary),
        transcriptChars: transcript.length,
        participants: callParticipants({ attendees: stored, speakers: speakerLabels(transcript) }, event, resolver),
        ...(str(r.call_id) ? { callId: str(r.call_id) } : {}),
      };
    });

  const blocks: WorkBlock[] = (db.prepare('SELECT source, id, container, start, "end", title, items_text FROM activity WHERE deleted = 0 AND start >= ? AND start < ?').all(lo, hi) as Row[]).map((r) => {
    const container = str(r.container);
    const byRepo = reg.routeRepo(container);
    // Tracker keys in the block's commit/session texts (F6): a block outside every registered repo can still route by
    // the ticket it names; a repo route still wins (the registry rung tries repo/path first).
    return { start: str(r.start), end: str(r.end) || str(r.start), title: str(r.title) || container, ref: `activity:${str(r.source)}:${str(r.id)}`, workKey: container || null, route: byRepo.confidence !== 'none' ? byRepo : reg.routePath(container), text: str(r.items_text) };
  });

  const inHorizon = (d: FragmentDraft) => {
    const day = localDay(d.start, tz);
    return day >= since && day <= until;
  };
  const calls = dedupeMeetings(meetings);
  let drafts = [...calls.flatMap(meetingFragments), ...messageFragments(msgs, config.threadGapMinutes), ...workFragments(blocks)].filter(inHorizon);
  if (config.substance) drafts = settleLowSubstance(drafts, config.subject, names).kept;
  // A greeting run attached to a call ("joining in 2 min"): whom it was addressed to was at the call.
  for (const d of drafts) {
    const attached = d.kind === 'call' ? d.refs.filter((r) => !r.startsWith('meeting:')) : [];
    if (attached.length) d.participants = [...new Set([...d.participants, ...attached.flatMap(recipients)])];
  }
  const ctx: LadderCtx = { rules, people: marked, reg, self: config.subject, ...(config.admin ? { admin: config.admin } : {}) };
  return { since, until, lo, hi, drafts, meetings: calls, ctx };
}

/** Compute and write the layer for the horizon (config `since`, default 30 days back, to today in the tenant's zone). */
export function recomputeAttribution(db: DatabaseSync, inputs: AttributionInputs, people: readonly Person[], ledgerRecords: readonly Fragment[], now: Date = new Date()): AttributionSummary {
  const { config } = inputs;
  const tz = inputs.timezone;
  const team = config.subject === ''; // team mode (config.ts): no subject — items and the loop only
  const loaded = loadAttributionDrafts(db, inputs, people, now);
  const { since, until, lo, hi, ctx } = loaded;
  const drafts = team ? [] : loaded.drafts;
  const ledger = new Map<string, LedgerRecord>(ledgerRecords.map((f) => [f.id, { id: f.id, kind: f.kind, refs: f.refs, attributions: f.attributions, decided_by: f.decided_by, rule_id: f.rule_id ?? null, rationale: f.rationale ?? '', status: f.status }]));
  // Ledger > pin > ladder. Rule decisions of closed days (before `cutoff`) are pinned now, with the rules
  // version that decided them, and count as decided from this build on.
  const pins = inputs.pinsPath ? readPins(inputs.pinsPath) : new Map();
  let planned: Planned[] = planFragments(drafts, ledger, ctx, pins);
  if (inputs.pinsPath) {
    const markers = JSON.stringify(people.map((p) => [p.person_id, p.marker ?? null]));
    const fresh = pinsToAdd(planned, (iso) => localDay(iso, tz), plusDays(until, -config.pinAfterDays), rulesVersion(inputs.versionText, markers), now.toISOString());
    if (fresh.length) {
      appendPinLines(inputs.pinsPath, fresh);
      for (const p of fresh) pins.set(p.id, p);
      planned = planFragments(drafts, ledger, ctx, pins);
    }
  }
  const proposals = proposeRules(drafts, ledger, ctx);
  // Identities and the subject's promised steps: the review's other two inputs, from the same store and people file.
  const identities = team ? collectIdentities(people, [], config.subject) : collectIdentities(people, loadObservations(db, config.subject, people), config.subject);
  const calls = new Map<string, CallIn>();
  // In copy order: the first copy gives the call its start and title, and wins a step two copies share.
  for (const r of db.prepare(`SELECT ref, source, title, start, attendees, next_steps, call_id FROM meetings WHERE deleted = 0 AND start >= ? AND start < ? ORDER BY ${COPY_ORDER}`).all(lo, hi) as Row[]) {
    const id = str(r.call_id) || str(r.ref);
    const cur = calls.get(id) ?? { call_id: id, start: str(r.start), title: str(r.title), copies: [] };
    const steps = entries(r.next_steps).map((x) => (typeof x === 'string' ? x : JSON.stringify(x)));
    cur.copies.push({ source: str(r.source), ref: str(r.ref), next_steps: steps, attendees: attendeeNames(r.attendees) });
    if (!cur.title && str(r.title)) cur.title = str(r.title);
    calls.set(id, cur);
  }
  const commitments = team ? [] : extractCommitments([...calls.values()], subjectNames(people.find((p) => p.person_id === config.subject)), config.subject);

  const states = Object.fromEntries(STATES.map((s) => [s, 0])) as Record<State, number>;
  db.exec('BEGIN');
  try {
    db.exec('DELETE FROM att_fragments; DELETE FROM att_proposals; DELETE FROM att_pins; DELETE FROM att_commitments;');
    const ins = db.prepare(
      'INSERT OR REPLACE INTO att_fragments(id, kind, start, "end", title, source, container, refs, participants, project_keys, weight, state, decided_by, attributions, rule_id, rationale, candidates, hint, ledger_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    );
    for (const p of planned) {
      const d = p.draft;
      states[p.state]++;
      ins.run(d.id, d.kind, d.start, d.end, d.title, d.source, d.container, JSON.stringify(d.refs), JSON.stringify(d.participants), JSON.stringify(d.projectKeys), d.weight, p.state, p.decided_by, JSON.stringify(p.attributions), p.rule_id, p.rationale, JSON.stringify(p.candidates), p.hint, p.ledger_id);
    }
    const props = db.prepare('INSERT OR REPLACE INTO att_proposals(id, question, options, refs) VALUES (?, ?, ?, ?)');
    for (const x of proposals) props.run(x.id, x.question, JSON.stringify(x.options), JSON.stringify(x.refs));
    // The initiative index (search/get/fragments `initiative`) follows the plan: judgments, pins and live rule decisions
    // over the platform's own refs — the tenant ledger keeps judgments only and need not carry refs. Ledger lines the plan
    // does not hold (before the horizon, or an id that no longer matches) keep their own rows.
    db.exec('DELETE FROM attributions');
    const aIns = db.prepare('INSERT OR REPLACE INTO attributions(ref, initiative, share, fragment_id, decided_by) VALUES (?, ?, ?, ?, ?)');
    const held = new Set<string>();
    for (const p of planned) {
      held.add(p.draft.id);
      if (p.ledger_id) held.add(p.ledger_id);
      // A line under a merged twin's own id is this call's too: the plan indexes the twin's ref — a second row would give it two initiatives.
      for (const a of p.draft.aliases ?? []) held.add(a);
      if (p.state !== 'decided' && p.state !== 'rule') continue;
      for (const ref of p.draft.refs) for (const a of p.attributions) aIns.run(ref, a.initiative, a.share, p.ledger_id ?? p.draft.id, p.decided_by ?? 'rule');
    }
    for (const r of attributionRows(ledgerRecords.filter((f) => !held.has(f.id)))) aIns.run(r.ref, r.initiative, r.share, r.fragment_id, r.decided_by);
    const cIns = db.prepare('INSERT OR REPLACE INTO att_commitments(id, call, call_title, call_start, owner, to_person, what, source, provenance) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
    for (const c of commitments) cIns.run(c.id, c.call, c.call_title, c.call_start, c.owner, c.to, c.what, c.source, JSON.stringify(c.provenance));
    const pinIns = db.prepare('INSERT OR REPLACE INTO att_pins(id, pinned_at, rules_version) VALUES (?, ?, ?)');
    for (const p of planned) if (p.pinned_at) pinIns.run(p.draft.id, p.pinned_at, p.rules_version ?? '');
    const meta = db.prepare('INSERT OR REPLACE INTO sync_state(key, value) VALUES (?, ?)');
    meta.run('att:subject', config.subject);
    meta.run('att:since', since);
    meta.run('att:until', until);
    // What the timelog readout needs from the registry and the config (no local value: ids and weights only).
    meta.run('att:registry', JSON.stringify(Object.fromEntries(inputs.registry.initiatives.map((i) => [i.id, { ...(i.umbrella ? { umbrella: i.umbrella } : {}), ...(typeof i.billing_code === 'string' ? { billing_code: i.billing_code } : {}), ...(i.alias_of ? { alias_of: i.alias_of } : {}), ...(i.split_into ? { split_into: i.split_into } : {}) }]))));
    meta.run('att:policy', config.parallelSessions);
    meta.run('att:budgets', JSON.stringify(config.budgets ?? []));
    meta.run('att:identities', JSON.stringify(identities));
    meta.run('att:computed_at', now.toISOString());
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  // The item floor runs in its own transaction after the fragments are safe: a failure there is reported in the
  // summary (the build line logs it: attributionLine) and leaves the fragment tables of this build intact.
  let items: ItemsSummary | { error: string } | null;
  try {
    items = recomputeItems(db, inputs, people, now);
  } catch (e) {
    items = { error: e instanceof Error ? e.message : String(e) };
  }
  // The learning loop, shadow (attribution.json `learn`): after the plan and the items are written (it reads both), in
  // its own transaction and try — what it would decide lands in att_learn only; the plan, the pins and the timelog
  // above never read it. Without the key its rows are cleared, so switching it off leaves nothing stale behind.
  let learn: LearnSummary | { error: string } | undefined;
  if (config.learn?.mode === 'shadow') {
    try {
      // The plan's own drafts: none in team mode, which has no fragments — the loop then runs over items only.
      learn = recomputeLearn(db, inputs, people, ledgerRecords, now, { drafts: { ...loaded, drafts } });
    } catch (e) {
      learn = { error: e instanceof Error ? e.message : String(e) };
    }
  } else clearLearn(db);
  return { since, until, fragments: planned.length, states, proposals: proposals.length, identities: { merges: identities.merges.length, questions: identities.questions.length }, commitments: commitments.length, items, ...(learn ? { learn } : {}) };
}

/**
 * The layer switched off (the tenant removed its config): no rows, no meta — the tool then says "not configured" — and
 * the initiative index goes back to the ledger alone.
 */
export function clearAttribution(db: DatabaseSync, ledgerRecords: readonly Fragment[] = []): void {
  db.exec('BEGIN');
  try {
    db.exec("DELETE FROM att_fragments; DELETE FROM att_proposals; DELETE FROM att_pins; DELETE FROM att_commitments; DELETE FROM att_items; DELETE FROM att_learn; DELETE FROM sync_state WHERE key LIKE 'att:%'; DELETE FROM attributions;");
    const aIns = db.prepare('INSERT OR REPLACE INTO attributions(ref, initiative, share, fragment_id, decided_by) VALUES (?, ?, ?, ?, ?)');
    for (const r of attributionRows(ledgerRecords)) aIns.run(r.ref, r.initiative, r.share, r.fragment_id, r.decided_by);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

/**
 * What a redo of [loIso, hiIso] releases: the pinned fragments starting there, and for a pinned call also the ids its
 * recorder copies would have given it (plan.ts: a pin under a copy's own id still decides the call — left in place, it
 * would decide the call again on the next build and the redo would change nothing). Candidates: unpinLines keeps those
 * that are pinned.
 */
export function pinnedIdsBetween(db: DatabaseSync, loIso: string, hiIso: string): string[] {
  const rows = db.prepare('SELECT f.id, f.kind, f.refs FROM att_pins p JOIN att_fragments f ON f.id = p.id WHERE f.start >= ? AND f.start <= ? ORDER BY f.start, f.id').all(loIso, hiIso) as { id: string; kind: string; refs: string }[];
  const copy = db.prepare('SELECT start FROM meetings WHERE source = ? AND id = ? AND deleted = 0');
  const out: string[] = [];
  for (const r of rows) {
    out.push(r.id);
    if (r.kind !== 'call') continue;
    const suffix = /#\d+$/.exec(r.id)?.[0] ?? '';
    for (const ref of JSON.parse(r.refs) as string[]) {
      const m = /^meeting:([^:]+):(.*)$/.exec(ref);
      const start = m ? str((copy.get(m[1]!, m[2]!) as Row | undefined)?.start) : '';
      if (m && start) out.push(callBase({ source: m[1]!, id: m[2]!, start }) + suffix);
    }
  }
  return [...new Set(out)];
}

/**
 * The attribution part of the store build's log line (run.ts): the plan's counts, then — only while they are on — the
 * item pass and the learning loop, or their error (each runs in its own try after the plan: a failure costs the plan
 * nothing, keeps the previous build's item/loop rows, and is reported nowhere else).
 */
export function attributionLine(a: AttributionSummary): string {
  const fail = (what: string, e: { error: string }) => `; ${what} FAILED: ${e.error} (previous rows kept)`;
  const items = !a.items ? '' : 'error' in a.items ? fail('items', a.items) : `; items ${a.items.since}..${a.items.until}: ${a.items.items} (${a.items.decided} decided, ${a.items.clusters} clusters)`;
  const learn = !a.learn ? '' : 'error' in a.learn ? fail('learn', a.learn) : `; learn ${a.learn.mode}: ${a.learn.units.fragment} fragments + ${a.learn.units.item} items, would decide ${a.learn.would_decide} (floor ${a.learn.floor_decided}), ${a.learn.questions} questions, ${a.learn.audits} audits`;
  return `attribution ${a.since}..${a.until}: ${a.fragments} fragments (${Object.entries(a.states).map(([k, v]) => `${k} ${v}`).join(', ')}), ${a.proposals} proposals${items}${learn}`;
}
