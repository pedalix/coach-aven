// Every identity the store has seen, with where and whether it was in a conversation with the subject — the
// collector's input. Ported from the owen-ops loader: message authors per container/thread ("with the subject" when
// the subject wrote in that thread, or in that direct chat), event attendees and organizers, meeting attendees
// (a crowd is observed but never "with the subject"), task assignees and reporters. Bot-flagged messages are left
// out: the store already knows they are not people.
import type { DatabaseSync } from 'node:sqlite';
import { foldTokens, parseAttendee, splitGlued } from './attendees.js';
import { isDirect, type Observation } from './collect.js';
import type { KnownPerson } from './match.js';

type Row = Record<string, unknown>;
const str = (v: unknown) => (v == null ? '' : String(v));

/** An event or recording with more people than this is a webinar/all-hands, not a conversation. */
export const MASS_ATTENDEES = 8;

/** DMs and small group chats: everyone in them talked with the subject. Channels need a shared thread. */
export { isDirect };

/** One identity form an attendee list yields; `glued`: the unknown remainder of a glued line (co-occurrence only). */
export interface AttendeeForm {
  raw: string;
  glued?: boolean;
}

const SEP = '\u0000';

/**
 * The full names a roster knows, one entry per person and folded form, for splitting glued runs (attendees.ts
 * splitGlued) — keyed `<person_id>\0<form>` so the split says WHICH form matched: that form is what gets observed, so the
 * collector maps it (a listed identity) or merges it as the person's own full name, never mistakes it for a stranger.
 */
export function knownForms(people: readonly KnownPerson[]): { person_id: string; names: string[] }[] {
  const out: { person_id: string; names: string[] }[] = [];
  for (const p of people) {
    const seen = new Set<string>();
    for (const form of [p.name, ...p.identities.map((i) => i.replace(/^(slack|msgraph|teams):/i, '').trim()).filter((i) => i && !i.includes('@'))]) {
      const key = foldTokens(form).join(' ');
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push({ person_id: `${p.person_id}${SEP}${form}`, names: [form] });
    }
  }
  return out;
}

/**
 * One stored attendee list → the identity forms to observe. Lists are JSON arrays of strings or {email, name}; for one
 * person the email wins (an exact key), and a name-only entry (Gemini, Wispr write an EMPTY email) is its name — it used
 * to be dropped, which lost every such invitee. An entry holding several people (attendees.ts parseAttendee `glued`:
 * Gemini's glued "Invited" chips, a line of addresses) gives every address, and its name runs split against `known`
 * (knownForms): each full name found is observed as that person's form, and what no known name covers stays one
 * `glued` form — never a question, since it may be two people or half a name.
 */
export function attendeeForms(v: unknown, known: readonly { person_id: string; names: string[] }[] = []): AttendeeForm[] {
  let list: unknown[] = [];
  if (Array.isArray(v)) list = v;
  else {
    try {
      const j = JSON.parse(str(v)) as unknown;
      list = Array.isArray(j) ? j : [];
    } catch {
      list = [];
    }
  }
  const out: AttendeeForm[] = [];
  for (const x of list) {
    const a = parseAttendee(x);
    if (!a.glued) {
      // One person: the stored string or address as before; an entry with an empty email by its name (display form).
      const legacy = typeof x === 'string' ? x.trim() : str((x as Row)?.email ?? (x as Row)?.name).trim();
      const raw = legacy || a.names[0] || a.emails[0] || '';
      if (raw) out.push({ raw });
      continue;
    }
    for (const e of a.emails) out.push({ raw: e });
    for (const run of a.names) {
      const split = splitGlued(run, known);
      for (const id of split.persons) out.push({ raw: id.slice(id.indexOf(SEP) + 1) });
      for (const rest of split.rest) out.push({ raw: rest, glued: true });
    }
  }
  return out;
}

/** The forms an attendee list yields that may be judged (attendeeForms without the glued remainders). */
export function parseAttendees(v: unknown, known: readonly { person_id: string; names: string[] }[] = []): string[] {
  return attendeeForms(v, known)
    .filter((f) => !f.glued)
    .map((f) => f.raw);
}

/** Pure: attendee observations of one event/meeting, never "with the subject" when the list is a crowd. */
export function attendeeObservations(attendees: readonly (string | AttendeeForm)[], source: string, container: string, cap = MASS_ATTENDEES): Observation[] {
  const withSubject = attendees.length <= cap;
  return attendees.map((a) => (typeof a === 'string' ? { raw: a, source, container, thread: null, withSubject } : { raw: a.raw, source, container, thread: null, withSubject, ...(a.glued ? { glued: true } : {}) }));
}

function hasTable(db: DatabaseSync, name: string): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
}

/** `people`: the tenant's roster — glued attendee lines are split against it (without it, nothing is split off). */
export function loadObservations(db: DatabaseSync, self: string, people: readonly KnownPerson[] = []): Observation[] {
  const out: Observation[] = [];
  const known = knownForms(people);
  if (hasTable(db, 'messages')) {
    const places = new Set<string>();
    for (const r of db.prepare('SELECT DISTINCT container, thread_id FROM messages WHERE author_person = ? AND deleted = 0').all(self) as Row[]) {
      places.add(str(r.container));
      places.add(str(r.thread_id));
    }
    for (const r of db.prepare("SELECT author_raw, source, container, thread_id FROM messages WHERE deleted = 0 AND is_bot = 0 AND author_raw != '' GROUP BY 1, 2, 3, 4").all() as Row[]) {
      const container = str(r.container);
      const thread = str(r.thread_id);
      out.push({ raw: str(r.author_raw), source: str(r.source), container, thread, withSubject: places.has(thread) || (isDirect(container) && places.has(container)) });
    }
  }
  if (hasTable(db, 'events')) {
    for (const r of db.prepare('SELECT source, ref, attendees, organizer FROM events WHERE deleted = 0').all() as Row[]) {
      const organizer = str(r.organizer);
      out.push(...attendeeObservations([...attendeeForms(r.attendees, known), ...(organizer ? [{ raw: organizer }] : [])], str(r.source), str(r.ref)));
    }
  }
  if (hasTable(db, 'meetings')) {
    for (const r of db.prepare('SELECT source, id, ref, attendees FROM meetings WHERE deleted = 0').all() as Row[]) {
      out.push(...attendeeObservations(attendeeForms(r.attendees, known), str(r.source) || 'meeting', str(r.id) || str(r.ref)));
    }
  }
  if (hasTable(db, 'tasks')) {
    for (const r of db.prepare('SELECT source, project, assignee_raw, reporter_raw FROM tasks WHERE deleted = 0').all() as Row[]) {
      for (const raw of [str(r.assignee_raw), str(r.reporter_raw)].filter(Boolean)) out.push({ raw, source: str(r.source), container: `${str(r.source)}:${str(r.project)}`, thread: null, withSubject: false });
    }
  }
  return out;
}
