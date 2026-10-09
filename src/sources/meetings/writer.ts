// Shared write path for the meeting pullers: where records go, the per-(provider, account)
// cursor, and the scrub-then-append step. Each provider only lists and fetches.
//
// Cursor = { seen: { <id>: <version> }, lastRunAt }. Recorders keep editing a note after the call
// (summary regenerated, transcript finalised), so "created after X" is not enough: a note is
// (re)written when its version (updated_at / modified time) differs from the one we stored. The
// map stays small — hundreds of meetings, not millions of messages.
import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { MeetingProvider, PullContext } from '../types.js';
import { scrubMeeting, type MeetingRecord } from './normalise.js';

export interface MeetingCursor {
  seen: Record<string, string>;
  lastRunAt?: string;
}

export function meetingDir(outDir: string, provider: MeetingProvider, account: string): string {
  return join(outDir, 'meetings', provider, account.replace(/[^A-Za-z0-9._@-]/g, '_'));
}

export function readMeetingCursor(dir: string): MeetingCursor {
  try {
    const c = JSON.parse(readFileSync(join(dir, 'cursor.json'), 'utf8')) as Partial<MeetingCursor>;
    return { seen: c.seen && typeof c.seen === 'object' ? c.seen : {}, ...(c.lastRunAt ? { lastRunAt: c.lastRunAt } : {}) };
  } catch {
    return { seen: {} };
  }
}

export function writeMeetingCursor(dir: string, c: MeetingCursor): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const p = join(dir, 'cursor.json');
  writeFileSync(`${p}.tmp`, `${JSON.stringify(c)}\n`, { mode: 0o600 });
  renameSync(`${p}.tmp`, p);
}

/** True when this version of the note is not in raw yet. */
export function needsFetch(c: MeetingCursor, id: string, version: string, full = false): boolean {
  return full || c.seen[id] !== version;
}

export class MeetingWriter {
  readonly file: string;
  count = 0;
  withheld = 0;
  private readonly warned = { vault: false };
  constructor(
    readonly ctx: PullContext,
    readonly dir: string,
  ) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.file = join(dir, 'meetings.jsonl');
  }
  write(m: MeetingRecord): void {
    const s = scrubMeeting(m, { log: this.ctx.log, warned: this.warned, ...(this.ctx.vault ? { vault: this.ctx.vault } : {}) });
    appendFileSync(this.file, `${JSON.stringify(s)}\n`, { mode: 0o600 });
    this.count++;
    if (s.scrub.withheld) this.withheld++;
  }
}
