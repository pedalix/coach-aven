// Where source data lives on the BOT HOST. One directory per project under the installation
// directory (src/paths.ts), beside facts/, memory/ and drafts/ (all gitignored, all mode 700):
//
//   data/<slug>/raw/<kind>/…        append-only JSONL from the pullers, scrubbed at write
//   data/<slug>/vault/*.json.age    carrier bodies + raw secrets, encrypted to the operator's age key
//   data/<slug>/store.sqlite        (PR-B) built incrementally from raw/
//   data/<slug>/replica/            (PR-B) the ONLY thing mounted read-only into the sandbox
//
// Tokens are deliberately NOT here (see tokens.ts): data/ is per-tenant state a purge may wipe;
// OAuth grants outlive any one tenant's data and must never travel with an export.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { SLUG_RE } from './types.js';
import { dataRootDefault } from '../paths.js';

/** `data/` in the installation directory; `AVEN_DATA_DIR` (absolute, or relative to that directory) overrides it. */
export function dataRoot(): string {
  // Absolute always: the replica path becomes a `-v` mount source, and the mount parser
  // (rightly) refuses relative paths — settingPath() resolves, never against the working directory.
  return dataRootDefault();
}

export function assertSlug(slug: string): string {
  if (!SLUG_RE.test(slug)) throw new Error(`invalid project slug ${JSON.stringify(slug)} (expected ${SLUG_RE})`);
  return slug;
}

export function dataDir(slug: string): string {
  return join(dataRoot(), assertSlug(slug));
}
export function rawDir(slug: string): string {
  return join(dataDir(slug), 'raw');
}
export function vaultDir(slug: string): string {
  return join(dataDir(slug), 'vault');
}
/** The live store the build writes (WAL) — never mounted. */
export function storePath(slug: string): string {
  return join(dataDir(slug), 'store.sqlite');
}
/** The directory the sandbox mounts read-only; `store.sqlite` inside is swapped atomically. */
export function replicaDir(slug: string): string {
  return join(dataDir(slug), 'replica');
}

/** mkdir -p with owner-only permissions; the bot runs as one user and nothing else should read this. */
export function ensureDir(dir: string): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}
