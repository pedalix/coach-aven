// Item mode (attribution/items.ts): the read-only half — the stream items of a window of local days as the item floor
// reads them, plus the two store-wide facts a single item does not carry (who mails how often and whom the subject
// ever answered; who writes in which container). Mirrors the bench's real-store exporter (src/lab/export.ts
// itemUnits) so the measured floor sees the same features in production:
//   messages   every message of the window, with whom it was addressed to (message_people 'to') and the authors of
//              up to three earlier messages of its thread (whom a reply answers)
//   tasks      a ticket touched in the window (its `updated`), addressed to its assignee
//   comments   each comment written in the window, `<task ref>#c<id>`, in its ticket's thread
//   meetings   each recording of the window, threaded by its call (calls.ts call_id), with its resolved people
// The text the rungs read is clipped (TEXT_MAX, as the bench measured it); keys come from the whole text, and so does
// the sender class's campaign-footer check (`body`: sender.ts bulkMarked reads the head and tail of the mail's own text,
// quoted history cut off). A ticket's own key is its tracker key field (`ownKey`), never a key its text names. Nothing
// is written.

import type { DatabaseSync } from 'node:sqlite';
import { resolveIdentity } from '../people.js';
import { isMailItem } from '../sender.js';
import { senderKey } from '../fingerprint.js';
import { itemKeys } from './items-text.js';

export type ItemType = 'message' | 'task' | 'comment' | 'meeting';

export interface ItemIn {
  ref: string; // store ref; a comment is `<task ref>#c<comment id>`
  day: string; // local day in the tenant's zone
  ts: string; // UTC instant (a ticket: its last update; a recording: its start)
  type: ItemType;
  source: string;
  container: string | null;
  thread: string | null; // messages: thread_id; tickets and comments: the ticket ref; recordings: the call id
  author: string | null; // raw author label/address
  authorPerson: string | null; // the store's resolution
  isBot: boolean; // the store's is_bot
  participants: string[]; // raw labels/addresses (a mail: sender, To…, Cc… in header order)
  toPersons: string[]; // message_people 'to'; a ticket: its assignee; a recording: meeting_people
  subject: string | null;
  text: string; // clipped to TEXT_MAX
  body: string; // the whole text
  keys: string[]; // tracker keys and URLs in the whole text (a ticket: its own key first)
  // A ticket's or comment's own key as the tracker wrote it (`SHOP-7`; an Asana gid is no key) — never one found in the
  // text: "port the fix from SHOP-7" in another tracker's ticket is a cross-reference, not its key. Absent otherwise.
  ownKey?: string | null;
  context: { author: string | null }[]; // authors of the earlier messages of the thread, oldest first (≤ 3)
  fromSubject: boolean; // authored by the subject
}

/** One mail of the store, for the one-way bulk rule: who sent it, in which thread, and whether the subject wrote it. */
export interface MailRow {
  thread: string;
  t: number;
  sender: string; // fingerprint.ts senderKey of the author
  subjectWrote: boolean;
}

/** A person who wrote in a container (or owns a ticket of a project), and since when. */
export interface MemberRow {
  container: string;
  person: string;
  t: number;
}

export interface ItemsLoad {
  items: ItemIn[]; // in time order (ts, then ref)
  mail: MailRow[];
  members: MemberRow[];
}

export const TEXT_MAX = 2000;

type Row = Record<string, unknown>;
const str = (v: unknown): string => (v == null ? '' : String(v));
const clip = (s: string, n = TEXT_MAX): string => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);
const json = (v: unknown): unknown[] => {
  try {
    const j = JSON.parse(str(v) || '[]') as unknown;
    return Array.isArray(j) ? j : [];
  } catch {
    return [];
  }
};
const plusDays = (day: string, n: number): string => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/** YYYY-MM-DD of instants in a zone, one formatter per zone (thousands of calls per build). */
export function dayIn(tz: string): (iso: string) => string {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
  return (iso) => {
    const t = Date.parse(iso);
    return Number.isFinite(t) ? f.format(new Date(t)) : '';
  };
}

/** A recorder's attendee entry as stored: the address when there is one, else the name — exactly as the bench read it. */
const attendeeRaw = (a: unknown): string => (typeof a === 'string' ? a : a && typeof a === 'object' ? str((a as Row).email) || str((a as Row).name) : '');

/** The stream items of the local days since..until (inclusive, `tz`), and the store-wide facts the floor needs. */
export function loadItems(db: DatabaseSync, w: { since: string; until: string; tz: string }, subject: string | null): ItemsLoad {
  const dayOf = dayIn(w.tz);
  // A UTC prefilter a day wider on each side; the local-day test is the real cut.
  const lo = plusDays(w.since, -1);
  const hi = plusDays(w.until, 2);
  const inWindow = (iso: string): boolean => {
    const d = dayOf(iso);
    return !!d && d >= w.since && d <= w.until;
  };
  const items: ItemIn[] = [];

  const to = new Map<string, string[]>();
  for (const r of db.prepare("SELECT mp.ref AS ref, mp.person_id AS pid FROM message_people mp JOIN messages m ON m.ref = mp.ref WHERE mp.role = 'to' AND m.deleted = 0 AND m.ts >= ? AND m.ts < ? ORDER BY mp.person_id").all(lo, hi) as Row[]) {
    to.set(str(r.ref), [...(to.get(str(r.ref)) ?? []), str(r.pid)]);
  }
  const earlier = db.prepare('SELECT author_raw FROM messages WHERE thread_id = ? AND deleted = 0 AND ts < ? ORDER BY ts DESC, ref DESC LIMIT 3');
  for (const r of db.prepare('SELECT ref, source, container, thread_id, ts, author_person, author_raw, subject, text, participants, is_bot FROM messages WHERE deleted = 0 AND ts >= ? AND ts < ? ORDER BY ts, ref').all(lo, hi) as Row[]) {
    const ts = str(r.ts);
    if (!inWindow(ts)) continue;
    const thread = str(r.thread_id);
    const body = str(r.text);
    const person = str(r.author_person);
    items.push({
      ref: str(r.ref), day: dayOf(ts), ts, type: 'message', source: str(r.source), container: str(r.container) || null, thread: thread || null,
      author: str(r.author_raw) || null, authorPerson: person || null, isBot: Number(r.is_bot) === 1,
      participants: json(r.participants).filter((x): x is string => typeof x === 'string'), toPersons: to.get(str(r.ref)) ?? [],
      subject: str(r.subject) || null, text: clip(body), body, keys: itemKeys(`${str(r.subject)}\n${body}`),
      context: (earlier.all(thread, ts) as Row[]).reverse().map((x) => ({ author: str(x.author_raw) || null })),
      fromSubject: !!subject && person === subject,
    });
  }

  // Tickets are read without an upper bound: one touched after `until` may still carry comments inside the window.
  const index = new Map((db.prepare('SELECT identity, person_id FROM identities').all() as Row[]).map((r) => [str(r.identity), str(r.person_id)]));
  for (const t of db.prepare('SELECT ref, source, key, title, assignee_raw, assignee_person, reporter_raw, reporter_person, created, updated, project, url, text, comments FROM tasks WHERE deleted = 0 AND updated >= ? ORDER BY updated, ref').all(lo) as Row[]) {
    const ref = str(t.ref);
    const title = str(t.title);
    const reporter = str(t.reporter_raw);
    const reporterPerson = str(t.reporter_person);
    // A ticket and its comments share a thread (the ticket ref) and the ticket's own key: one case, one key rung.
    const keys = (body: string) => [...new Set([...(str(t.key) ? [str(t.key)] : []), ...itemKeys(body), ...(str(t.url) ? [str(t.url)] : [])])].slice(0, 20);
    const base = { source: str(t.source), container: str(t.project) || null, thread: ref, isBot: false, subject: title || null, ownKey: str(t.key) || null };
    if (inWindow(str(t.updated))) {
      const body = `${title}\n${str(t.text)}`.trim();
      items.push({
        ...base, ref, day: dayOf(str(t.updated)), ts: str(t.updated), type: 'task', author: reporter || null, authorPerson: reporterPerson || null,
        participants: [...new Set([reporter, str(t.assignee_raw)].filter(Boolean))], toPersons: str(t.assignee_person) ? [str(t.assignee_person)] : [],
        text: clip(body), body, keys: keys(body), context: [], fromSubject: !!subject && reporterPerson === subject,
      });
    }
    // The tracker writer scrubbed comment i as `<ref>#c<id ?? i>`: the same fallback keeps comment refs stable.
    const comments = json(t.comments)
      .filter((c): c is Row => !!c && typeof c === 'object')
      .map((c, i) => ({ id: c.id != null && c.id !== '' ? str(c.id) : String(i), author: str(c.author), ts: str(c.ts), text: str(c.text) }))
      .sort((a, b) => a.ts.localeCompare(b.ts));
    comments.forEach((c, i) => {
      if (!inWindow(c.ts)) return;
      const person = c.author ? (resolveIdentity(c.author, index) ?? '') : '';
      // A comment answers the comments before it, or the ticket itself.
      const before = comments.slice(Math.max(0, i - 3), i).map((p) => ({ author: p.author || null }));
      items.push({
        ...base, ref: `${ref}#c${c.id}`, day: dayOf(c.ts), ts: c.ts, type: 'comment', author: c.author || null, authorPerson: person || null,
        participants: c.author ? [c.author] : [], toPersons: [], text: clip(c.text), body: c.text, keys: keys(c.text),
        context: before.length < 3 ? [{ author: reporter || null }, ...before] : before, fromSubject: !!subject && !!person && person === subject,
      });
    });
  }

  const mp = db.prepare('SELECT person_id FROM meeting_people WHERE ref = ? ORDER BY person_id');
  for (const m of db.prepare('SELECT ref, source, title, start, attendees, summary, call_id FROM meetings WHERE deleted = 0 AND start >= ? AND start < ? ORDER BY start, ref').all(lo, hi) as Row[]) {
    const start = str(m.start);
    if (!inWindow(start)) continue;
    const ref = str(m.ref);
    const body = `${str(m.title)}\n${str(m.summary)}`.trim();
    items.push({
      ref, day: dayOf(start), ts: start, type: 'meeting', source: str(m.source), container: null, thread: str(m.call_id) || ref, author: null, authorPerson: null, isBot: false,
      participants: json(m.attendees).map(attendeeRaw).filter((x) => x.trim()), toPersons: (mp.all(ref) as Row[]).map((x) => str(x.person_id)),
      subject: str(m.title) || null, text: clip(body), body, keys: itemKeys(body), context: [], fromSubject: false,
    });
  }
  // Ties by code unit, not locale: which item of a thread comes first must not depend on the host's locale.
  items.sort((a, b) => (Date.parse(a.ts) || 0) - (Date.parse(b.ts) || 0) || (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0));

  // Store-wide, not windowed: whether a sender is one-way and who belongs where is history, counted up to each item's day.
  // Threaded mail only: an unthreaded one (msgraph's thread is its own ref) can show no answer, so counting it would
  // make a client the subject answers in Outlook one-way the day they also write to Gmail.
  const mail: MailRow[] = [];
  for (const r of db.prepare('SELECT ref, source, container, thread_id, ts, author_raw, author_person FROM messages WHERE deleted = 0').all() as Row[]) {
    if (!isMailItem(str(r.source), str(r.container)) || !str(r.thread_id) || str(r.thread_id) === str(r.ref)) continue;
    mail.push({ thread: str(r.thread_id), t: Date.parse(str(r.ts)), sender: senderKey(str(r.author_raw)), subjectWrote: !!subject && str(r.author_person) === subject });
  }
  const members: MemberRow[] = [];
  const member = (container: string, person: string, ts: string) => {
    const t = Date.parse(ts);
    if (container && person && Number.isFinite(t)) members.push({ container, person, t });
  };
  for (const r of db.prepare("SELECT container, author_person, MIN(ts) AS ts FROM messages WHERE deleted = 0 AND is_bot = 0 AND author_person IS NOT NULL AND author_person != '' GROUP BY container, author_person").all() as Row[]) member(str(r.container), str(r.author_person), str(r.ts));
  for (const r of db.prepare('SELECT project, reporter_person, assignee_person, created FROM tasks WHERE deleted = 0').all() as Row[]) {
    member(str(r.project), str(r.reporter_person), str(r.created));
    member(str(r.project), str(r.assignee_person), str(r.created));
  }
  return { items, mail, members };
}
