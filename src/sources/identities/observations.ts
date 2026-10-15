// Every identity the store has seen, with where and whether it was in a conversation with the subject — the
// collector's input. Ported from the owen-ops loader: message authors per container/thread ("with the subject" when
// the subject wrote in that thread, or in that direct chat), event attendees and organizers, meeting attendees
// (a crowd is observed but never "with the subject"), task assignees and reporters. Bot-flagged messages are left
// out: the store already knows they are not people.
import type { DatabaseSync } from 'node:sqlite';
import type { Observation } from './collect.js';

type Row = Record<string, unknown>;
const str = (v: unknown) => (v == null ? '' : String(v));

/** An event or recording with more people than this is a webinar/all-hands, not a conversation. */
export const MASS_ATTENDEES = 8;

/** DMs and small group chats: everyone in them talked with the subject. Channels need a shared thread. */
export const isDirect = (container: string) => /^(dm:|mpdm|chat:)/i.test(container);

/**
 * Attendee lists are JSON arrays of strings or {email, name}; the email wins (an exact key). An entry whose email is
 * present but empty is dropped, as the tenant collector did: recorders that fill names only (Gemini) glue several
 * attendees into one name ("ana berg rui rosa"), which would become junk questions.
 */
export function parseAttendees(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => (typeof x === 'string' ? x : str((x as Row)?.email ?? (x as Row)?.name))).filter(Boolean);
  try {
    const j = JSON.parse(str(v));
    return Array.isArray(j) ? parseAttendees(j) : [];
  } catch {
    return [];
  }
}

/** Pure: attendee observations of one event/meeting, never "with the subject" when the list is a crowd. */
export function attendeeObservations(attendees: string[], source: string, container: string, cap = MASS_ATTENDEES): Observation[] {
  const withSubject = attendees.length <= cap;
  return attendees.map((raw) => ({ raw, source, container, thread: null, withSubject }));
}

function hasTable(db: DatabaseSync, name: string): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
}

export function loadObservations(db: DatabaseSync, self: string): Observation[] {
  const out: Observation[] = [];
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
      out.push(...attendeeObservations([...parseAttendees(r.attendees), str(r.organizer)].filter(Boolean), str(r.source), str(r.ref)));
    }
  }
  if (hasTable(db, 'meetings')) {
    for (const r of db.prepare('SELECT source, id, ref, attendees FROM meetings WHERE deleted = 0').all() as Row[]) {
      out.push(...attendeeObservations(parseAttendees(r.attendees), str(r.source) || 'meeting', str(r.id) || str(r.ref)));
    }
  }
  if (hasTable(db, 'tasks')) {
    for (const r of db.prepare('SELECT source, project, assignee_raw, reporter_raw FROM tasks WHERE deleted = 0').all() as Row[]) {
      for (const raw of [str(r.assignee_raw), str(r.reporter_raw)].filter(Boolean)) out.push({ raw, source: str(r.source), container: `${str(r.source)}:${str(r.project)}`, thread: null, withSubject: false });
    }
  }
  return out;
}
