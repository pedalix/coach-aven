// One writer per project's data directory (OpenSpec sources-daemon): the bot's ticker, a sources
// daemon and an operator's `orch sources pull/build` all write data/<slug>/ (raw, store, replica,
// pins, the tenant checkout). Two of them at once would interleave raw appends and race the replica
// swap, so whoever ingests holds `data/<slug>/.lock` — `{pid, host, startedAt, by}` — for as long as
// it runs. A lock whose pid is gone (or that was written on another host) is stale and taken over;
// a live one refuses the second writer with its owner named.
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { dataDir, ensureDir } from './paths.js';

export interface LockInfo {
  pid: number;
  host: string;
  startedAt: string;
  /** What holds it: `daemon`, `bot`, `cli pull`, … — for the refusal message. */
  by: string;
}

export const lockPath = (slug: string): string => join(dataDir(slug), '.lock');

/** Pure: is this lock held by a live process other than us? `alive` is injectable for tests. */
export function heldByOther(info: LockInfo | undefined, self: { pid: number; host: string }, alive: (pid: number) => boolean = pidAlive): boolean {
  if (!info) return false;
  if (info.host !== self.host) return false; // another machine's lock cannot be checked — and cannot share our disk
  if (info.pid === self.pid) return false;
  return alive(info.pid);
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'; // exists, owned by someone else
  }
}

export function readLock(slug: string): LockInfo | undefined {
  const p = lockPath(slug);
  if (!existsSync(p)) return undefined;
  try {
    const v = JSON.parse(readFileSync(p, 'utf8')) as Partial<LockInfo>;
    return typeof v.pid === 'number' && typeof v.host === 'string' ? { pid: v.pid, host: v.host, startedAt: String(v.startedAt ?? ''), by: String(v.by ?? '?') } : undefined;
  } catch {
    return undefined; // a torn write is a stale lock
  }
}

export const describeLock = (l: LockInfo): string => `${l.by} (pid ${l.pid} on ${l.host}, since ${l.startedAt})`;

/** Take the lock or say who holds it. Returns `undefined` on success, the holder otherwise. */
export function acquireLock(slug: string, by: string, alive: (pid: number) => boolean = pidAlive): LockInfo | undefined {
  const self = { pid: process.pid, host: hostname() };
  const cur = readLock(slug);
  if (heldByOther(cur, self, alive)) return cur;
  if (cur && cur.pid === self.pid && cur.host === self.host) return undefined; // ours already: no rewrite every tick
  ensureDir(dataDir(slug));
  writeFileSync(lockPath(slug), JSON.stringify({ ...self, startedAt: new Date().toISOString(), by } satisfies LockInfo) + '\n', { mode: 0o600 });
  return undefined;
}

/** Release our own lock (never someone else's). */
export function releaseLock(slug: string): void {
  const cur = readLock(slug);
  if (cur && cur.pid === process.pid && cur.host === hostname()) rmSync(lockPath(slug), { force: true });
}

/** The holder when another live process ingests this project now, else undefined (the bot ticker and the CLI ask this). */
export function otherWriter(slug: string, alive: (pid: number) => boolean = pidAlive): LockInfo | undefined {
  const cur = readLock(slug);
  return heldByOther(cur, { pid: process.pid, host: hostname() }, alive) ? cur : undefined;
}
