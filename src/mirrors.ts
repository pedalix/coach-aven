// The repo-mirror list (`orch mirror`, src/mirrorjob.ts) as data: which upstream repo is mirrored into which repo of
// the App's installation, and which env var holds the upstream read token. The list names an
// installation's orgs and repos, so it lives in that installation's ops overlay (infra/<slug>/mirrors.json,
// uploaded beside .env by `npm run ops -- <slug> export`), never in this repo — see docs/runtime-config.md
// → *Repo mirrors*. Pure: parse + validate; a bad file is an error, never a silently shorter list.
import { resolve } from 'node:path';

export interface Mirror {
  /** Upstream `owner/repo` — the source of truth. */
  src: string;
  /** The mirror `owner/repo` inside the App's installation (Actions disabled). */
  dst: string;
  /** Env var with the upstream read token (fine-grained PAT, Contents:read); unset → skipped (snapshot only). */
  srcTokenEnv: string;
}

const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const ENV = /^[A-Z_][A-Z0-9_]*$/;

/**
 * `[{src, dst, srcTokenEnv, note?}]` or `{"mirrors": [...]}` → the mirrors. `note` (or any other extra key) is a
 * comment for humans — JSON has none — and is ignored.
 */
export function parseMirrors(raw: unknown, where = 'mirrors.json'): Mirror[] {
  const list = Array.isArray(raw) ? raw : raw && typeof raw === 'object' ? (raw as { mirrors?: unknown }).mirrors : undefined;
  if (!Array.isArray(list)) throw new Error(`${where}: expected an array of mirrors (or {"mirrors": [...]})`);
  const seen = new Set<string>();
  return list.map((m, i) => {
    const w = `${where}: [${i}]`;
    if (!m || typeof m !== 'object' || Array.isArray(m)) throw new Error(`${w} must be an object`);
    const r = m as Record<string, unknown>;
    for (const k of ['src', 'dst'] as const) if (typeof r[k] !== 'string' || !REPO.test(r[k] as string)) throw new Error(`${w}: "${k}" must be "owner/repo"`);
    if (typeof r.srcTokenEnv !== 'string' || !ENV.test(r.srcTokenEnv)) throw new Error(`${w}: "srcTokenEnv" must be an env var name like MIRROR_SRC_ACME`);
    if (seen.has(r.dst as string)) throw new Error(`${w}: "${r.dst as string}" is mirrored twice`);
    seen.add(r.dst as string);
    return { src: r.src as string, dst: r.dst as string, srcTokenEnv: r.srcTokenEnv };
  });
}

/**
 * Where the list is read from: `MIRRORS_CONFIG` (absolute, or relative to the installation directory), else
 * `mirrors.json` in the installation directory (`installDir()` in src/paths.ts — never the working directory).
 */
export function mirrorsPath(env: Record<string, string | undefined>, installationDir: string): string {
  return resolve(installationDir, env.MIRRORS_CONFIG || 'mirrors.json');
}
