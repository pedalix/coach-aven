// `orch mirror` — one-way mirrors of repos that live OUTSIDE the App's installation into it, so the bot can
// read them: the App is installed on one organization, and a project's token is minted from ONE
// installation, so a project can't mix owners. Upstream stays the source of truth.
//
// Runs from the deployer's crontab on the box (every 30 min, see docs/runtime-config.md → *Repo mirrors*;
// on a compose installation `docker compose run --rm --no-deps bot mirror`), NOT in GitHub Actions: the
// write side uses the bot's own App key, which already lives on the box — copying it into a repo's
// Actions secrets would hand out a key that can mint for every repo of the installation. Each mint here
// is scoped to ONE mirror repo with just contents + workflows write (workflows: upstream's
// .github/workflows changes must push through). The read side is a fine-grained PAT per upstream owner,
// Contents:read on that one repo only, named by `srcTokenEnv` and kept in the installation's .env.
//
// Branches + tags are force-updated from upstream; branches that exist only in the mirror (a bot's
// work branch) are left alone, and branches deleted upstream linger until removed by hand.
// Every mirror repo must have Actions DISABLED, or upstream's deploy workflows would run there.
//
// The list is data, not code: `MIRRORS_CONFIG` (a path), else mirrors.json in the installation directory
// (src/paths.ts) — the installation's ops overlay (infra/<slug>/mirrors.json, uploaded by `npm run ops --
// <slug> export`; format in src/mirrors.ts, example in infra/deploy/ops.example/mirrors.example.json). No
// file is an error: a crontab that runs this expects mirrors. The bare repos are cached between runs in
// mirrors/ beside the list, so each sync only fetches the delta.
//
// Two entry points call runMirror(): `orch mirror` (src/cli.ts) and scripts/mirror.ts, the systemd path's
// crontab caller (src/mirrors.test.ts pins that both import this function).
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createAppAuth } from '@octokit/auth-app';
import { loadConfig } from './config.js';
import { initSentry, captureError, flushSentry } from './sentry.js';
import { log } from './log.js';
import { mirrorsPath, parseMirrors, type Mirror } from './mirrors.js';
import { installDir, mirrorsCacheDir } from './paths.js';

function loadMirrors(): Mirror[] {
  const path = mirrorsPath(process.env, installDir());
  if (!existsSync(path)) throw new Error(`no mirror list at ${path} — put the installation's mirrors.json there (npm run ops -- <slug> export) or set MIRRORS_CONFIG`);
  return parseMirrors(JSON.parse(readFileSync(path, 'utf8')) as unknown, path);
}

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

/** Run every mirror once; the exit code: 0 when all went through, 1 when the list is unusable or any mirror failed. */
export async function runMirror(): Promise<number> {
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
    return 1;
  }
  const cache = mirrorsCacheDir();
  mkdirSync(cache, { recursive: true });

  let failed = 0;
  for (const m of mirrors) {
    const srcToken = process.env[m.srcTokenEnv];
    if (!srcToken) {
      // Deliberately unset (see above) is a state, not an incident: log, don't page.
      log.info(`mirror ${m.src} → ${m.dst} skipped: ${m.srcTokenEnv} not set (snapshot only)`);
      continue;
    }
    try {
      const dir = join(cache, `${m.dst.replace('/', '__')}.git`);
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
  return failed ? 1 : 0;
}
