// The quickstart directory (OpenSpec quickstart): its templates load as an installation's configuration, its compose
// file publishes on loopback only and runs nothing privileged, and `coach-aven up` writes the machine's values, asks
// only for what .env lacks (never printing it), and prints the sign-in link of the bot's current start.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
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
  writeFileSync(cfg, readFileSync(join(QS, 'projects.config.example.json'), 'utf8'));
  const reg = loadProjects(cfg);
  assert.equal(reg.projects.length, 1);
  const p = reg.projects[0];
  assert.deepEqual(p.repos, ['pedalix/coachaven-quickstart-demo'], 'the public demo repository unless the person names one');
  assert.equal(p.sandbox, undefined, 'no sandbox block: the default is the unprivileged plain container');
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
  assert.equal(env.GITHUB_TOKEN, '', 'left to fill, or not');
  assert.equal(env.GITHUB_AUTH, undefined, 'none only when the person skips the token');
  assert.equal(env.CHAT_SURFACES, undefined, 'Slack stays commented out: the web chat alone');
  // With the values compose adds (compose.yaml), the web block is a valid link-mode one.
  const web = webConfigFrom({ ...env, WEB_PORT: '8787', WEB_BASE_URL: 'http://localhost:8787' })!;
  assert.equal(web.auth, 'link');
  assert.equal(web.bind, '0.0.0.0');
});

test('compose: loopback-only publish, no privilege, no `latest`, every value from coach-aven up', () => {
  const y = readFileSync(join(QS, 'compose/compose.yaml'), 'utf8');
  const body = y.split('\n').filter((l) => !l.trimStart().startsWith('#')).join('\n');
  assert.match(body, /- "127\.0\.0\.1:\$\{AVEN_WEB_PORT:\?run \.\/coach-aven up first\}:/);
  assert.doesNotMatch(body, /privileged|cap_add|network_mode: host/);
  assert.doesNotMatch(body, /:latest/);
  for (const v of ['AVEN_VERSION', 'AVEN_UID', 'AVEN_GID', 'DOCKER_GID', 'AVEN_WEB_PORT']) assert.match(body, new RegExp(`\\$\\{${v}:\\?run \\./coach-aven up first\\}`), v);
  assert.match(body, /command: \["web"\]/);
  assert.match(body, /SANDBOX_IMAGE: \$\{SANDBOX_IMAGE:-ghcr\.io\/pedalix\/coach-aven-sandbox-plain:\$\{AVEN_VERSION:\?run \.\/coach-aven up first\}\}/, 'one version names both images');
  assert.doesNotMatch(body, /^\s*build:/m, 'nothing is built on the machine');
  assert.match(body, /setup-token:[\s\S]*profiles: \[tools\][\s\S]*command: \["claude", "setup-token"\]/);
});

// The script against a stub `docker` and `git` on PATH, in a copy of the directory. The stub's compose answers as a
// bot that has started twice: its log holds both starts' sign-in lines, and `--since` the current start only the new one.
function stubs(dir: string, gitTag: string, unpublished: boolean): string {
  const bin = join(dir, '..', 'bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'docker'), `#!/bin/sh
case "$1" in
  image) exit ${unpublished ? 1 : 0} ;;
  pull) exit ${unpublished ? 1 : 0} ;;
  run) echo 991 ;;
  inspect) echo 2026-10-31T10:00:00.5Z ;;
  compose) case "$*" in
    *" ps -q bot"*) echo c0ffee ;;
    *"logs --no-log-prefix --since 2026-10-31T10:00:00.5Z bot"*) echo 'Web chat sign-in: http://localhost:8787/login?key=new' ;;
    *" logs "*) printf '%s\\n' 'Web chat sign-in: http://localhost:8787/login?key=old' 'Web chat sign-in: http://localhost:8787/login?key=new' ;;
  esac ;;
esac
`);
  writeFileSync(join(bin, 'git'), `#!/bin/sh\ncase "$1" in describe) ${gitTag ? `echo ${gitTag}` : 'exit 128'} ;; rev-parse) echo 0123abc ;; esac\n`);
  chmodSync(join(bin, 'docker'), 0o755);
  chmodSync(join(bin, 'git'), 0o755);
  return bin;
}
// `answers` given: QS_ASK=1 with them on stdin, as a person at a terminal would type them. gitTag '' = no tag.
function run(dir: string, args: string[], o: { gitTag?: string; env?: Record<string, string>; answers?: string; unpublished?: boolean } = {}) {
  const bin = stubs(dir, o.gitTag ?? 'v0.44.0', o.unpublished ?? false);
  const r = spawnSync('sh', [join(dir, 'coach-aven'), ...args], {
    env: { PATH: `${bin}:/usr/bin:/bin`, ...(o.answers !== undefined ? { QS_ASK: '1' } : {}), ...(o.env ?? {}) },
    encoding: 'utf8',
    input: o.answers ?? '',
  });
  if (r.status !== 0) throw Object.assign(new Error(`exit ${r.status}: ${r.stderr}`), { stderr: r.stderr, stdout: r.stdout });
  return { out: r.stdout, err: r.stderr };
}
function copy(): string {
  const root = mkdtempSync(join(tmpdir(), 'aven-qs-up-'));
  const dir = join(root, 'quickstart');
  cpSync(QS, dir, { recursive: true, filter: (src) => !/\/(\.env|projects\.config\.json|home|compose\/\.env)$/.test(src) });
  return dir;
}
const envOf = (dir: string) => parseDotenv(readFileSync(join(dir, '.env')));
const reposOf = (dir: string) => JSON.parse(readFileSync(join(dir, 'projects.config.json'), 'utf8')).projects[0].repos;

test('up, first run at a terminal, Enter twice: the demo repository with no GitHub access; the token is saved, never printed', () => {
  const dir = copy();
  const r = run(dir, ['up'], { answers: 'sk-ant-oat01-secret\n\n\n' });
  const env = envOf(dir);
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, 'sk-ant-oat01-secret');
  assert.equal(env.GITHUB_AUTH, 'none');
  assert.equal(env.GITHUB_TOKEN, '');
  assert.deepEqual(reposOf(dir), ['pedalix/coachaven-quickstart-demo']);
  assert.match(r.out, /Open: http:\/\/localhost:8787\/login\?key=new\n/, 'the current start\'s link, not the earlier one');
  assert.doesNotMatch(r.out + r.err, /secret/);
  const c = parseDotenv(readFileSync(join(dir, 'compose/.env')));
  assert.deepEqual([c.AVEN_VERSION, c.DOCKER_GID, c.AVEN_WEB_PORT], ['v0.44.0', '991', '8787']);
  assert.match(c.AVEN_UID, /^\d+$/);
});

test('up, first run at a terminal: an API key, the person\'s repository and a GitHub token', () => {
  const dir = copy();
  run(dir, ['up'], { answers: 'sk-ant-api03-key\nacme/shop\nghp_token1\n' });
  const env = envOf(dir);
  assert.deepEqual([env.ANTHROPIC_API_KEY, env.CLAUDE_CODE_OAUTH_TOKEN, env.GITHUB_TOKEN, env.GITHUB_AUTH], ['sk-ant-api03-key', '', 'ghp_token1', undefined]);
  assert.deepEqual(reposOf(dir), ['acme/shop']);
});

test('up again: asks nothing, keeps .env, rewrites compose/.env from the machine; a token typed in later replaces "none"', () => {
  const dir = copy();
  run(dir, ['up'], { answers: 'sk-ant-oat01-x\n\n\n' });
  const before = readFileSync(join(dir, '.env'), 'utf8');
  run(dir, ['up'], { gitTag: '', env: { AVEN_WEB_PORT: '8790', SANDBOX_IMAGE: 'ghcr.io/acme/sandbox:dev' } });
  assert.equal(readFileSync(join(dir, '.env'), 'utf8'), before, 'nothing missing: nothing asked, nothing written');
  const c = parseDotenv(readFileSync(join(dir, 'compose/.env')));
  assert.equal(c.AVEN_VERSION, 'sha-0123abc', 'off a tag: the commit\'s canary image, never latest');
  assert.equal(c.AVEN_WEB_PORT, '8790');
  assert.equal(c.SANDBOX_IMAGE, 'ghcr.io/acme/sandbox:dev', 'another sandbox image only when asked for');

  writeFileSync(join(dir, '.env'), before.replace(/^GITHUB_TOKEN=$/m, 'GITHUB_TOKEN=ghp_later'));
  run(dir, ['up']);
  assert.deepEqual([envOf(dir).GITHUB_TOKEN, envOf(dir).GITHUB_AUTH], ['ghp_later', ''], 'the bot refuses the two together');
});

test('up without a terminal: what .env lacks is named in one line, and nothing starts', () => {
  const dir = copy();
  assert.throws(() => run(dir, ['up']), (e: { stderr?: string }) =>
    /missing in .*\.env: CLAUDE_CODE_OAUTH_TOKEN \(or ANTHROPIC_API_KEY\), GITHUB_TOKEN \(or GITHUB_AUTH=none\) — run \.\/coach-aven up in a terminal/.test(e.stderr ?? ''));
});

test('up: a repository that is not owner/repo is refused, and the next run asks again', () => {
  const dir = copy();
  assert.throws(() => run(dir, ['up'], { answers: 'sk-ant-oat01-x\nnot a repo\n' }), (e: { stderr?: string }) => /'not a repo' is not owner\/repo/.test(e.stderr ?? ''));
  run(dir, ['up'], { answers: 'acme/billing\n\n' });
  assert.deepEqual(reposOf(dir), ['acme/billing']);
});

test('up: an image that is not published stops it with what to check out, and compose/.env is not written', () => {
  const dir = copy();
  assert.throws(() => run(dir, ['up'], { gitTag: '', unpublished: true, answers: 'sk-ant-oat01-x\n\n\n' }),
    (e: { stderr?: string }) => /is not published/.test(e.stderr ?? '') && /git describe --tags --abbrev=0/.test(e.stderr ?? ''));
  assert.throws(() => readFileSync(join(dir, 'compose/.env')));
});

test('link: the running bot\'s current link; before any up, a sentence naming up', () => {
  const dir = copy();
  assert.throws(() => run(dir, ['link']), (e: { stderr?: string }) => /run \.\/coach-aven up first/.test(e.stderr ?? ''));
  run(dir, ['up'], { answers: 'sk-ant-oat01-x\n\n\n' });
  assert.equal(run(dir, ['link']).out, 'http://localhost:8787/login?key=new\n');
});
