// Stage 0 — the edges the floor reads from the dataset's frozen store, read-only (design notes/10-design.md §2.1 F3–F5):
//   - a call fragment's meeting (`meeting:<source>:<id>` ref) → its `call_id` → every recorder copy of that call, in a
//     deterministic copy order (start, recorder priority granola < wispr < gmeet, id) — production picks the kept copy
//     by rowid (no ORDER BY) and so flips ids between builds;
//   - each copy's stored attendee entries, the speaker labels of its transcript, and its calendar event (start within
//     ±15 min AND the same normalised title) — whose attendees and organiser name the call's people when the recorder
//     did not (Granola lists only the subject; Gemini glues the names);
//   - a run's recipients: `message_people role='to'` for its refs (production reads only the container's authors).
// The store is opened immutable and read-only; a dataset without one (or an unreadable one) gives no links, and every
// consumer falls back to what the unit carries.

import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { SOURCE_PRIORITY } from '../../../sources/calls.js';

export interface MeetingCopy {
  key: string; // meeting:<source>:<id> — what fragment refs carry
  ref: string; // store ref
  source: string;
  callId: string; // the store's call cluster (calls.ts); the copy's own key when the store has none
  title: string;
  start: string;
  end: string;
  t: number;
  attendees: unknown[];
  speakers: string[];
}

export interface CalEvent {
  ref: string;
  title: string;
  start: string;
  t: number;
  attendees: string[];
  organizer: string;
}

const LINK_MS = 15 * 60_000;
const SPEAKER_RE = /^[ \t]*([^:\n]{2,40}):[ \t]/;
type Row = Record<string, unknown>;
const str = (v: unknown): string => (v == null ? '' : String(v));
const json = <T>(v: unknown, fallback: T): T => {
  try {
    const j = JSON.parse(str(v)) as unknown;
    return (j ?? fallback) as T;
  } catch {
    return fallback;
  }
};

/** The normalised title a recording and its calendar event share (export.ts normTitle). */
export const normTitle = (t: string): string => (t ?? '').toLowerCase().replace(/[^\p{L}\p{N}_]+/gu, ' ').trim();

/** Distinct "Name:" speaker labels of a transcript (timestamps, URLs and long phrases never match). */
export function speakerLabels(transcript: string, max = 20): string[] {
  const out: string[] = [];
  for (const line of (transcript ?? '').split('\n')) {
    const label = SPEAKER_RE.exec(line)?.[1]?.trim();
    if (!label || !/\p{L}/u.test(label) || label.split(/\s+/).length > 4 || /^https?$/i.test(label) || out.includes(label)) continue;
    out.push(label);
    if (out.length >= max) break;
  }
  return out;
}

/** Copy order: start, recorder priority, id — so the same copy is the call's first on every build. */
export const copyOrder = (a: MeetingCopy, b: MeetingCopy): number =>
  a.t - b.t || (SOURCE_PRIORITY[a.source] ?? 9) - (SOURCE_PRIORITY[b.source] ?? 9) || a.key.localeCompare(b.key);

export class Links {
  private readonly byKey = new Map<string, MeetingCopy>();
  private readonly byCall = new Map<string, MeetingCopy[]>();
  private readonly events: CalEvent[];
  private readonly eventsByTitle = new Map<string, CalEvent[]>();
  private readonly toStmt: ReturnType<DatabaseSync['prepare']> | null;

  private constructor(private readonly db: DatabaseSync | null) {
    const meetings = db ? (db.prepare('SELECT ref, source, id, call_id, title, start, "end", attendees, transcript FROM meetings WHERE deleted = 0').all() as Row[]) : [];
    for (const r of meetings) {
      const key = `meeting:${str(r.source) || 'meeting'}:${str(r.id) || str(r.ref)}`;
      const m: MeetingCopy = {
        key,
        ref: str(r.ref),
        source: str(r.source),
        callId: str(r.call_id) || key,
        title: str(r.title),
        start: str(r.start),
        end: str(r.end),
        t: Date.parse(str(r.start)),
        attendees: json<unknown[]>(r.attendees, []),
        speakers: speakerLabels(str(r.transcript)),
      };
      this.byKey.set(key, m);
      this.byCall.set(m.callId, [...(this.byCall.get(m.callId) ?? []), m]);
    }
    for (const list of this.byCall.values()) list.sort(copyOrder);
    const evs = db ? (db.prepare("SELECT ref, title, start, attendees, organizer FROM events WHERE deleted = 0 AND start != ''").all() as Row[]) : [];
    this.events = evs
      .map((r) => ({ ref: str(r.ref), title: str(r.title), start: str(r.start), t: Date.parse(str(r.start)), attendees: json<unknown[]>(r.attendees, []).filter((x): x is string => typeof x === 'string'), organizer: str(r.organizer) }))
      .filter((e) => Number.isFinite(e.t));
    for (const e of this.events) {
      const k = normTitle(e.title);
      if (k) this.eventsByTitle.set(k, [...(this.eventsByTitle.get(k) ?? []), e]);
    }
    this.toStmt = db ? db.prepare("SELECT DISTINCT person_id FROM message_people WHERE role = 'to' AND ref = ?") : null;
  }

  /** The dataset's store, read-only; links with no store behind them when it is missing or unreadable. */
  static open(storePath: string, log?: (m: string) => void): Links {
    if (!existsSync(storePath)) return new Links(null);
    try {
      return new Links(new DatabaseSync(`file:${storePath}?immutable=1`, { readOnly: true }));
    } catch (err) {
      log?.(`stage0: store ${storePath} unreadable (${err instanceof Error ? err.message : String(err)}); no links`);
      return new Links(null);
    }
  }

  static empty(): Links {
    return new Links(null);
  }

  get live(): boolean {
    return this.db !== null;
  }

  meeting(key: string): MeetingCopy | undefined {
    return this.byKey.get(key);
  }

  /** Every recorder copy of a call, in copy order. */
  copies(callId: string): MeetingCopy[] {
    return this.byCall.get(callId) ?? [];
  }

  /** The calendar event of a recording: the same normalised title, starting within ±15 min (the closest one). */
  linkedEvent(m: MeetingCopy): CalEvent | null {
    const k = normTitle(m.title);
    if (!k || !Number.isFinite(m.t)) return null;
    let best: CalEvent | null = null;
    for (const e of this.eventsByTitle.get(k) ?? []) if (Math.abs(e.t - m.t) <= LINK_MS && (!best || Math.abs(e.t - m.t) < Math.abs(best.t - m.t))) best = e;
    return best;
  }

  /** Persons a set of messages was addressed to (`message_people role='to'`). */
  recipients(refs: readonly string[]): string[] {
    if (!this.toStmt) return [];
    const out = new Set<string>();
    for (const ref of refs) for (const r of this.toStmt.all(ref) as Row[]) out.add(str(r.person_id));
    return [...out].filter(Boolean);
  }
}
