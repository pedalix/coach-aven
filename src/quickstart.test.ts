// The quickstart directory (OpenSpec quickstart): its templates load as an installation's configuration, its compose
// file publishes on loopback only and runs nothing privileged, and init.sh writes the machine's values without
// touching the person's files.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseDotenv } from 'dotenv';
import { loadProjects } from './projects.js';
import { resolveSandboxOptions } from './sandboxopts.js';
import { webConfigFrom } from './config.js';

const QS = new URL('../quickstart/', import.meta.url).pathname;

test('the templates: one unprivileged project, a link-mode web chat, local sandboxes of their own names', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aven-qs-'));
  const cfg = join(dir, 'projects.config.json');
  writeFileSync(cfg, readFileSync(join(QS, 'projects.config.example.json'), 'utf8').replace('your-org/your-repo', 'acme/shop'));
  const reg = loadProjects(cfg);
  assert.equal(reg.projects.length, 1);
  const p = reg.projects[0];
  assert.deepEqual(p.repos, ['acme/shop']);
  const opts = resolveSandboxOptions(p.sandbox);
  assert.equal(opts.privileged, false);
  assert.equal(opts.dind, false);

  const env = parseDotenv(readFileSync(join(QS, '.env.example')));
  assert.equal(env.SANDBOX_HOST, 'local');
  assert.equal(env.SANDBOX_IMAGE, undefined, 'compose sets it: the published sandbox image of the bot\'s version');
  assert.equal(env.SANDBOX_NAME_PREFIX, 'qs-');
  assert.equal(env.SANDBOX_MANAGED_BY, 'coach-aven-quickstart');
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, '', 'left to fill');
  assert.equal(env.ANTHROPIC_API_KEY, undefined, 'the key line stays commented out: exactly one credit');
  // With the values compose adds (compose.yaml), the web block is a valid link-mode one.
  const web = webConfigFrom({ ...env, WEB_PORT: '8787', WEB_BASE_URL: 'http://localhost:8787' })!;
  assert.equal(web.auth, 'link');
  assert.equal(web.bind, '0.0.0.0');
});

test('compose: loopback-only publish, no privilege, no `latest`, every value from init.sh', () => {
  const y = readFileSync(join(QS, 'compose/compose.yaml'), 'utf8');
  const body = y.split('\n').filter((l) => !l.trimStart().startsWith('#')).join('\n');
  assert.match(body, /- "127\.0\.0\.1:\$\{AVEN_WEB_PORT:\?run \.\/init\.sh first\}:/);
  assert.doesNotMatch(body, /privileged|cap_add|network_mode: host/);
  assert.doesNotMatch(body, /:latest/);
  for (const v of ['AVEN_VERSION', 'AVEN_UID', 'AVEN_GID', 'DOCKER_GID', 'AVEN_WEB_PORT']) assert.match(body, new RegExp(`\\$\\{${v}:\\?run \\./init\\.sh first\\}`), v);
  assert.match(body, /command: \["web"\]/);
  assert.match(body, /SANDBOX_IMAGE: \$\{SANDBOX_IMAGE:-ghcr\.io\/pedalix\/coach-aven-sandbox-plain:\$\{AVEN_VERSION:\?run \.\/init\.sh first\}\}/, 'one version names both images');
  assert.doesNotMatch(body, /^\s*build:/m, 'nothing is built on the machine');
  assert.match(body, /setup-token:[\s\S]*profiles: \[tools\][\s\S]*command: \["claude", "setup-token"\]/);
});

// init.sh against a stub `docker` and `git` on PATH, in a copy of the directory.
function runInit(dir: string, gitTag: string | undefined, extraEnv: Record<string, string> = {}, pullFails = false) {
  const bin = join(dir, '..', 'bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'docker'), `#!/bin/sh\ncase "$1" in pull) exit ${pullFails ? 1 : 0} ;; run) echo 991 ;; esac\n`);
  writeFileSync(join(bin, 'git'), `#!/bin/sh\ncase "$1" in describe) ${gitTag ? `echo ${gitTag}` : 'exit 128'} ;; rev-parse) echo 0123abc ;; esac\n`);
  chmodSync(join(bin, 'docker'), 0o755);
  chmodSync(join(bin, 'git'), 0o755);
  return execFileSync('sh', [join(dir, 'init.sh')], { env: { PATH: `${bin}:/usr/bin:/bin`, ...extraEnv }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}
function copy(): string {
  const root = mkdtempSync(join(tmpdir(), 'aven-qs-init-'));
  const dir = join(root, 'quickstart');
  cpSync(QS, dir, { recursive: true, filter: (src) => !/\/(\.env|projects\.config\.json|home|compose\/\.env)$/.test(src) });
  return dir;
}

test('init.sh: copies the templates once, rewrites compose/.env, keeps the person\'s files', () => {
  const dir = copy();
  runInit(dir, 'v0.44.0');
  const c = parseDotenv(readFileSync(join(dir, 'compose/.env')));
  assert.equal(c.AVEN_VERSION, 'v0.44.0');
  assert.equal(c.DOCKER_GID, '991');
  assert.equal(c.AVEN_WEB_PORT, '8787');
  assert.match(c.AVEN_UID, /^\d+$/);
  assert.equal(readFileSync(join(dir, '.env'), 'utf8'), readFileSync(join(dir, '.env.example'), 'utf8'));

  writeFileSync(join(dir, '.env'), 'GITHUB_TOKEN=mine\n');
  runInit(dir, undefined, { AVEN_WEB_PORT: '8790', SANDBOX_IMAGE: 'ghcr.io/acme/sandbox:dev' });
  assert.equal(readFileSync(join(dir, '.env'), 'utf8'), 'GITHUB_TOKEN=mine\n', 'a rerun never touches .env');
  const again = parseDotenv(readFileSync(join(dir, 'compose/.env')));
  assert.equal(again.AVEN_VERSION, 'sha-0123abc', 'off a tag: the commit\'s canary image, never latest');
  assert.equal(again.AVEN_WEB_PORT, '8790');
  assert.equal(again.SANDBOX_IMAGE, 'ghcr.io/acme/sandbox:dev', 'another sandbox image only when asked for');
  assert.equal(c.SANDBOX_IMAGE, undefined);
});

test('init.sh: an image that is not published stops it with what to check out, and compose/.env is not written', () => {
  const dir = copy();
  assert.throws(() => runInit(dir, undefined, {}, true), (e: { stderr?: string }) => /is not published/.test(e.stderr ?? '') && /git describe --tags --abbrev=0/.test(e.stderr ?? ''));
  assert.throws(() => readFileSync(join(dir, 'compose/.env')));
});
