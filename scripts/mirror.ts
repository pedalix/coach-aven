#!/usr/bin/env -S npx tsx
// One-way mirrors of studio repos that live OUTSIDE BluefinOrg into it, so the bot can read
// them: the App is installed only on BluefinOrg (+ pedalix), and a project's token is minted
// from ONE installation, so a project can't mix owners. Upstream stays the source of truth.
//
// Runs on the prod box from the deployer's crontab (every 30 min, see docs/runtime-config.md →
// *Repo mirrors*), NOT in GitHub Actions: the write side uses the bot's own App key, which already
// lives on the box — copying it into a repo's Actions secrets would hand out a key that can mint
// for every repo of both installations. Each mint here is scoped to ONE mirror repo with just
// contents + workflows write (workflows: upstream's .github/workflows changes must push through).
// The read side is a fine-grained PAT per upstream owner, Contents:read on that one repo only,
// named by `srcTokenEnv` and kept in the runtime .env.
//
// Branches + tags are force-updated from upstream; branches that exist only in the mirror (a bot's
// work branch) are left alone, and branches deleted upstream linger until removed by hand.
// Every mirror repo must have Actions DISABLED, or upstream's deploy workflows would run there.
//
// The list is data, not code: `MIRRORS_CONFIG` (a path), else ./mirrors.json — the installation's ops overlay
// (infra/<slug>/mirrors.json, uploaded by `npm run ops -- <slug> export`; format in src/mirrors.ts, example in
// infra/deploy/ops.example/mirrors.example.json). No file is an error: a crontab that runs this expects mirrors.
//
// Usage: node --import tsx scripts/mirror.ts      (from REMOTE_DIR; reads ./.env and ./mirrors.json)
import 'dotenv/config';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createAppAuth } from '@octokit/auth-app';
import { loadConfig } from '../src/config.js';
import { initSentry, captureError, flushSentry } from '../src/sentry.js';
import { log } from '../src/log.js';
import { mirrorsPath, parseMirrors, type Mirror } from '../src/mirrors.js';

function loadMirrors(): Mirror[] {
  const path = mirrorsPath(process.env, process.cwd());
  if (!existsSync(path)) throw new Error(`no mirror list at ${path} — put the installation's mirrors.json there (npm run ops -- <slug> export) or set MIRRORS_CONFIG`);
  return parseMirrors(JSON.parse(readFileSync(path, 'utf8')) as unknown, path);
}

// Bare repos are cached between runs so each sync only fetches the delta.
const CACHE = join(process.cwd(), 'mirrors');

// Pass the token as an http header through GIT_CONFIG_* env, never in the URL or argv,
// where it would show up in `ps` and in git's error messages.
function git(args: string[], cwd: string, token: string): void {
  const basic = Buffer.from(`x-access-token:${token}`).toString('base64');
  execFileSync('git', args, {
    cwd,
    stdio: ['ignore', 'ignore', 'pipe'],
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0',
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'http.extraHeader',
      GIT_CONFIG_VALUE_0: `Authorization: Basic ${basic}`,
    },
  });
}

async function mintMirrorToken(appId: string, privateKey: string, dst: string): Promise<string> {
  const [owner, name] = dst.split('/');
  const app = createAppAuth({ appId, privateKey });
  const { token: jwt } = await app({ type: 'app' });
  const res = await fetch(`https://api.github.com/repos/${owner}/${name}/installation`, {
    headers: { Authorization: `Bearer ${jwt}`, Accept: 'application/vnd.github+json' },
  });
  if (!res.ok) throw new Error(`no App installation for ${dst} (${res.status})`);
  const { id } = (await res.json()) as { id: number };
  const { token } = await app({
    type: 'installation',
    installationId: id,
    repositoryNames: [name],
    permissions: { contents: 'write', workflows: 'write', metadata: 'read' },
  });
  return token;
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  initSentry(cfg);
  if (cfg.github.kind !== 'app') throw new Error('mirror needs GitHub App auth (GITHUB_APP_ID + key)');
  const { appId, privateKey } = cfg.github;
  let mirrors: Mirror[];
  try {
    mirrors = loadMirrors();
  } catch (err) {
    log.error(`mirror: ${err instanceof Error ? err.message : String(err)}`);
    captureError(err, { mirror: 'config' });
    await flushSentry();
    process.exit(1);
  }
  mkdirSync(CACHE, { recursive: true });

  let failed = 0;
  for (const m of mirrors) {
    const srcToken = process.env[m.srcTokenEnv];
    if (!srcToken) {
      // Deliberately unset (see above) is a state, not an incident: log, don't page.
      log.info(`mirror ${m.src} → ${m.dst} skipped: ${m.srcTokenEnv} not set (snapshot only)`);
      continue;
    }
    try {
      const dir = join(CACHE, `${m.dst.replace('/', '__')}.git`);
      if (!existsSync(dir)) execFileSync('git', ['init', '-q', '--bare', dir]);
      git(['fetch', '-q', '--prune', `https://github.com/${m.src}.git`, '+refs/heads/*:refs/heads/*', '+refs/tags/*:refs/tags/*'], dir, srcToken);
      const dstToken = await mintMirrorToken(appId, privateKey, m.dst);
      git(['push', '-q', '--force', `https://github.com/${m.dst}.git`, 'refs/heads/*:refs/heads/*', 'refs/tags/*:refs/tags/*'], dir, dstToken);
      log.info(`mirror ${m.src} → ${m.dst} ok`);
    } catch (err) {
      failed++;
      // execFileSync errors carry git's stderr — no token in it (header, not URL).
      const msg = err instanceof Error ? err.message : String(err);
      log.error(`mirror ${m.src} → ${m.dst} failed: ${msg}`);
      captureError(err, { mirror: m.dst });
    }
  }
  await flushSentry();
  process.exit(failed ? 1 : 0);
}

await main();
