// Host-side checkout of a project's TENANT repo (sources.tenant), pulled before every store build
// so the bot indexes the tenant's latest decisions (annotations/people.json, fragments.jsonl).
// Lives under data/<slug>/tenant — on the bot host, never in the sandbox (the sandbox has its own
// clone and is the one that COMMITS; this copy is read-only by convention: we fetch + hard reset).
//
// Auth: a GitHub token from the same helper the bot uses for repo work (github.ts), passed as a
// one-shot `http.extraHeader` config so it is never written into .git/config or a remote URL.
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { dataDir, ensureDir } from './paths.js';
import type { TenantConfig } from './types.js';

const run = promisify(execFile);

export const DEFAULT_ANNOTATIONS_PATH = 'annotations';

export function tenantDir(slug: string): string {
  return join(dataDir(slug), 'tenant');
}

/** Where people.json / fragments.jsonl are read from for this project (may not exist yet). */
export function annotationsDir(slug: string, t: TenantConfig): string {
  return join(tenantDir(slug), t.path ?? DEFAULT_ANNOTATIONS_PATH);
}

/** `-c http.https://github.com/.extraheader=AUTHORIZATION: basic …` — the token stays out of argv-visible URLs and git config. */
export function authConfigArgs(token: string | undefined): string[] {
  if (!token) return [];
  const basic = Buffer.from(`x-access-token:${token}`).toString('base64');
  return ['-c', `http.https://github.com/.extraheader=AUTHORIZATION: basic ${basic}`];
}

export function cloneArgs(t: TenantConfig, dir: string, token?: string): string[] {
  return [...authConfigArgs(token), 'clone', '--depth', '1', ...(t.ref ? ['--branch', t.ref] : []), `https://github.com/${t.repo}.git`, dir];
}

export function fetchArgs(t: TenantConfig, token?: string): string[] {
  return [...authConfigArgs(token), 'fetch', '--depth', '1', 'origin', t.ref ?? 'HEAD'];
}

export interface TenantSync {
  dir: string;
  head?: string;
  changed: boolean;
  error?: string;
}

/**
 * Clone or fast-forward the tenant checkout. Never throws: a GitHub hiccup must not stop the
 * build — the previous checkout (or none) is used and the error is reported.
 */
export async function syncTenant(slug: string, t: TenantConfig, getToken: () => Promise<string | undefined>): Promise<TenantSync> {
  const dir = tenantDir(slug);
  const git = (args: string[], cwd?: string) => run('git', args, { ...(cwd ? { cwd } : {}), timeout: 120_000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
  const head = async () => (await git(['rev-parse', 'HEAD'], dir)).stdout.trim();
  let before: string | undefined;
  try {
    const token = await getToken().catch(() => undefined);
    if (!existsSync(join(dir, '.git'))) {
      ensureDir(join(dir, '..'));
      await git(cloneArgs(t, dir, token));
      return { dir, head: await head(), changed: true };
    }
    before = await head();
    await git(fetchArgs(t, token), dir);
    await git(['reset', '--hard', 'FETCH_HEAD'], dir);
    const after = await head();
    return { dir, head: after, changed: after !== before };
  } catch (e) {
    const msg = (e instanceof Error ? e.message : String(e)).replace(/AUTHORIZATION: basic [A-Za-z0-9+/=]+/g, 'AUTHORIZATION: basic ***');
    return { dir, ...(before ? { head: before } : {}), changed: false, error: msg.slice(0, 300) };
  }
}
