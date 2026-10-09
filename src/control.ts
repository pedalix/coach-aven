// Local control channel: the CLI asks the running bot to do something it can only do from
// inside the bot process (fire a routine needs the live Slack client and the turn engine).
//
// Why files and not a socket/HTTP port: the bot and the operator's CLI share a disk and
// nothing else needs to be listening; a request file survives a bot restart (it is consumed on
// the next boot) and needs no auth beyond filesystem permissions — the same trust as state.json.
//
// Contract: the CLI writes `<dir>/run-<routineId>.json` atomically (tmp + rename); the bot
// consumes each request at most once (rename to `.taken` before acting, then delete), so a
// watcher event and the poll fallback racing on the same file cannot fire a routine twice.

import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { dataRoot } from './sources/paths.js';

export interface RunRequest {
  id: string;
  requestedAt: string;
  by: string;
}

const NAME = /^run-([A-Za-z0-9_-]{1,64})\.json$/;

export function controlDir(): string {
  return join(dataRoot(), 'control');
}

/** `run-r3.json` → `r3`; anything else (tmp files, `.taken`, junk) → undefined. */
export function parseRequestName(name: string): string | undefined {
  return NAME.exec(name)?.[1];
}

export function requestPath(dir: string, id: string): string {
  if (!NAME.test(`run-${id}.json`)) throw new Error(`invalid routine id ${JSON.stringify(id)}`);
  return join(dir, `run-${id}.json`);
}

/** CLI side: write the request atomically and return its path. */
export function writeRunRequest(dir: string, id: string, by = 'cli', now = new Date()): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const target = requestPath(dir, id);
  const tmp = `${target}.tmp`;
  const body: RunRequest = { id, requestedAt: now.toISOString(), by };
  writeFileSync(tmp, JSON.stringify(body) + '\n', { mode: 0o600 });
  renameSync(tmp, target);
  return target;
}

/**
 * Bot side: take every pending request and hand its routine id to `handle`. Claiming is a
 * rename, so two concurrent consumers never both get the same request. Returns the ids taken.
 */
export function consumeRunRequests(dir: string, handle: (id: string) => void): string[] {
  if (!existsSync(dir)) return [];
  const taken: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const id = parseRequestName(name);
    if (!id) continue;
    const src = join(dir, name);
    const claimed = `${src}.taken`;
    try {
      renameSync(src, claimed);
    } catch {
      continue; // another consumer won the race
    }
    try {
      handle(id);
      taken.push(id);
    } finally {
      rmSync(claimed, { force: true });
    }
  }
  return taken;
}

/** CLI side: wait until the bot has consumed the request (file gone) or the timeout passes. */
export async function waitConsumed(path: string, timeoutMs = 10_000, pollMs = 200): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!existsSync(path)) return true;
    await new Promise((r) => setTimeout(r, pollMs));
  }
  return !existsSync(path);
}
