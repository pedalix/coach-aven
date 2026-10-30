// Who was at a call — the attribution layer's one resolver from a surface form (an address, a label, a recorder's
// attendee entry, a transcript speaker) to a person of the tenant's people file. The store's resolver (people.ts
// resolveIdentity: lower case, two prefixes, exact) stays as it is — prod builds on it; this one is used only inside the
// attribution layer, which no prod tenant runs. What the store's misses cost here: most call fragments had no
// counterpart, so markers and the admin rung never fired on calls. The reasons and their fixes (design F4):
//   - attendee entries were read `email ?? name`, and a recorder that fills names only (Gemini, Wispr) writes an EMPTY
//     email — every name-only invitee was dropped. Entries are now read by the one parser (identities/attendees.ts);
//   - a person's `name` was never an identity (most people files list addresses and labels, not the name itself). It is
//     now an implicit one: a name two people share resolves nobody, and an explicit identity always beats a name;
//   - forms were compared exactly. They are now folded (attendees.ts foldName: accents, `| Company`, German ue/ae/oe)
//     with the source prefixes off and the address inside `Name <addr>` tried first;
//   - Gemini glues the invitee chips of its "Invited" line ("Ana Berg Rui Rosa"). A glued run is split against the full
//     names we know — the roster's, plus the names the linked calendar event and the transcript's speakers carry — and
//     counts only when the split covers the WHOLE run; a partial cover resolves nobody (never a guess);
//   - the recording's calendar event (the same normalised title, starting within ±15 min) adds its attendees and
//     organiser: Granola lists only the subject, Gemini glues — unless the event is a crowd (an all-hands);
//   - the transcript's "Name:" speaker labels add whoever spoke.
// Store-exact first: whatever the store's index resolves keeps resolving the same way. Pure except the two loaders at
// the end (read-only SQL).
import type { DatabaseSync } from 'node:sqlite';
import { foldName, foldTokens, parseAttendee, splitGlued } from '../identities/attendees.js';
import { MASS_ATTENDEES } from '../identities/observations.js';
import { resolveIdentity } from '../people.js';

export interface PersonLike {
  person_id: string;
  name: string;
  identities: readonly string[];
}

const PREFIX = /^(?:slack|msgraph|teams|jira|youtrack|asana|wrike|github|gitlab):/i;
const EMAIL_G = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const BRACKETED = /<\s*(?:mailto:)?([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})\s*>/;
const ADDRESS = /^[^\s@]+@[^\s@]+\.[A-Za-z]{2,}$/;
/** A tracker's `<login>@<ORG>` (youtrack): a dotless "domain" is an org, not mail — the login is the key. */
const LOGIN_AT_ORG = /^([^@\s]+)@([A-Za-z0-9_-]+)$/;

/** The comparison key of one surface form: an address lower-cased, anything else folded. '' = nothing to compare. */
export function formKey(raw: string | null | undefined): string {
  let s = (raw ?? '').trim();
  for (let i = 0; i < 2 && PREFIX.test(s); i++) s = s.replace(PREFIX, '').trim();
  const login = LOGIN_AT_ORG.exec(s);
  if (login) s = login[1]!;
  const bracket = BRACKETED.exec(s);
  if (bracket) return bracket[1]!.toLowerCase();
  if (ADDRESS.test(s)) return s.toLowerCase();
  return foldName(s.replace(/^@/, ''));
}

/** Every key a surface form may resolve by, most specific first: the bracketed address, every address, the whole form, its name part. */
export function formKeys(raw: string | null | undefined): string[] {
  const s = (raw ?? '').trim();
  if (!s) return [];
  const out: string[] = [];
  const bracket = BRACKETED.exec(s);
  if (bracket) out.push(bracket[1]!.toLowerCase());
  for (const m of s.matchAll(EMAIL_G)) out.push(m[0].toLowerCase());
  out.push(formKey(s));
  const namePart = s.replace(BRACKETED, ' ').replace(EMAIL_G, ' ').trim();
  if (namePart && namePart !== s) out.push(formKey(namePart));
  return [...new Set(out.filter(Boolean))];
}

export interface Resolver {
  /** The one person a surface form names, or null (unknown, or a key two people share). */
  resolve(raw: string | null | undefined): string | null;
  /**
   * The people one stored attendee entry names. A single person (a structured pair, one address, one name) by their
   * address, else by their name; a glued entry by every address and every name run — a run nobody owns whole is split
   * against the known full names plus `cover` (names that are no roster person — the linked event's attendees, the
   * transcript's speakers — but may fill a gap), and counts only when the split covers all of it.
   */
  attendee(entry: unknown, cover?: readonly string[]): string[];
}

const AMBIGUOUS = '\u0000ambiguous';
const COVER = '\u0000cover:';

/** `exact`: the store's identity index (people.ts identityKey → person) — consulted first, so nothing it resolves moves. */
export function buildResolver(people: readonly PersonLike[], exact?: ReadonlyMap<string, string>): Resolver {
  const explicit = new Map<string, string>();
  const implicit = new Map<string, string>();
  const put = (m: Map<string, string>, k: string, pid: string) => {
    if (!k) return;
    const cur = m.get(k);
    m.set(k, cur === undefined || cur === pid ? pid : AMBIGUOUS);
  };
  for (const p of people) for (const id of p.identities) put(explicit, formKey(id), p.person_id);
  for (const p of people) {
    const k = formKey(p.name);
    if (k && !explicit.has(k)) put(implicit, k, p.person_id);
  }
  // splitGlued's vocabulary: each person's name and every name-like identity (a name two people share matches neither).
  const known = people.map((p) => ({ person_id: p.person_id, names: [...new Set([p.name, ...p.identities.map((i) => i.replace(PREFIX, '').trim()).filter((i) => i && !i.includes('@'))])] }));
  const knownKeys = new Set(known.flatMap((k) => k.names.map((n) => foldTokens(n).join(' '))));

  const resolve = (raw: string | null | undefined): string | null => {
    const s = (raw ?? '').trim();
    if (!s) return null;
    const hit = exact ? resolveIdentity(s, exact) : undefined;
    if (hit) return hit;
    for (const k of formKeys(s)) {
      const pid = explicit.get(k) ?? implicit.get(k);
      if (pid && pid !== AMBIGUOUS) return pid;
    }
    return null;
  };

  // Cover names that are no roster name (one that is would turn the roster's own name ambiguous in the split).
  const coverOf = (cover: readonly string[]) => {
    const out: { person_id: string; names: string[] }[] = [];
    const seen = new Set<string>();
    for (const raw of cover) {
      for (const n of parseAttendee(raw).names) {
        const key = foldTokens(n).join(' ');
        if (!key || knownKeys.has(key) || seen.has(key)) continue;
        seen.add(key);
        out.push({ person_id: `${COVER}${out.length}`, names: [n] });
      }
    }
    return out;
  };

  const attendee = (entry: unknown, cover: readonly string[] = []): string[] => {
    const a = parseAttendee(entry);
    const out = new Set<string>();
    for (const e of a.emails) {
      const pid = resolve(e);
      if (pid) out.add(pid);
    }
    if (!a.glued) {
      // One person: their address decides; the name only when the address names nobody we know.
      if (!out.size) for (const n of a.names) {
        const pid = resolve(n);
        if (pid) out.add(pid);
      }
      return [...out];
    }
    let extra: { person_id: string; names: string[] }[] | undefined;
    for (const n of a.names) {
      const pid = resolve(n);
      if (pid) {
        out.add(pid);
        continue;
      }
      extra ??= coverOf(cover);
      const split = splitGlued(n, [...known, ...extra]);
      if (split.rest.length) continue; // a partial cover: the run stays unresolved (co-occurrence at most, never asked)
      for (const p of split.persons) if (!p.startsWith(COVER)) out.add(p);
    }
    return [...out];
  };

  return { resolve, attendee };
}

// --- calendar link and speakers ----------------------------------------------------------------------------------------

/** A recording and its calendar event start this close (and share the normalised title). */
export const LINK_WINDOW_MIN = 15;

/** The title a recording and its calendar event share: lower case, punctuation and emoji off. */
export const normTitle = (t: string | null | undefined): string => (t ?? '').toLowerCase().replace(/[^\p{L}\p{N}_]+/gu, ' ').trim();

const SPEAKER_RE = /^[ \t]*([^:\n]{2,40}):[ \t]/;

/** Distinct "Name:" speaker labels of a transcript — timestamps, URLs and long phrases never match. */
export function speakerLabels(transcript: string | null | undefined, max = 20): string[] {
  const out: string[] = [];
  for (const line of (transcript ?? '').split('\n')) {
    const label = SPEAKER_RE.exec(line)?.[1]?.trim();
    if (!label || !/\p{L}/u.test(label) || label.split(/\s+/).length > 4 || /^https?$/i.test(label) || out.includes(label)) continue;
    out.push(label);
    if (out.length >= max) break;
  }
  return out;
}

export interface CalEvent {
  title: string;
  start: string;
  /** Attendee entries as stored (gcal: addresses; msgraph: `Name <addr>`). */
  attendees: string[];
  organizer: string;
}

/** Events by normalised title — what linkedEvent searches. All-day events (a date, no time) never link. */
export function indexEvents(events: readonly CalEvent[]): Map<string, { e: CalEvent; t: number }[]> {
  const out = new Map<string, { e: CalEvent; t: number }[]>();
  for (const e of events) {
    const k = normTitle(e.title);
    const t = Date.parse(e.start);
    if (!k || !e.start.includes('T') || !Number.isFinite(t)) continue;
    out.set(k, [...(out.get(k) ?? []), { e, t }]);
  }
  return out;
}

/** The calendar event of a recording: the same normalised title, starting within ±15 min — the closest one. */
export function linkedEvent(m: { title: string; start: string }, events: ReadonlyMap<string, readonly { e: CalEvent; t: number }[]>): CalEvent | null {
  const t = Date.parse(m.start);
  if (!Number.isFinite(t)) return null;
  let best: { e: CalEvent; d: number } | null = null;
  for (const x of events.get(normTitle(m.title)) ?? []) {
    const d = Math.abs(x.t - t);
    if (d <= LINK_WINDOW_MIN * 60_000 && (!best || d < best.d)) best = { e: x.e, d };
  }
  return best?.e ?? null;
}

/**
 * The people of one recording: its attendee entries (glued runs covered by the event and the speakers), its event's
 * attendees and organiser — unless the event is a crowd — and its speakers.
 */
export function callParticipants(m: { attendees: readonly unknown[]; speakers: readonly string[] }, event: CalEvent | null, r: Resolver): string[] {
  const listed = event ? [...new Set([...event.attendees, event.organizer].filter(Boolean))] : [];
  // An all-hands or a webinar (more invitees than MASS_ATTENDEES, as the identities collector counts a crowd) says nothing
  // about who talked on this recording: none of its invitees joins — one contractor's exclusive marker would decide the
  // whole call (.95, a rung above the registry) — and its names cover no glued run.
  const fromEvent = listed.length > MASS_ATTENDEES ? [] : listed;
  const cover = [...fromEvent, ...m.speakers];
  const out = new Set<string>();
  for (const a of m.attendees) for (const p of r.attendee(a, cover)) out.add(p);
  for (const a of fromEvent) for (const p of r.attendee(a)) out.add(p);
  for (const s of m.speakers) {
    const p = r.resolve(s);
    if (p) out.add(p);
  }
  return [...out];
}

// --- loaders (read-only) -----------------------------------------------------------------------------------------------

const list = (v: unknown): unknown[] => {
  try {
    const j = JSON.parse(String(v ?? '[]')) as unknown;
    return Array.isArray(j) ? j : [];
  } catch {
    return [];
  }
};

/** Calendar events starting within [lo, hi) (UTC days), a day of margin on each side for zone offsets in stored starts. */
export function loadEvents(db: DatabaseSync, lo: string, hi: string): CalEvent[] {
  const shift = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
  return (db.prepare("SELECT title, start, attendees, organizer FROM events WHERE deleted = 0 AND start >= ? AND start < ? ORDER BY start, ref").all(shift(lo, -1), shift(hi, 1)) as Record<string, unknown>[]).map((r) => ({
    title: String(r.title ?? ''),
    start: String(r.start ?? ''),
    attendees: list(r.attendees).filter((x): x is string => typeof x === 'string'),
    organizer: String(r.organizer ?? ''),
  }));
}

/** Whom messages were addressed to: `message_people` role 'to' (DM members, mentions, mail To/Cc) — resolved at ingest. */
export function recipientsOf(db: DatabaseSync): (ref: string) => string[] {
  const stmt = db.prepare("SELECT person_id FROM message_people WHERE ref = ? AND role = 'to' ORDER BY person_id");
  return (ref) => (stmt.all(ref) as { person_id: string }[]).map((r) => r.person_id).filter(Boolean);
}
