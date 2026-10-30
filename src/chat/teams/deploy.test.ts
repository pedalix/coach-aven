// The deploy tooling follows the overlay's CHAT_DRIVER: absent = today's Slack unit, byte for
// byte; `teams` runs `orch teams`; an unknown driver is refused with the list.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';

const ROOT = new URL('../../../', import.meta.url).pathname;
const SLUG = `zz-deploy-test-${process.pid}`;
const OVERLAY = `${ROOT}infra/${SLUG}`;
const BASE = 'DEPLOY_HOST=h\nDEPLOY_USER=deployer\nROOT_USER=root\nREMOTE_DIR=/var/www/coach-aven\nSERVICE_NAME=coach-aven\n';

function render(deployEnv: string): { out: string; status: number } {
  writeFileSync(`${OVERLAY}/deploy.env`, deployEnv);
  try {
    return { out: execFileSync('bash', [`${ROOT}infra/deploy/deploy.sh`, SLUG, 'render-unit', '/usr/bin/node'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }), status: 0 };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; status?: number };
    return { out: `${err.stdout ?? ''}${err.stderr ?? ''}`, status: err.status ?? 1 };
  }
}

before(() => mkdirSync(OVERLAY, { recursive: true }));
after(() => rmSync(OVERLAY, { recursive: true, force: true }));

test('no CHAT_DRIVER renders the Slack unit exactly as the template with slack filled in', () => {
  const { out, status } = render(BASE);
  assert.equal(status, 0);
  const expected = readFileSync(`${ROOT}infra/deploy/coach-aven.service.tmpl`, 'utf8')
    .replaceAll('__USER__', 'deployer')
    .replaceAll('__REMOTE_DIR__', '/var/www/coach-aven')
    .replaceAll('__NODE__', '/usr/bin/node')
    .replaceAll('__SERVICE__', 'coach-aven')
    .replaceAll('__DRIVER__', 'slack');
  assert.equal(out, expected);
  assert.match(out, /^ExecStart=\/usr\/bin\/node --import tsx src\/cli\.ts slack$/m);
});

test('CHAT_DRIVER=teams runs orch teams', () => {
  const { out, status } = render(`${BASE}CHAT_DRIVER=teams\n`);
  assert.equal(status, 0);
  assert.match(out, /^ExecStart=\/usr\/bin\/node --import tsx src\/cli\.ts teams$/m);
  assert.match(out, /\(teams bot\)/);
});

test('CHAT_DRIVER=web runs orch web', () => {
  const { out, status } = render(`${BASE}CHAT_DRIVER=web\n`);
  assert.equal(status, 0);
  assert.match(out, /^ExecStart=\/usr\/bin\/node --import tsx src\/cli\.ts web$/m);
});

test('an unknown driver is refused with the list of drivers', () => {
  const { out, status } = render(`${BASE}CHAT_DRIVER=irc\n`);
  assert.notEqual(status, 0);
  assert.match(out, /CHAT_DRIVER must be one of: slack, teams, web/);
});

test('export and import carry hub.peers.json beside the projects config when present — never the private hub key', () => {
  writeFileSync(`${OVERLAY}/deploy.env`, BASE);
  const out = execFileSync('bash', [`${ROOT}infra/deploy/deploy.sh`, SLUG, 'runtime-files'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  assert.equal(out, 'required .env github-app-private-key.pem projects.config.json\noptional mirrors.json hub.peers.json\ndirs projects.d\n');
});


test('the overlay’s layout is the installation directory’s: what `runtime-files` carries is what the bot reads (installation-directory)', async () => {
  const { dotenvPath, mirrorsCacheDir, projectsConfigDefault } = await import('../../paths.js');
  const { mirrorsPath } = await import('../../mirrors.js');
  const { peersPath } = await import('../../messaging/peers.js');
  const { basename, dirname, relative } = await import('node:path');
  writeFileSync(`${OVERLAY}/deploy.env`, BASE);
  const out = execFileSync('bash', [`${ROOT}infra/deploy/deploy.sh`, SLUG, 'runtime-files'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const carried = Object.fromEntries(out.trim().split('\n').map((l) => { const [k, ...v] = l.split(' '); return [k, v]; })) as Record<'required' | 'optional' | 'dirs', string[]>;
  // What the bot reads from the installation directory, by name: .env, the projects config with the prompts
  // directory and the peers file beside it, the mirror list, and the App key under the template's name.
  const dir = '/srv/acme';
  const env = { AVEN_DIR: dir };
  const config = projectsConfigDefault(env);
  const keyLine = readFileSync(`${ROOT}infra/deploy/ops.example/.env.example`, 'utf8').match(/^GITHUB_APP_PRIVATE_KEY_PATH=(.+)$/m);
  assert.ok(keyLine, 'the template names the key file');
  const read = {
    required: [relative(dir, dotenvPath(env)), basename(keyLine[1]), relative(dir, config)],
    optional: [relative(dir, mirrorsPath({}, dir)), relative(dir, peersPath(config))],
    dirs: [relative(dir, `${dirname(config)}/projects.d`)],
  };
  assert.deepEqual(carried, read);
  // The prompts directory the loader reads beside the config (projects.ts) and the mirror cache stay inside the directory too.
  assert.match(readFileSync(`${ROOT}src/projects.ts`, 'utf8'), /join\(dirname\(path\), 'projects\.d'\)/);
  assert.equal(relative(dir, mirrorsCacheDir(env)), 'mirrors');
});

// ── the compose runtime (OpenSpec container-deploy): RUNTIME, the rendered compose file ────────────────

function renderCompose(deployEnv: string, args: string[]): { out: string; status: number } {
  writeFileSync(`${OVERLAY}/deploy.env`, deployEnv);
  try {
    return { out: execFileSync('bash', [`${ROOT}infra/deploy/deploy.sh`, SLUG, 'render-compose', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }), status: 0 };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; status?: number };
    return { out: `${err.stdout ?? ''}${err.stderr ?? ''}`, status: err.status ?? 1 };
  }
}
const COMPOSE = `${BASE}RUNTIME=compose\n`;
// The rendered file without its comment header, for what must NOT be in it.
const body = (yaml: string): string => yaml.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');
const BOX = ['1001', '1001', '/home/deployer'];
const hasDocker = (() => { try { execFileSync('docker', ['compose', 'version'], { stdio: 'ignore' }); return true; } catch { return false; } })();
// `docker compose config` accepts the rendered file (with a pin beside it, as on the box).
function composeConfigAccepts(yaml: string): void {
  if (!hasDocker) return;
  const dir = `${OVERLAY}/compose-check`;
  mkdirSync(dir, { recursive: true });
  writeFileSync(`${dir}/compose.yaml`, yaml);
  writeFileSync(`${dir}/.env`, 'AVEN_VERSION=v1.4.0\nAVEN_RELEASE=v1.4.0\n');
  execFileSync('docker', ['compose', '-f', `${dir}/compose.yaml`, 'config', '--quiet'], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
}

test('RUNTIME: absent is systemd (every existing case unchanged); docker is refused naming both values', () => {
  const { out, status } = render(`${BASE}RUNTIME=docker\n`);
  assert.notEqual(status, 0);
  assert.match(out, /RUNTIME must be systemd or compose \(got 'docker'/);
  assert.equal(render(`${BASE}RUNTIME=systemd\n`).out, render(BASE).out);
});

test('compose, Slack by default with the sandboxes on the box’s own Docker: the deployer’s user and home, the directory as AVEN_DIR and working directory, host network, the socket and its group, no ssh keys, no daemon', () => {
  const { out, status } = renderCompose(COMPOSE, [...BOX, 'local', '999']);
  assert.equal(status, 0, out);
  assert.match(out, /^name: coach-aven$/m);
  assert.match(out, /^  image: ghcr\.io\/pedalix\/coach-aven:\$\{AVEN_VERSION\}$/m);
  assert.match(out, /^  user: "1001:1001"$/m);
  assert.match(out, /^  working_dir: \/var\/www\/coach-aven$/m);
  assert.match(out, /^    AVEN_DIR: \/var\/www\/coach-aven$/m);
  assert.match(out, /^    HOME: \/home\/deployer$/m);
  assert.match(out, /^    SENTRY_RELEASE: \$\{AVEN_RELEASE\}$/m);
  assert.match(out, /^  network_mode: host$/m);
  assert.match(out, /^  init: true$/m);
  assert.match(out, /^  stop_grace_period: 90s$/m);
  assert.match(out, /^  restart: unless-stopped$/m);
  assert.match(out, /^    - \/var\/www\/coach-aven:\/var\/www\/coach-aven$/m);
  assert.match(out, /^    - \/home\/deployer\/\.config\/coach-aven:\/home\/deployer\/\.config\/coach-aven$/m);
  assert.match(out, /^    - \/etc\/passwd:\/etc\/passwd:ro$/m);
  assert.match(out, /^    - \/var\/run\/docker\.sock:\/var\/run\/docker\.sock$/m);
  assert.match(out, /^  group_add:\n    - "999"$/m);
  assert.match(out, /^    command: \["slack"\]$/m);
  assert.match(out, /^      driver: journald$/m);
  assert.doesNotMatch(body(out), /\.ssh/);
  assert.doesNotMatch(body(out), /sources-daemon/);
  assert.doesNotMatch(body(out), /\.netrc|\.credentials\.json/);
  assert.doesNotMatch(body(out), /# @/, 'no render tag survives');
  composeConfigAccepts(out);
});

test('compose, Teams with the sandboxes on another host: orch teams, the deployer’s .ssh read-only, no Docker socket', () => {
  const { out, status } = renderCompose(`${COMPOSE}CHAT_DRIVER=teams\n`, [...BOX, 'aven@sandboxes.example.com', '999']);
  assert.equal(status, 0, out);
  assert.match(out, /^    command: \["teams"\]$/m);
  assert.match(out, /^    - \/home\/deployer\/\.ssh:\/home\/deployer\/\.ssh:ro$/m);
  assert.doesNotMatch(body(out), /docker\.sock|group_add/);
  composeConfigAccepts(out);
});

test('compose with a daemon: a second container runs sources daemon on the listen address, from the same image', () => {
  const { out, status } = renderCompose(`${COMPOSE}DAEMON_LISTEN=127.0.0.1:3416\n`, [...BOX, 'local', '999']);
  assert.equal(status, 0, out);
  assert.match(out, /^  sources-daemon:\n    <<: \*aven\n    command: \["sources", "daemon", "--listen", "127\.0\.0\.1:3416"\]$/m);
  assert.match(out, /^        tag: coach-aven-sources-daemon$/m);
  composeConfigAccepts(out);
});

test('compose: the home files the code falls back to are mounted read-only only when they exist on the box', () => {
  const both = renderCompose(COMPOSE, [...BOX, 'local', '999', 'netrc,claude']);
  assert.equal(both.status, 0, both.out);
  assert.match(both.out, /^    - \/home\/deployer\/\.netrc:\/home\/deployer\/\.netrc:ro$/m);
  assert.match(both.out, /^    - \/home\/deployer\/\.claude\/\.credentials\.json:\/home\/deployer\/\.claude\/\.credentials\.json:ro$/m);
  const one = renderCompose(COMPOSE, [...BOX, 'local', '999', 'claude']);
  assert.doesNotMatch(body(one.out), /\.netrc/);
  assert.match(one.out, /\.credentials\.json/);
  const none = renderCompose(COMPOSE, [...BOX, 'local', '999']);
  assert.doesNotMatch(body(none.out), /\.netrc|\.credentials\.json/);
  composeConfigAccepts(both.out);
});

test('compose: IMAGE and SERVICE_NAME from the overlay name the image and the project', () => {
  const { out, status } = renderCompose(`${COMPOSE.replace('SERVICE_NAME=coach-aven', 'SERVICE_NAME=acme-bot')}IMAGE=ghcr.io/acme/coach-aven\n`, [...BOX, 'local', '999']);
  assert.equal(status, 0, out);
  assert.match(out, /^name: acme-bot$/m);
  assert.match(out, /^  image: ghcr\.io\/acme\/coach-aven:\$\{AVEN_VERSION\}$/m);
  assert.match(out, /^        tag: acme-bot$/m);
});
