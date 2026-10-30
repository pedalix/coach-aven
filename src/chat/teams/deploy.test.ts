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
