// Shared pull plumbing for the tracker connectors: where tasks go, the per-account cursor, and
// the run loop that turns "fetch tasks updated since X" into an append-only, scrubbed JSONL
// file + a PullSummary. Each connector supplies only `fetchUpdated(since)` and its token check.
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PullContext, PullSummary, TrackerKind } from '../types.js';
import { TrackerHttpError } from './http.js';
import { scrubTask, type TaskRecord } from './task.js';

/** Re-read this much before the cursor: tracker `updated` clocks and JQL minute granularity overlap. */
export const CURSOR_OVERLAP_MS = 5 * 60_000;
/** First-pull horizon when the config gives no `since`. */
export const DEFAULT_SINCE_DAYS = 90;

export interface TrackerCursor {
  /** Max `updated` seen (ISO); the next pull asks for updated >= this − overlap. */
  updated?: string;
  lastRunAt?: string;
  /**
   * id → sha256 of the scrubbed JSON line last appended, for exactly the ids the last successful
   * pass returned. The cursor is INCLUSIVE (`updated >= max(updated)`, minute-granular in Jira),
   * so the rows sitting at the cursor come back every pass for ever — with overlap 0 just the
   * same. Byte-identical lines are not appended again (the store deduped them anyway; raw grew
   * ~5 MB/day). Bounded by construction: only the ids of one pass.
   */
  hashes?: Record<string, string>;
}

/** The store's idempotency key for a raw line (raw_records.line_hash) — same function, same bytes. */
export const lineHash = (line: string): string => createHash('sha256').update(line).digest('hex');

export function accountDir(outDir: string, kind: TrackerKind, account: string): string {
  const safe = account.replace(/[^A-Za-z0-9._@-]/g, '_');
  return join(outDir, kind, safe);
}

export function readCursor(dir: string): TrackerCursor {
  try {
    return JSON.parse(readFileSync(join(dir, 'cursor.json'), 'utf8')) as TrackerCursor;
  } catch {
    return {};
  }
}

export function writeCursor(dir: string, c: TrackerCursor): void {
  const p = join(dir, 'cursor.json');
  writeFileSync(`${p}.tmp`, `${JSON.stringify(c, null, 2)}\n`, { mode: 0o600 });
  renameSync(`${p}.tmp`, p);
}

/** Where the next pull starts: cursor − overlap, else config since, else 90 days back. */
export function startFrom(c: TrackerCursor, since: string | undefined, now: Date, full = false): Date {
  if (!full && c.updated) return new Date(Date.parse(c.updated) - CURSOR_OVERLAP_MS);
  if (since) return new Date(`${since}T00:00:00Z`);
  return new Date(now.getTime() - DEFAULT_SINCE_DAYS * 86_400_000);
}

export interface TrackerRun {
  kind: TrackerKind;
  account: string;
  since?: string;
  full?: boolean;
  /** Yields normalised (unscrubbed) tasks updated at/after `from`, any order. */
  fetchUpdated: (from: Date, log: (l: string) => void) => AsyncIterable<TaskRecord>;
  now?: () => Date;
}

export async function runTrackerPull(ctx: PullContext, run: TrackerRun): Promise<PullSummary> {
  const now = run.now ?? (() => new Date());
  const startedAt = now().toISOString();
  const counts: Record<string, number> = {};
  const errors: string[] = [];
  let reauth = false;
  const dir = accountDir(ctx.outDir, run.kind, run.account);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const cursor = readCursor(dir);
  const from = startFrom(cursor, run.since, now(), run.full);
  const file = join(dir, 'tasks.jsonl');
  const warned = { vault: false };
  let maxUpdated = cursor.updated ?? '';
  let n = 0;
  let withheld = 0;
  let unchanged = 0;
  const prevHashes = cursor.hashes ?? {};
  const hashes: Record<string, string> = {};
  try {
    ctx.log(`${run.account}: tasks updated since ${from.toISOString()}`);
    for await (const t of run.fetchUpdated(from, ctx.log)) {
      const s = scrubTask(t, { log: ctx.log, warned, ...(ctx.vault ? { vault: ctx.vault } : {}) });
      const line = JSON.stringify(s);
      const hash = lineHash(line);
      hashes[s.id] = hash;
      if (s.updated > maxUpdated) maxUpdated = s.updated;
      // Same bytes as the last pass appended for this id → the archive already has it.
      if (prevHashes[s.id] === hash) {
        unchanged++;
        continue;
      }
      appendFileSync(file, `${line}\n`, { mode: 0o600 });
      n++;
      if (s.scrub.withheld) withheld++;
    }
    // Advance only after the whole page set landed: a crash mid-way re-reads (the store dedupes).
    // Cursor and hash map move together — a failed pass leaves both untouched.
    writeCursor(dir, { ...(maxUpdated ? { updated: maxUpdated } : {}), lastRunAt: now().toISOString(), hashes });
  } catch (e) {
    if (e instanceof TrackerHttpError && e.reauth) reauth = true;
    errors.push(`${run.account}: ${e instanceof Error ? e.message : String(e)}`);
  }
  counts[`${run.account}/tasks`] = n;
  ctx.log(`${run.account}: ${n} tasks${unchanged ? ` (${unchanged} unchanged, not re-appended)` : ''}${withheld ? ` (${withheld} with withheld bodies)` : ''}${errors.length ? ' — FAILED' : ''}`);
  return { kind: run.kind, ok: errors.length === 0, reauth, counts, errors, startedAt, finishedAt: now().toISOString() };
}

/** Token files for trackers are tiny JSON blobs; written 600 in a 700 dir like every other source. */
export function readTokenFile<T>(path: string): T | undefined {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

export function writeTokenFile(path: string, value: unknown): void {
  mkdirSync(join(path, '..'), { recursive: true, mode: 0o700 });
  writeFileSync(`${path}.tmp`, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(`${path}.tmp`, path);
}
