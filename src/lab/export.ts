// The real-store exporter: a frozen production store plus the tenant's files AS GIVEN → a bench dataset (layout in
// types.ts). Units carry features only — what production knew at the freeze, plus today's ladder's own answer for
// reference (MAIN's ladder and registry parse, variants/frozen/: the baseline reads it as today's production, so it
// must not move when this branch improves the ladder; the fragment drafts are this branch's fragmenter, see
// docs/lab.md); gold comes only from judgments that already exist (the tenant ledger, the platform's pins, answered
// escalations, identity merges, the roster), never from this code's reading of the content.
//
// Read-only by construction: the store is opened immutable, the tenant and the pins are only read (the attribution
// inputs are read WITHOUT a pins path, so nothing can append to it), and the dataset links back to both instead of
// copying private data around — real datasets live outside the repo, under $LAB_DIR.
//
// Days are LOCAL days in the tenant's zone (storage is UTC). Fragments cover the attribution horizon (`since` — by
// default the tenant's attribution.json since — to `until`); items and mentions cover the last `itemsWindowDays`
// local days up to `until`: the stream a daily review would have seen. Fragment ids are the production fragmenter's,
// so ledger lines attach exactly as the plan attaches them (by id, or a thread by any overlapping ref — plan.ts);
// lines that attach to no exported fragment are counted in export.json, never guessed onto a neighbour.

import { annotateCases } from './annotate.js';
import { existsSync, lstatSync, readFileSync, realpathSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import type { DatabaseSync } from 'node:sqlite';
import { parseFragments, type Attribution } from '../sources/annotations.js';
import { loadAttributionDrafts, localDay, plusDays, readAttributionInputs } from '../sources/attribution/build.js';
import { hash, topics, type FragmentDraft, type MeetingIn } from '../sources/attribution/fragment.js';
import type { LadderCtx } from '../sources/attribution/ladder.js';
import { planFragments, type LedgerRecord } from '../sources/attribution/plan.js';
import { readPins } from '../sources/attribution/pins.js';
import { parseRegistry, Registry } from '../sources/attribution/registry.js';
import { normaliseName, parseIdentity } from '../sources/identities/normalise.js';
import { identitiesOf, identityIndex, identityKey, resolveIdentity, validatePeople, type Person } from '../sources/people.js';
import { openReadOnly, resolveAttendee } from '../sources/store.js';
import { saveMeta, writeJsonl } from './dataset.js';
import { attribute as frozenAttribute, type LadderCtx as FrozenLadderCtx } from './variants/frozen/ladder.js';
import { parseRegistry as parseFrozenRegistry, Registry as FrozenRegistry } from './variants/frozen/registry.js';
import { NONE, SYSTEM, UNKNOWN, type DatasetMeta, type FragmentUnit, type GoldRow, type GoldTier, type ItemUnit, type MentionUnit } from './types.js';

export interface ExportOptions {
  name: string;
  kind: 'real' | 'synthetic';
  source: { store: string; tenantDir: string; pinsPath?: string };
  outDir: string;
  /** Last local day of the dataset, inclusive. */
  until: string;
  /** First local day of the fragments; default: the tenant's attribution.json `since`, else the items window's start. */
  since?: string;
  /** Items and mentions: this many local days up to `until` (default 30). */
  itemsWindowDays?: number;
  /** The tenant's zone; default: the store's own (`tz` in sync_state), else UTC. */
  tz?: string;
  /** The freeze instant: the production horizon ends on its local day. Also meta.createdAt, so a re-export is byte-identical. */
  now: Date;
  /** meta.tenant; default: the name without a `-real`/`-synthetic` suffix. */
  tenant?: string;
  log?: (msg: string) => void;
}

/** What one export saw and dropped — written beside the dataset as export.json; the counts a reader checks first. */
export interface ExportReport {
  windows: { fragments: [string, string] | null; items: [string, string] };
  units: { fragment: number; item: number; mention: number };
  items: Record<string, number>;
  gold: Record<string, Record<string, number>>;
  t1: Record<string, number>;
  t3: Record<string, number>;
  warnings: string[];
}

const TEXT_FRAGMENT = 3000;
const TEXT_ITEM = 2000;
const TEXT_CONTEXT = 300;
const MAX_KEYS = 20;
const MAX_CO = 10;
/** A recording and a calendar event are the same call when they start this close and carry the same title. */
const LINK_MS = 15 * 60_000;

type Row = Record<string, unknown>;
const str = (v: unknown): string => (v == null ? '' : String(v));
const clip = (s: string, n: number): string => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);
const validIso = (s: string): boolean => !!s && !Number.isNaN(Date.parse(s));
function json<T>(v: unknown, fallback: T): T {
  try {
    const j = JSON.parse(str(v)) as unknown;
    return (j ?? fallback) as T;
  } catch {
    return fallback;
  }
}
function lines<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .flatMap((l) => {
      if (!l.trim()) return [];
      try {
        return [JSON.parse(l) as T];
      } catch {
        return [];
      }
    });
}
/** Last line per id wins — the tenant's append-only files (escalations, merges) all work that way. */
function lastById<T extends { id?: unknown }>(rows: T[]): Map<string, T> {
  const out = new Map<string, T>();
  for (const r of rows) if (typeof r.id === 'string' && r.id) out.set(r.id, r);
  return out;
}
const bump = (m: Record<string, number>, k: string, n = 1) => (m[k] = (m[k] ?? 0) + n);

// --- pure helpers (tested directly) --------------------------------------------------------------------------

const KEY_RE = /\b[A-Z][A-Z0-9]{1,9}-\d+\b/g;
// Slack wraps links as <url|label>; mail bodies put them in <> or quotes — stop at any of those.
const URL_RE = /https?:\/\/[^\s<>|"'`)\]]+/g;

/** Tracker keys (`SH-12`, `P1-7`) and URLs in a text: the cross-source links a dedup or an attribution rung keys on. */
export function itemKeys(text: string, max = MAX_KEYS): string[] {
  const out = new Set<string>();
  for (const m of (text ?? '').matchAll(KEY_RE)) out.add(m[0]);
  for (const m of (text ?? '').matchAll(URL_RE)) out.add(m[0].replace(/[.,;:!?]+$/, ''));
  return [...out].slice(0, max);
}

/**
 * A stored meeting attendee as the bench sees it: the e-mail when there is one, else the name — EXACTLY as stored, so
 * a name-only Gemini entry and a glued "Ana Berg Rui Rosa" line stay what they are. That gap is what T3 measures;
 * production's `email ?? name` drops an empty-string e-mail's name instead.
 */
export function attendeeRaw(a: unknown): string {
  if (typeof a === 'string') return a;
  if (!a || typeof a !== 'object') return '';
  return str((a as Row).email) || str((a as Row).name);
}

const SPEAKER_RE = /^[ \t]*([^:\n]{2,40}):[ \t]/;
/** Distinct "Name:" speaker labels of a transcript, in order of first appearance (timestamps and URLs never match). */
export function speakerLabels(transcript: string, max = MAX_CO): string[] {
  const out: string[] = [];
  for (const line of (transcript ?? '').split('\n')) {
    const label = SPEAKER_RE.exec(line)?.[1]?.trim();
    if (!label || !/\p{L}/u.test(label) || label.split(/\s+/).length > 4 || out.includes(label)) continue;
    out.push(label);
    if (out.length >= max) break;
  }
  return out;
}

export const normTitle = (t: string): string => (t ?? '').toLowerCase().replace(/[^\p{L}\p{N}_]+/gu, ' ').trim();

/**
 * The summary section of topic #n (1-based) — the n-th of the sections `topics()` counts, so a `#n` fragment id and
 * its text line up. topics() drops structural and empty sections; equal headings get the same verdict, so walking the
 * raw sections in order and pairing each non-empty one whose heading is the next topic's reproduces its numbering.
 */
export function topicSection(summary: string, n: number): string {
  const sections: { heading: string; lines: string[]; length: number }[] = [];
  for (const line of (summary ?? '').split('\n')) {
    const m = line.match(/^#{1,2}\s+(.+?)\s*#*\s*$/);
    if (m) sections.push({ heading: m[1]!.replace(/\*+/g, '').trim(), lines: [line], length: 0 });
    else if (sections.length) {
      const cur = sections[sections.length - 1]!;
      cur.lines.push(line);
      cur.length += line.trim().length;
    }
  }
  const want = topics(summary);
  let j = 0;
  for (const s of sections) {
    if (j >= want.length) break;
    if (s.length > 0 && s.heading === want[j]!.heading) {
      if (++j === n) return s.lines.join('\n').trim();
    }
  }
  return summary ?? '';
}

/**
 * A decision's attributions as gold: shares made relative (the ledger stores them weight-scaled), `alias_of` followed
 * and `split_into` spread, so a split of a 0.116-weight topic still reads 50/50. The top share is the label; every
 * other initiative holding ≥ 25 % also counts as correct (a two-way split has no wrong half).
 */
export function t1Label(atts: readonly Attribution[], reg: Registry): { label: string; alts: string[]; shares: { label: string; share: number }[] } | null {
  const total = atts.reduce((a, x) => a + (x.share > 0 ? x.share : 0), 0);
  const acc = new Map<string, number>();
  for (const a of atts) {
    const frac = total > 0 ? Math.max(0, a.share) / total : 1 / atts.length;
    for (const [id, w] of spread(a.initiative, reg)) acc.set(id, (acc.get(id) ?? 0) + frac * w);
  }
  const ranked = [...acc].sort((a, b) => b[1] - a[1]); // stable: ties keep the decider's order
  if (!ranked.length) return null;
  return {
    label: ranked[0]![0],
    alts: ranked.slice(1).filter(([, s]) => s >= 0.25).map(([id]) => id),
    shares: ranked.map(([label, share]) => ({ label, share: Math.round(share * 1000) / 1000 })),
  };
}

function spread(id: string, reg: Registry, depth = 0): [string, number][] {
  const r = reg.resolveAlias(id);
  const split = reg.get(r)?.split_into;
  if (!split || depth > 3) return [[r, 1]];
  const sum = Object.values(split).reduce((a, b) => a + (b > 0 ? b : 0), 0) || 1;
  return Object.entries(split).flatMap(([t, w]) => spread(t, reg, depth + 1).map(([x, v]): [string, number] => [x, (Math.max(0, w) / sum) * v]));
}

/** The match key a mention and an escalation subject share: the e-mail, else the folded name (identities/normalise.ts). */
export function mentionKey(raw: string): string | null {
  const p = parseIdentity(raw);
  return p.email ?? (p.name ? `name:${p.name}` : null);
}

/** The roster as the tenant's answers name people: by person id, by identity, or by the full name. */
export class Roster {
  private readonly ids: Set<string>;
  private readonly index: Map<string, string>;
  private readonly byKey = new Map<string, string>();
  private readonly byName = new Map<string, string[]>();
  constructor(readonly people: readonly Person[]) {
    this.ids = new Set(people.map((p) => p.person_id));
    this.index = identityIndex(identitiesOf(people));
    for (const p of people) {
      for (const id of p.identities) {
        const k = mentionKey(id);
        if (k && !this.byKey.has(k)) this.byKey.set(k, p.person_id);
      }
      const n = normaliseName(p.name);
      if (n) this.byName.set(n, [...(this.byName.get(n) ?? []), p.person_id]);
    }
  }
  /** Production's exact resolution: the identity key alone, no `<addr>` fallback, no name. */
  exact(raw: string): string | null {
    return this.index.get(identityKey(raw)) ?? null;
  }
  /** A key from mentionKey() → a person who lists it, or (names only) whose full name it is. */
  byMentionKey(key: string): string | null {
    if (this.byKey.has(key)) return this.byKey.get(key)!;
    const hits = key.startsWith('name:') ? (this.byName.get(key.slice(5)) ?? []) : [];
    return hits.length === 1 ? hits[0]! : null;
  }
  /** "<person_id>", an identity, or a full name — each comma/dash-separated segment tried in turn. */
  ref(text: string): string | null {
    for (const seg of (text ?? '').split(/\s*[,;(—–]\s*|\s+-\s+/)) {
      const t = seg.trim().replace(/^["“]|["”]$/g, '');
      if (!t) continue;
      if (this.ids.has(t.toLowerCase())) return t.toLowerCase();
      const hit = this.exact(t) ?? (mentionKey(t) ? this.byMentionKey(mentionKey(t)!) : null);
      if (hit) return hit;
    }
    return null;
  }
}

/**
 * An identity escalation's answer → a T3 label, or null when the answer names nobody this roster knows. A "new
 * person" whom the tenant has since added to the roster is that person (the answer is how they got there), else
 * UNKNOWN; "ignore"/"system" is SYSTEM wherever it appears ("no — a webinar list, ignore").
 */
export function identityAnswer(answer: string, options: readonly string[], subjectKey: string | null, roster: Roster): { label: string; how: string } | null {
  const a = (answer ?? '').trim();
  if (/^yes\b/i.test(a)) {
    const offered = options.map((o) => /^yes:\s*(\S+)/i.exec(o)?.[1]).filter((x): x is string => !!x);
    if (offered.length === 1) return { label: offered[0]!, how: 'yes' };
    const named = roster.ref(a.replace(/^yes\b[\s,:—–-]*/i, ''));
    return named && offered.includes(named) ? { label: named, how: 'yes' } : null;
  }
  const lead = /^(?:merge into|same as)\s+(.+)$/i.exec(a);
  if (lead) {
    const pid = roster.ref(lead[1]!);
    return pid ? { label: pid, how: 'merge' } : null;
  }
  if (/\b(ignore|system)\b/i.test(a)) return { label: SYSTEM, how: 'ignore' };
  if (/\bnew person\b/i.test(a) || /^no\b/i.test(a)) {
    const said = /\bnew person\s+(.+)$/i.exec(a)?.[1];
    const offered = /^new person\s+["“]([^"”]+)["”]/i.exec(options.find((o) => /^new person\s+["“]/i.test(o)) ?? '')?.[1];
    const name = said ? said.split(/\s*[,;(—–]\s*/)[0] : offered;
    const pid = (name ? roster.ref(name) : null) ?? (subjectKey ? roster.byMentionKey(subjectKey) : null);
    return pid ? { label: pid, how: 'new person, in the roster now' } : { label: UNKNOWN, how: 'new person' };
  }
  const later = /\b(?:merge into|same as)\s+(.+)$/i.exec(a);
  const pid = later ? roster.ref(later[1]!) : null;
  return pid ? { label: pid, how: 'merge' } : null;
}

// --- the export ------------------------------------------------------------------------------------------------

interface Win {
  since: string;
  until: string;
  lo: string;
  hi: string;
  has: (iso: string) => boolean;
}
function windowOf(since: string, until: string, tz: string): Win {
  return {
    since,
    until,
    // UTC prefilter a day wider on each side; the local-day test below is the real cut.
    lo: plusDays(since, -1),
    hi: plusDays(until, 2),
    has: (iso) => {
      if (!validIso(iso)) return false;
      const d = localDay(iso, tz);
      return d >= since && d <= until;
    },
  };
}

interface Msg {
  ref: string;
  source: string;
  account: string;
  container: string;
  thread: string;
  ts: string;
  person: string;
  author: string;
  subject: string;
  text: string;
  participants: string[];
  bot: boolean;
}
interface Comment {
  id: string;
  author: string;
  ts: string;
  text: string;
}
interface Task {
  ref: string;
  source: string;
  account: string;
  key: string;
  title: string;
  assignee: string;
  assigneePerson: string;
  reporter: string;
  reporterPerson: string;
  created: string;
  updated: string;
  project: string;
  url: string;
  text: string;
  comments: Comment[];
}
interface Meeting {
  ref: string;
  source: string;
  account: string;
  title: string;
  start: string;
  attendees: unknown[];
  summary: string;
  transcript: string;
  call: string;
  people: string[];
}
interface Ev {
  ref: string;
  source: string;
  calendar: string;
  start: string;
  t: number;
  title: string;
  norm: string;
  attendees: string[];
  organizer: string;
}

function loadStream(db: DatabaseSync, w: Win) {
  const messages: Msg[] = (db.prepare('SELECT ref, source, account, container, thread_id, ts, author_person, author_raw, subject, text, participants, is_bot FROM messages WHERE deleted = 0 AND ts >= ? AND ts < ? ORDER BY ts, ref').all(w.lo, w.hi) as Row[])
    .filter((r) => w.has(str(r.ts)))
    .map((r) => ({ ref: str(r.ref), source: str(r.source), account: str(r.account), container: str(r.container), thread: str(r.thread_id), ts: str(r.ts), person: str(r.author_person), author: str(r.author_raw), subject: str(r.subject), text: str(r.text), participants: json<unknown[]>(r.participants, []).filter((x): x is string => typeof x === 'string'), bot: Number(r.is_bot) === 1 }));
  // Tasks are read without an upper bound: a ticket touched after `until` may still carry comments inside the window.
  const tasks: Task[] = (db.prepare('SELECT ref, source, account, key, title, assignee_raw, assignee_person, reporter_raw, reporter_person, created, updated, project, url, text, comments FROM tasks WHERE deleted = 0 AND updated >= ? ORDER BY updated, ref').all(w.lo) as Row[]).map((r) => ({
    ref: str(r.ref), source: str(r.source), account: str(r.account), key: str(r.key), title: str(r.title), assignee: str(r.assignee_raw), assigneePerson: str(r.assignee_person), reporter: str(r.reporter_raw), reporterPerson: str(r.reporter_person),
    created: str(r.created), updated: str(r.updated), project: str(r.project), url: str(r.url), text: str(r.text),
    // The tracker writer scrubbed comment i as `<id>#c<id ?? i>`: the same fallback keeps comment ids stable.
    comments: json<unknown[]>(r.comments, []).filter((c): c is Row => !!c && typeof c === 'object').map((c, i) => ({ id: c.id != null && c.id !== '' ? str(c.id) : String(i), author: str(c.author), ts: str(c.ts), text: str(c.text) })),
  }));
  const mp = db.prepare('SELECT person_id FROM meeting_people WHERE ref = ? ORDER BY person_id');
  const meetings: Meeting[] = (db.prepare('SELECT ref, source, account, title, start, attendees, summary, transcript, call_id FROM meetings WHERE deleted = 0 AND start >= ? AND start < ? ORDER BY start, ref').all(w.lo, w.hi) as Row[])
    .filter((r) => w.has(str(r.start)))
    .map((r) => ({ ref: str(r.ref), source: str(r.source), account: str(r.account), title: str(r.title), start: str(r.start), attendees: json<unknown[]>(r.attendees, []), summary: str(r.summary), transcript: str(r.transcript), call: str(r.call_id), people: (mp.all(str(r.ref)) as Row[]).map((x) => str(x.person_id)) }));
  // Every event, not only the window's: a recording links to its calendar entry wherever that sits.
  const events: Ev[] = (db.prepare("SELECT ref, source, calendar, start, title, attendees, organizer FROM events WHERE deleted = 0 AND start != '' ORDER BY start, ref").all() as Row[])
    .filter((r) => validIso(str(r.start)))
    .map((r) => {
      const cal = str(r.calendar);
      const calendar = cal.startsWith('{') ? str(json<Row>(cal, {}).name) || str(json<Row>(cal, {}).id) : cal;
      return { ref: str(r.ref), source: str(r.source), calendar, start: str(r.start), t: Date.parse(str(r.start)), title: str(r.title), norm: normTitle(str(r.title)), attendees: json<unknown[]>(r.attendees, []).filter((x): x is string => typeof x === 'string'), organizer: str(r.organizer) };
    });
  return { messages, tasks, meetings, events };
}
type Stream = ReturnType<typeof loadStream>;

function linkedEvent(events: readonly Ev[], m: Meeting): Ev | null {
  const t0 = Date.parse(m.start);
  const nt = normTitle(m.title);
  if (!nt || Number.isNaN(t0)) return null;
  let best: Ev | null = null;
  for (const e of events) if (e.norm === nt && Math.abs(e.t - t0) <= LINK_MS && (!best || Math.abs(e.t - t0) < Math.abs(best.t - t0))) best = e;
  return best;
}

function itemUnits(db: DatabaseSync, w: Win, s: Stream, tz: string, subject: string | undefined, index: ReadonlyMap<string, string>, stats: Record<string, number>): ItemUnit[] {
  const to = new Map<string, string[]>();
  for (const r of db.prepare("SELECT mp.ref AS ref, mp.person_id AS pid FROM message_people mp JOIN messages m ON m.ref = mp.ref WHERE mp.role = 'to' AND m.deleted = 0 AND m.ts >= ? AND m.ts < ? ORDER BY mp.person_id").all(w.lo, w.hi) as Row[]) {
    to.set(str(r.ref), [...(to.get(str(r.ref)) ?? []), str(r.pid)]);
  }
  const prev = db.prepare('SELECT ref, author_raw, ts, text FROM messages WHERE thread_id = ? AND deleted = 0 AND ts < ? ORDER BY ts DESC, ref DESC LIMIT 3');
  const ctx = (rows: { ref: string; author: string | null; ts: string; text: string }[]) => (rows.length ? { context: rows.map((r) => ({ ...r, text: clip(r.text, TEXT_CONTEXT) })) } : {});
  const out: ItemUnit[] = [];
  for (const m of s.messages) {
    const before = (prev.all(m.thread, m.ts) as Row[]).reverse().map((r) => ({ ref: str(r.ref), author: str(r.author_raw) || null, ts: str(r.ts), text: str(r.text) }));
    out.push({
      id: m.ref, day: localDay(m.ts, tz), ts: m.ts, type: 'message', source: m.source, account: m.account, container: m.container || null, thread: m.thread || null,
      author: m.author || null, authorPerson: m.person || null, isBot: m.bot, participants: m.participants, toPersons: to.get(m.ref) ?? [], subject: m.subject || null,
      text: clip(m.text, TEXT_ITEM), keys: itemKeys(`${m.subject}\n${m.text}`), ...ctx(before), ...(subject ? { fromSubject: !!m.person && m.person === subject } : {}),
    });
  }
  for (const t of s.tasks) {
    // Task and comments share a thread (the task ref) and the task's own key, so a dedup or a ticket rung sees them as one.
    const keys = (body: string) => [...new Set([...(t.key ? [t.key] : []), ...itemKeys(body), ...(t.url ? [t.url] : [])])].slice(0, MAX_KEYS);
    if (w.has(t.updated)) {
      out.push({
        id: t.ref, day: localDay(t.updated, tz), ts: t.updated, type: 'task', source: t.source, account: t.account, container: t.project || null, thread: t.ref,
        author: t.reporter || null, authorPerson: t.reporterPerson || null, isBot: false, participants: [...new Set([t.reporter, t.assignee].filter(Boolean))],
        // Production's addressee of a ticket is its assignee; comments have none.
        toPersons: t.assigneePerson ? [t.assigneePerson] : [], subject: t.title || null, text: clip(`${t.title}\n${t.text}`.trim(), TEXT_ITEM), keys: keys(`${t.title}\n${t.text}`),
        ...(subject ? { fromSubject: !!t.reporterPerson && t.reporterPerson === subject } : {}),
      });
    }
    const sorted = [...t.comments].sort((a, b) => a.ts.localeCompare(b.ts));
    sorted.forEach((c, i) => {
      if (!w.has(c.ts)) return;
      const person = c.author ? (resolveIdentity(c.author, index) ?? '') : '';
      // A comment means little without the ticket: the previous comments, topped up with the description itself.
      const earlier = sorted.slice(Math.max(0, i - 3), i).map((p) => ({ ref: `${t.ref}#c${p.id}`, author: p.author || null, ts: p.ts, text: p.text }));
      const context = earlier.length < 3 ? [{ ref: t.ref, author: t.reporter || null, ts: t.created, text: `${t.title}\n${t.text}`.trim() }, ...earlier] : earlier;
      out.push({
        id: `${t.ref}#c${c.id}`, day: localDay(c.ts, tz), ts: c.ts, type: 'comment', source: t.source, account: t.account, container: t.project || null, thread: t.ref,
        author: c.author || null, authorPerson: person || null, isBot: false, participants: c.author ? [c.author] : [], toPersons: [], subject: t.title || null,
        text: clip(c.text, TEXT_ITEM), keys: keys(c.text), ...ctx(context), ...(subject ? { fromSubject: !!person && person === subject } : {}),
      });
    });
  }
  for (const m of s.meetings) {
    out.push({
      // Recorder copies of one call share a thread (calls.ts call_id): the cheapest dedup family there is.
      id: m.ref, day: localDay(m.start, tz), ts: m.start, type: 'meeting', source: m.source, account: m.account, container: null, thread: m.call || m.ref,
      author: null, authorPerson: null, isBot: false, participants: m.attendees.map(attendeeRaw).filter((x) => x.trim()), toPersons: m.people, subject: m.title || null,
      text: clip(`${m.title}\n${m.summary}`.trim(), TEXT_ITEM), keys: itemKeys(`${m.title}\n${m.summary}`),
    });
  }
  out.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts) || a.id.localeCompare(b.id));
  for (const u of out) bump(stats, u.type);
  return out;
}

interface Occ {
  field: MentionUnit['field'];
  raw: string;
  source: string;
  ref: string;
  ts: string;
  title: string;
  container: string | null;
  co: string[];
  production: string | null;
  meeting?: Meeting;
}

/** Every distinct (field, raw) participant string of the window, as stored, with where it was first seen. */
function mentionUnits(s: Stream, w: Win, tz: string, index: ReadonlyMap<string, string>): MentionUnit[] {
  const occ: Occ[] = [];
  const who = (raw: string) => (raw ? (resolveIdentity(raw, index) ?? null) : null);
  // `around`: people of the record who are not mentions of their own here (a comment's ticket assignee/reporter).
  const add = (rec: Omit<Occ, 'field' | 'raw' | 'co' | 'production'>, entries: { field: Occ['field']; raw: string; production: string | null }[], around: string[] = []) => {
    const live = entries.filter((e) => e.raw.trim());
    const raws = [...new Set([...live.map((e) => e.raw), ...around.filter((x) => x.trim())])];
    const seen = new Set<string>();
    for (const e of live) {
      const k = `${e.field}\0${e.raw}`;
      if (seen.has(k)) continue; // one record counts once per (field, raw)
      seen.add(k);
      occ.push({ ...rec, field: e.field, raw: e.raw, production: e.production, co: raws.filter((r) => r !== e.raw).slice(0, MAX_CO) });
    }
  };
  for (const m of s.messages) {
    if (m.bot) continue; // the store already knows bots are not people (observations.ts does the same)
    add({ source: m.source, ref: m.ref, ts: m.ts, title: m.subject, container: m.container || null }, [
      { field: 'author', raw: m.author, production: m.person || null },
      ...m.participants.filter((p) => p !== m.author).map((p) => ({ field: 'participant' as const, raw: p, production: who(p) })),
    ]);
  }
  for (const m of s.meetings) {
    add({ source: m.source, ref: m.ref, ts: m.start, title: m.title, container: null, meeting: m }, m.attendees.map((a) => ({ field: 'attendee' as const, raw: attendeeRaw(a), production: resolveAttendee(a, index) ?? null })));
  }
  for (const e of s.events) {
    if (!w.has(e.start)) continue;
    add({ source: e.source, ref: e.ref, ts: e.start, title: e.title, container: e.calendar || null }, [
      ...e.attendees.map((a) => ({ field: 'attendee' as const, raw: a, production: who(a) })),
      { field: 'organizer', raw: e.organizer, production: who(e.organizer) },
    ]);
  }
  for (const t of s.tasks) {
    if (w.has(t.updated)) {
      add({ source: t.source, ref: t.ref, ts: t.updated, title: t.title, container: t.project || null }, [
        { field: 'assignee', raw: t.assignee, production: t.assigneePerson || null },
        { field: 'reporter', raw: t.reporter, production: t.reporterPerson || null },
      ]);
    }
    for (const c of t.comments) {
      if (!w.has(c.ts)) continue;
      add({ source: t.source, ref: `${t.ref}#c${c.id}`, ts: c.ts, title: t.title, container: t.project || null }, [{ field: 'comment_author', raw: c.author, production: who(c.author) }], [t.assignee, t.reporter]);
    }
  }
  occ.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts) || a.ref.localeCompare(b.ref));
  const groups = new Map<string, { first: Occ; n: number }>();
  for (const o of occ) {
    const k = `${o.field}\0${o.raw}`;
    const g = groups.get(k);
    if (g) g.n++;
    else groups.set(k, { first: o, n: 1 });
  }
  const links = new Map<string, MentionUnit['context']['linkedEvent']>();
  const ids = new Set<string>();
  const out: MentionUnit[] = [];
  for (const { first: f, n } of groups.values()) {
    let id = `mention:${f.field}:${hash(f.raw)}`;
    for (let i = 2; ids.has(id); i++) id = `mention:${f.field}:${hash(f.raw)}~${i}`; // an fnv collision must not merge two strings
    ids.add(id);
    let meetingCtx = {};
    if (f.meeting) {
      if (!links.has(f.meeting.ref)) {
        const e = linkedEvent(s.events, f.meeting);
        links.set(f.meeting.ref, e ? { title: e.title, start: e.start, attendees: e.attendees } : null);
      }
      meetingCtx = { linkedEvent: links.get(f.meeting.ref) ?? null, speakers: speakerLabels(f.meeting.transcript) };
    }
    out.push({
      id, day: localDay(f.ts, tz), raw: f.raw, field: f.field, source: f.source, ref: f.ref, seen: n,
      context: { ...(f.title ? { title: f.title } : {}), start: f.ts, container: f.container, coMentions: f.co, ...meetingCtx },
      production: f.production,
    });
  }
  return out;
}

function fragmentUnits(db: DatabaseSync, drafts: readonly FragmentDraft[], meetings: readonly MeetingIn[], ctx: FrozenLadderCtx, tz: string): FragmentUnit[] {
  const calls = new Map(meetings.map((m) => [`meeting:${m.source}:${m.id}`, m]));
  const msg = db.prepare('SELECT author_raw, ts, subject, text FROM messages WHERE ref = ?');
  const act = db.prepare('SELECT title, items_text FROM activity WHERE source = ? AND id = ? AND deleted = 0');
  const text = (d: FragmentDraft): string => {
    if (d.kind === 'call') {
      const summary = calls.get(d.refs[0] ?? '')?.summary ?? '';
      const n = /#(\d+)$/.exec(d.id);
      return (n ? topicSection(summary, Number(n[1])) : summary) || d.title;
    }
    if (d.kind === 'work') {
      const m = /^activity:([^:]+):(.+)$/.exec(d.refs[0] ?? '');
      const r = m ? (act.get(m[1]!, m[2]!) as Row | undefined) : undefined;
      return str(r?.items_text) || str(r?.title) || d.title;
    }
    // A run is the subject's own messages; a call's attached greeting refs are not part of its text.
    return d.refs
      .map((ref) => msg.get(ref) as Row | undefined)
      .filter((r): r is Row => !!r)
      .sort((a, b) => str(a.ts).localeCompare(str(b.ts)))
      .map((r) => `${str(r.author_raw)}: ${str(r.subject) ? `${str(r.subject)} — ` : ''}${str(r.text)}`)
      .join('\n');
  };
  return drafts.map((d) => {
    const r = frozenAttribute(d, ctx); // main's ladder ALONE: no ledger, no pins — what the rules decide today
    const top = r.decided ? [...r.decided.attributions].sort((a, b) => b.share - a.share)[0]?.initiative : undefined;
    const ladder = r.decided
      ? { state: 'rule', ...(top ? { initiative: top } : {}), candidates: r.candidates, rule: r.decided.rule_id, ...(r.hint ? { hint: r.hint } : {}) }
      : { state: 'open', candidates: r.candidates, ...(r.hint ? { hint: r.hint } : {}) };
    const wall = Math.max(0, Date.parse(d.end) - Date.parse(d.start)) / 60_000;
    return {
      id: d.id, day: localDay(d.start, tz), kind: d.kind, start: d.start, end: d.end, minutes: Math.round(wall * d.weight * 10) / 10, title: d.title, source: d.source, container: d.container,
      participants: d.participants, projectKeys: d.projectKeys, repo: d.repo, weight: d.weight, refs: d.refs, text: clip(text(d), TEXT_FRAGMENT), ladder,
    };
  });
}

const TIER: Record<string, GoldTier> = { owen: 'human', model: 'model', rule: 'rule' };

/** Gold for t1-fragment from what the tenant and the platform already decided — ledger > pin, plus answered escalations. */
function t1Gold(units: readonly FragmentUnit[], drafts: readonly FragmentDraft[], ctx: LadderCtx, reg: Registry, ann: string, pinsPath: string | undefined, stats: Record<string, number>): GoldRow[] {
  const rows = new Map<string, GoldRow>(); // one per (unit, tier): the first source wins
  const put = (id: string, atts: readonly Attribution[], tier: GoldTier, note: string): boolean => {
    const k = `${id}\0${tier}`;
    const l = t1Label(atts, reg);
    if (rows.has(k) || !l) return false;
    rows.set(k, { id, task: 't1-fragment', label: l.label, ...(l.alts.length ? { alts: l.alts } : {}), ...(l.shares.length > 1 ? { shares: l.shares } : {}), tier, note });
    return true;
  };
  const unitIds = new Set(units.map((u) => u.id));
  const path = join(ann, 'fragments.jsonl');
  const { fragments: live, malformed } = parseFragments(existsSync(path) ? readFileSync(path, 'utf8') : ''); // last line per id, superseded dropped
  stats.ledger_malformed = malformed;
  const ledger = new Map<string, LedgerRecord>(live.map((f) => [f.id, { id: f.id, kind: f.kind, refs: f.refs, attributions: f.attributions, decided_by: f.decided_by, rule_id: f.rule_id ?? null, rationale: f.rationale ?? '', status: f.status }]));
  // The plan's own precedence and matching (by id; a thread by any overlapping ref), without pins.
  const covered = new Set<string>();
  for (const p of planFragments([...drafts], ledger, ctx)) {
    if (!p.ledger_id) continue;
    covered.add(p.ledger_id);
    if (p.state !== 'decided') {
      bump(stats, 'units_ledger_escalated');
      continue;
    }
    const byRefs = p.ledger_id !== p.draft.id;
    if (put(p.draft.id, p.attributions, TIER[p.decided_by ?? 'model'] ?? 'model', `ledger ${p.ledger_id}${byRefs ? ' (by refs)' : ''}`)) bump(stats, byRefs ? 'ledger_rows_by_refs' : 'ledger_rows_by_id');
    else bump(stats, 'ledger_no_attributions');
  }
  const decided = live.filter((f) => f.status === 'decided');
  stats.ledger_decided = decided.length;
  stats.ledger_skipped = decided.filter((f) => !covered.has(f.id)).length; // attach to no exported fragment
  const pins = pinsPath ? readPins(pinsPath) : new Map();
  stats.pins = pins.size;
  for (const pin of pins.values()) {
    if (!unitIds.has(pin.id)) bump(stats, 'pins_skipped');
    else if (put(pin.id, pin.attributions, 'rule', `pin ${pin.rule_id ?? ''}`.trim())) bump(stats, 'pin_rows');
  }
  // Answered attribution escalations that point at fragments: `esc-attr-<fragment id>`, or fragment ids in refs.
  const regIds = reg.data.initiatives.map((i) => i.id).sort((a, b) => b.length - a.length);
  const idsIn = (text: string) => [...new Set(regIds.filter((id) => new RegExp(`(?<![\\w/-])${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w/-])`).test(text)).map((id) => t1Label([{ initiative: id, share: 1 }], reg)!.label))];
  const byId = new Map(live.map((f) => [f.id, f]));
  for (const e of lastById(lines<Row>(join(ann, 'escalations.jsonl'))).values()) {
    if (e.kind !== 'attribution' || e.status !== 'answered' || typeof e.answer !== 'string') continue;
    const answer = e.answer.trim();
    bump(stats, 'esc_answered');
    const id = str(e.id);
    const targets = [...new Set([...(id.startsWith('esc-attr-frag-') ? [id.slice('esc-attr-'.length)] : []), ...(Array.isArray(e.refs) ? e.refs.map(str).filter((r) => r.startsWith('frag-')) : [])])];
    if (!targets.length) {
      bump(stats, 'esc_not_fragments');
      continue;
    }
    const options = Array.isArray(e.options) ? e.options.map(str) : [];
    for (const target of targets) {
      if (!unitIds.has(target)) {
        bump(stats, 'esc_targets_skipped');
        continue;
      }
      // The answer is free text. In order: the registry id it names; the option it picks; else the ledger line written
      // after the question (the answer as applied — an `owen` line, or the rule it was turned into).
      const named = idsIn(answer);
      const applied = byId.get(target);
      const appliedOk = applied && applied.status === 'decided' && (applied.decided_by === 'owen' || applied.decided_by === 'rule') && !!applied.decided_at && applied.decided_at >= str(e.asked_at);
      const appliedLabel = appliedOk ? t1Label(applied.attributions, reg)?.label : undefined;
      const picked = options.find((o, i) => o.trim().toLowerCase() === answer.toLowerCase() || answer === String(i + 1));
      let label: string | undefined;
      if (named.length === 1) label = named[0];
      else if (appliedLabel && (!named.length || named.includes(appliedLabel))) label = appliedLabel;
      else if (picked) label = /^not work$/i.test(picked.trim()) ? NONE : idsIn(picked).length === 1 ? idsIn(picked)[0] : undefined;
      if (!label) {
        bump(stats, 'esc_unresolved');
        continue;
      }
      if (put(target, [{ initiative: label, share: 1 }], 'human', `escalation ${id}`)) bump(stats, 'esc_rows');
      else bump(stats, 'esc_already_human');
    }
  }
  return [...rows.values()].sort((a, b) => a.id.localeCompare(b.id) || a.tier.localeCompare(b.tier));
}

/** Gold for t3-identity: answered identity escalations (human), the tenant's merge log and the roster itself (rule). */
function t3Gold(mentions: readonly MentionUnit[], roster: Roster, ann: string, stats: Record<string, number>): GoldRow[] {
  const rows = new Map<string, GoldRow>();
  const put = (id: string, label: string, tier: GoldTier, note: string) => {
    const k = `${id}\0${tier}`;
    if (rows.has(k)) return false;
    rows.set(k, { id, task: 't3-identity', label, tier, note });
    return true;
  };
  const byKey = new Map<string, MentionUnit[]>();
  for (const m of mentions) {
    const k = mentionKey(m.raw);
    if (k) byKey.set(k, [...(byKey.get(k) ?? []), m]);
  }
  // Roster first: exactly what production resolves by key today (people.ts identityKey, no `<addr>` fallback).
  for (const m of mentions) {
    const pid = roster.exact(m.raw);
    if (pid && put(m.id, pid, 'rule', 'roster')) bump(stats, 'roster_rows');
  }
  const merges = lines<Row>(join(ann, 'identity-merges.jsonl')).filter((r) => typeof r.identity === 'string' && typeof r.person_id === 'string');
  stats.merge_lines = merges.length;
  for (const r of merges) {
    const key = identityKey(str(r.identity));
    const mk = mentionKey(str(r.identity));
    for (const m of mentions) {
      if (identityKey(m.raw) !== key && (!mk || mentionKey(m.raw) !== mk)) continue;
      if (put(m.id, str(r.person_id), 'rule', `merge: ${str(r.reason)}`)) bump(stats, 'merge_rows');
    }
  }
  for (const e of lastById(lines<Row>(join(ann, 'escalations.jsonl'))).values()) {
    if (e.kind !== 'identity_merge' || e.status !== 'answered' || typeof e.answer !== 'string') continue;
    bump(stats, 'esc_answered');
    // The subject is the quoted label of the question ("Who is "x"?" / "Is “x” (…) = …?"), keyed like a mention.
    const label = /[“"]([^”"]+)[”"]/.exec(str(e.question))?.[1];
    const key = label ? mentionKey(label) : null;
    const hits = key ? (byKey.get(key) ?? []) : [];
    if (!hits.length) {
      bump(stats, 'esc_no_mention');
      continue;
    }
    const a = identityAnswer(e.answer, Array.isArray(e.options) ? e.options.map(str) : [], key, roster);
    if (!a) {
      bump(stats, 'esc_unresolved');
      continue;
    }
    bump(stats, `esc_${a.label === UNKNOWN ? 'unknown' : a.label === SYSTEM ? 'system' : 'person'}`);
    for (const m of hits) if (put(m.id, a.label, 'human', `escalation ${str(e.id)}: ${a.how}`)) bump(stats, 'esc_rows');
  }
  return [...rows.values()].sort((a, b) => a.id.localeCompare(b.id) || a.tier.localeCompare(b.tier));
}

/**
 * Tenant entries dated on or after `since` (a local day): answers given INSIDE the window that the tenant as given
 * already holds — rules written from answers (`created`), identity merges (`at`), identity questions answered
 * (`asked_at`). A replay hands them to every variant from day one, and the store's own resolution
 * (MentionUnit.production) already reflects the merges: the bench does not rebuild an as-of tenant (docs/lab.md),
 * so the export says how much of the window's own answers the given tenant carries.
 */
export function lateTenantEntries(ann: string, since: string, tz: string): string[] {
  const dayOf = (v: unknown): string | null => (typeof v === 'string' && validIso(v) ? localDay(v, tz) : null);
  const late = (v: unknown): boolean => (dayOf(v) ?? '') >= since;
  const out: string[] = [];
  const rulesPath = join(ann, 'rules.json');
  const raw = existsSync(rulesPath) ? json<unknown>(readFileSync(rulesPath, 'utf8'), []) : [];
  const rules = (Array.isArray(raw) ? raw : raw && typeof raw === 'object' && Array.isArray((raw as { rules?: unknown }).rules) ? (raw as { rules: unknown[] }).rules : []).filter((r): r is Row => !!r && typeof r === 'object');
  const lateRules = rules.filter((r) => late(r.created)).length;
  if (lateRules) out.push(`${lateRules} of ${rules.length} tenant rules were created on or after ${since}: a replay reads them from its first day`);
  const merges = lines<Row>(join(ann, 'identity-merges.jsonl')).filter((r) => late(r.at)).length;
  if (merges) out.push(`${merges} identity merges were made on or after ${since}: people.json and the store's resolution (mention 'production') already hold them`);
  const asked = [...lastById(lines<Row>(join(ann, 'escalations.jsonl'))).values()].filter((e) => e.kind === 'identity_merge' && e.status === 'answered' && late(e.asked_at)).length;
  if (asked) out.push(`${asked} identity questions asked on or after ${since} were answered: the roster may already hold their answers`);
  return out;
}

/** people.json as the tenant ships it; without one, the roster the store was built with (people + identities). */
function loadRoster(path: string, db: DatabaseSync): Person[] {
  if (existsSync(path)) return validatePeople(JSON.parse(readFileSync(path, 'utf8')), path);
  const ids = db.prepare('SELECT identity, person_id FROM identities ORDER BY identity').all() as Row[];
  return (db.prepare('SELECT person_id, name, company, marker_type, marker_initiatives FROM people ORDER BY person_id').all() as Row[]).map((p) => ({
    person_id: str(p.person_id), name: str(p.name), ...(p.company ? { company: str(p.company) } : {}),
    ...(p.marker_type ? { marker: { type: str(p.marker_type) as 'exclusive' | 'narrow' | 'broad', initiatives: json<string[]>(p.marker_initiatives, []) } } : {}),
    identities: ids.filter((i) => i.person_id === p.person_id).map((i) => str(i.identity)),
  }));
}

/** A link in the dataset dir; an existing real file there is refused unless it already IS the source. */
function link(at: string, target: string, type: 'file' | 'dir'): void {
  let isLink = false;
  try {
    isLink = lstatSync(at).isSymbolicLink();
  } catch {
    symlinkSync(target, at, type);
    return;
  }
  if (!isLink) {
    if (realpathSync(at) === realpathSync(target)) return;
    throw new Error(`${at} exists and is not a link — refusing to replace it`);
  }
  unlinkSync(at);
  symlinkSync(target, at, type);
}

export async function exportDataset(opts: ExportOptions): Promise<DatasetMeta> {
  const log = opts.log ?? (() => {});
  const days = opts.itemsWindowDays ?? 30;
  const storePath = resolve(opts.source.store);
  const tenantDir = resolve(opts.source.tenantDir);
  const ann = join(tenantDir, 'annotations');
  const out = resolve(opts.outDir);
  const db = openReadOnly(storePath);
  try {
    const tz = opts.tz ?? (str((db.prepare("SELECT value FROM sync_state WHERE key = 'tz'").get() as Row | undefined)?.value) || 'UTC');
    const people = loadRoster(join(ann, 'people.json'), db);
    const roster = new Roster(people);
    const regPath = join(tenantDir, 'initiatives.json');
    const regRaw: unknown = existsSync(regPath) ? JSON.parse(readFileSync(regPath, 'utf8')) : null;
    const reg = new Registry(regRaw !== null ? parseRegistry(regRaw, regPath) : { initiatives: [] });
    // No pinsPath here on purpose: recomputeAttribution is the only writer of pins, and it is never called.
    const att = readAttributionInputs({ tenantRoot: tenantDir, annotationsDir: ann, timezone: tz });
    const subject = att?.inputs.config.subject;
    const itemsSince = plusDays(opts.until, -(days - 1));
    const fragSince = opts.since ?? att?.inputs.config.since ?? itemsSince;
    const report: ExportReport = { windows: { fragments: att ? [fragSince, opts.until] : null, items: [itemsSince, opts.until] }, units: { fragment: 0, item: 0, mention: 0 }, items: {}, gold: {}, t1: {}, t3: {}, warnings: [] };

    let fragments: FragmentUnit[] = [];
    let t1: GoldRow[] = [];
    if (att) {
      if (localDay(opts.now.toISOString(), tz) < opts.until) report.warnings.push(`now (${opts.now.toISOString()}) is before the end of ${opts.until}: the production horizon stops at ${localDay(opts.now.toISOString(), tz)}`);
      const loaded = loadAttributionDrafts(db, { ...att.inputs, config: { ...att.inputs.config, since: fragSince } }, people, opts.now);
      const drafts = loaded.drafts.filter((d) => {
        const day = localDay(d.start, tz);
        return day >= fragSince && day <= opts.until;
      });
      // Main's ladder over this branch's drafts: the same rules, people, subject and admin map; only the ladder code
      // and the registry parse are main's (an object channel entry, for one, routed nowhere there).
      const frozen: FrozenLadderCtx = {
        rules: loaded.ctx.rules,
        people: loaded.ctx.people,
        reg: new FrozenRegistry(regRaw !== null ? parseFrozenRegistry(regRaw, regPath) : { initiatives: [] }),
        self: loaded.ctx.self,
        ...(loaded.ctx.admin ? { admin: loaded.ctx.admin } : {}),
      };
      fragments = fragmentUnits(db, drafts, loaded.meetings, frozen, tz);
      t1 = t1Gold(fragments, drafts, loaded.ctx, reg, ann, opts.source.pinsPath ? resolve(opts.source.pinsPath) : undefined, report.t1);
    }
    const w = windowOf(itemsSince, opts.until, tz);
    const index = new Map((db.prepare('SELECT identity, person_id FROM identities').all() as Row[]).map((r) => [str(r.identity), str(r.person_id)]));
    const stream = loadStream(db, w);
    const items = itemUnits(db, w, stream, tz, subject, index, report.items);
    const mentions = mentionUnits(stream, w, tz, index); // in replay order: first occurrences, oldest first
    const t3 = t3Gold(mentions, roster, ann, report.t3);

    writeJsonl(join(out, 'units', 'fragment.jsonl'), fragments);
    writeJsonl(join(out, 'units', 'item.jsonl'), items);
    writeJsonl(join(out, 'units', 'mention.jsonl'), mentions);
    // Only the exporter's own gold files are (re)written: silver labellers add theirs beside them.
    writeJsonl(join(out, 'gold', 't1-fragment.jsonl'), t1);
    writeJsonl(join(out, 'gold', 't3-identity.jsonl'), t3);
    link(join(out, 'store.sqlite'), storePath, 'file');
    link(join(out, 'tenant'), tenantDir, 'dir');

    for (const [task, rows] of [['t1-fragment', t1], ['t3-identity', t3]] as const) for (const r of rows) bump((report.gold[task] ??= {}), r.tier);
    report.units = { fragment: fragments.length, item: items.length, mention: mentions.length };
    const since = att && fragSince < itemsSince ? fragSince : itemsSince;
    report.warnings.push(...lateTenantEntries(ann, since, tz));
    const live = reg.data.initiatives.filter((i) => !i.alias_of && !i.split_into);
    const meta: DatasetMeta = {
      name: opts.name,
      kind: opts.kind,
      tenant: opts.tenant ?? opts.name.replace(/-(real|synthetic)$/, ''),
      tz,
      since,
      until: opts.until,
      ...(subject ? { subject } : {}),
      createdAt: opts.now.toISOString(),
      sourceStore: storePath,
      labelSpace: {
        // Aliases and splits never appear as gold (t1Label resolves them), so they are not offered as labels either.
        initiatives: live.map((i) => i.id),
        umbrellas: Object.fromEntries(reg.data.initiatives.map((i) => [i.id, i.umbrella ?? reg.get(reg.resolveAlias(i.id))?.umbrella ?? i.id])),
        people: people.map((p) => p.person_id),
      },
      counts: { ...report.units },
      notes: `fragments ${att ? `${fragSince}..${opts.until}` : 'none (no annotations/attribution.json)'}; items and mentions ${itemsSince}..${opts.until} (${tz}); gold from existing judgments only (ledger, pins, answered escalations, merges, roster) — see export.json; a fragment's ladder is main's (variants/frozen), its draft this branch's fragmenter`,
    };
    saveMeta(out, meta);
    writeFileSync(join(out, 'export.json'), `${JSON.stringify(report, null, 2)}\n`);
    annotateCases(out); // recorder copies and topics of one call share call:<call_id> (annotate.ts)
    log(`${opts.name}: ${JSON.stringify(report.units)} items ${JSON.stringify(report.items)} gold ${JSON.stringify(report.gold)}`);
    log(`  t1 ${JSON.stringify(report.t1)}`);
    log(`  t3 ${JSON.stringify(report.t3)}`);
    for (const x of report.warnings) log(`  warning: ${x}`);
    return meta;
  } finally {
    db.close();
  }
}

const USAGE = `usage: lab export --name <dataset> --store <store.sqlite> --tenant <tenant dir> --until YYYY-MM-DD
  [--since YYYY-MM-DD] [--days 30] [--tz <zone>] [--pins <pins.jsonl>] [--out <dir>] [--kind real|synthetic] [--now <ISO>] [--slug <tenant>]
  --out defaults to $LAB_DIR/datasets/<name> (LAB_DIR defaults to data/lab); --pins to <store dir>/attribution/pins.jsonl when present.`;

/** `lab export …` (the leading `export` is optional, so the lab CLI can pass its argv through). */
export async function main(argv: string[]): Promise<void> {
  const args = argv[0] === 'export' ? argv.slice(1) : argv;
  const s = { type: 'string' } as const;
  const { values: v } = parseArgs({ args, options: { name: s, store: s, tenant: s, pins: s, until: s, since: s, days: s, tz: s, out: s, kind: s, now: s, slug: s }, strict: true, allowPositionals: false });
  const DAY = /^\d{4}-\d{2}-\d{2}$/;
  const days = v.days === undefined ? 30 : Number(v.days);
  const now = v.now ? new Date(v.now) : new Date();
  const kind = v.kind ?? 'real';
  if (!v.name || !v.store || !v.tenant || !v.until || !DAY.test(v.until) || (v.since && !DAY.test(v.since)) || !Number.isInteger(days) || days < 1 || Number.isNaN(now.getTime()) || (kind !== 'real' && kind !== 'synthetic')) throw new Error(USAGE);
  const pins = v.pins ?? (existsSync(join(dirname(resolve(v.store)), 'attribution', 'pins.jsonl')) ? join(dirname(resolve(v.store)), 'attribution', 'pins.jsonl') : undefined);
  const outDir = v.out ?? join(process.env.LAB_DIR || join('data', 'lab'), 'datasets', v.name);
  const meta = await exportDataset({
    name: v.name, kind, source: { store: v.store, tenantDir: v.tenant, ...(pins ? { pinsPath: pins } : {}) }, outDir, until: v.until, ...(v.since ? { since: v.since } : {}),
    itemsWindowDays: days, ...(v.tz ? { tz: v.tz } : {}), now, ...(v.slug ? { tenant: v.slug } : {}), log: (m) => console.log(m),
  });
  console.log(`wrote ${resolve(outDir)} (${meta.since}..${meta.until}, ${meta.tz})`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exitCode = 1;
  });
}
