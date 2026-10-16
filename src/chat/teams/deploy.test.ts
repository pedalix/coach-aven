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

test('an unknown driver is refused with the list of drivers', () => {
  const { out, status } = render(`${BASE}CHAT_DRIVER=irc\n`);
  assert.notEqual(status, 0);
  assert.match(out, /CHAT_DRIVER must be one of: slack, teams/);
});
