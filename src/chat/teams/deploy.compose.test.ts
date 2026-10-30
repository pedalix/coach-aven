// The compose deploy as it runs on the box (OpenSpec container-deploy, design D7): the script
// `deploy.sh <slug> remote-script deploy <version>` prints is what `deploy` sends over ssh. Here it runs
// locally against a fake `docker` and `systemctl` on PATH (and a fake `sleep`, so the 90 s wait is instant):
// the version's form and the canary rule, the refusal while the unit is active, a failed pull that writes
// nothing, the pin and the ok line when the driver's line comes, the failed line and the log's tail when
// it does not.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

const ROOT = new URL('../../../', import.meta.url).pathname;
const SLUG = `zz-compose-test-${process.pid}`;
const OVERLAY = `${ROOT}infra/${SLUG}`;
const BOX = `${OVERLAY}/box`; // stands in for the box: REMOTE_DIR and the fake tools
const DIR = `${BOX}/srv/coach-aven`;
const BIN = `${BOX}/bin`;
const CALLS = `${BOX}/calls.log`;
const deployEnv = (extra = '') => `DEPLOY_HOST=h\nDEPLOY_USER=deployer\nROOT_USER=root\nREMOTE_DIR=${DIR}\nSERVICE_NAME=zz-svc\nRUNTIME=compose\n${extra}`;

function script(args: string[]): { out: string; status: number } {
  try {
    return { out: execFileSync('bash', [`${ROOT}infra/deploy/deploy.sh`, SLUG, 'remote-script', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }), status: 0 };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; status?: number };
    return { out: `${err.stdout ?? ''}${err.stderr ?? ''}`, status: err.status ?? 1 };
  }
}

// Run the box script with the fakes: FAKE_* steer them, CALLS records every docker call in order.
function runOnBox(body: string, fake: Record<string, string>, pin?: string): { out: string; status: number } {
  rmSync(CALLS, { force: true });
  rmSync(`${DIR}/compose/.env`, { force: true });
  rmSync(`${DIR}/deploys.log`, { force: true });
  if (pin) writeFileSync(`${DIR}/compose/.env`, pin);
  const env = { ...process.env, PATH: `${BIN}:${process.env.PATH}`, ...fake };
  try {
    return { out: execFileSync('bash', ['-c', body], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }), status: 0 };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; status?: number };
    return { out: `${err.stdout ?? ''}${err.stderr ?? ''}`, status: err.status ?? 1 };
  }
}
const calls = (): string[] => (existsSync(CALLS) ? readFileSync(CALLS, 'utf8').trim().split('\n') : []);

before(() => {
  mkdirSync(`${DIR}/compose`, { recursive: true });
  mkdirSync(BIN, { recursive: true });
  writeFileSync(`${BIN}/docker`, `#!/usr/bin/env bash
echo "docker $*" >> "${CALLS}"
case "$*" in
  "pull --quiet "*) [[ "\${FAKE_PULL_FAIL:-}" == 1 ]] && { echo "Error response from daemon: manifest unknown" >&2; exit 1; }; exit 0 ;;
  "compose up -d"*) exit 0 ;;
  "compose logs --no-log-prefix --since "*) [[ "\${FAKE_HEALTHY:-}" == 1 ]] && echo "[2026-10-30 10:00:00] Slack bot running (Socket Mode) — 2 projects"; exit 0 ;;
  "compose logs --no-log-prefix --tail=30 bot") echo "the bot's last lines: boom"; exit 0 ;;
  *) exit 0 ;;
esac
`);
  writeFileSync(`${BIN}/systemctl`, `#!/usr/bin/env bash
echo "systemctl $*" >> "${CALLS}"
[[ "\${FAKE_UNIT_ACTIVE:-}" == 1 ]] && exit 0
exit 3
`);
  writeFileSync(`${BIN}/sleep`, '#!/usr/bin/env bash\nexit 0\n');
  for (const f of ['docker', 'systemctl', 'sleep']) chmodSync(`${BIN}/${f}`, 0o755);
  writeFileSync(`${OVERLAY}/deploy.env`, deployEnv('CANARY=1\n'));
});
after(() => rmSync(OVERLAY, { recursive: true, force: true }));

const SHA = 'sha-0123456789abcdef0123456789abcdef01234567';

test('a version is vX.Y.Z, or sha-<commit> on a canary; latest, a branch and a short sha are refused before anything runs', () => {
  for (const v of ['latest', 'main', 'v1.4', 'sha-0123456', '1.4.0']) {
    const r = script(['deploy', v]);
    assert.notEqual(r.status, 0, v);
    assert.match(r.out, /refusing '.*': a version is vX\.Y\.Z, or sha-<commit> \(40 hex\) on a canary/, v);
  }
  assert.equal(script(['deploy', 'v1.4.0']).status, 0);
  assert.equal(script(['deploy', SHA]).status, 0);
});

test('sha-<commit> deploys only with CANARY=1 in deploy.env', () => {
  writeFileSync(`${OVERLAY}/deploy.env`, deployEnv());
  try {
    const r = script(['deploy', SHA]);
    assert.notEqual(r.status, 0);
    assert.match(r.out, /a main commit's image deploys only on a canary installation \(CANARY=1/);
    assert.equal(script(['deploy', 'v1.4.0']).status, 0, 'a release installation takes vX.Y.Z');
  } finally {
    writeFileSync(`${OVERLAY}/deploy.env`, deployEnv('CANARY=1\n'));
  }
});

test('while the systemd unit is active the deploy refuses, names the command that stops it, and touches nothing', () => {
  const r = runOnBox(script(['deploy', 'v1.4.0']).out, { FAKE_UNIT_ACTIVE: '1' });
  assert.equal(r.status, 1);
  assert.match(r.out, /the systemd unit zz-svc\.service is active .* deploy\.sh zz-compose-test-\d+ down/);
  assert.deepEqual(calls(), ['systemctl is-active --quiet zz-svc.service']);
  assert.ok(!existsSync(`${DIR}/compose/.env`) && !existsSync(`${DIR}/deploys.log`));
});

test('a failed pull changes nothing: no pin, no up, no log line', () => {
  const r = runOnBox(script(['deploy', 'v1.4.0']).out, { FAKE_PULL_FAIL: '1' });
  assert.notEqual(r.status, 0);
  assert.match(r.out, /manifest unknown/);
  assert.deepEqual(calls(), ['systemctl is-active --quiet zz-svc.service', 'docker pull --quiet ghcr.io/pedalix/coach-aven:v1.4.0']);
  assert.ok(!existsSync(`${DIR}/compose/.env`) && !existsSync(`${DIR}/deploys.log`));
});

test('the driver’s line comes: the pin names the version and the release, up -d ran once, deploys.log ends with ok, exit 0', () => {
  const r = runOnBox(script(['deploy', SHA]).out, { FAKE_HEALTHY: '1' });
  assert.equal(r.status, 0, r.out);
  assert.equal(readFileSync(`${DIR}/compose/.env`, 'utf8'), `AVEN_VERSION=${SHA}\nAVEN_RELEASE=main@0123456\n`);
  assert.match(readFileSync(`${DIR}/deploys.log`, 'utf8'), new RegExp(`^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}Z ${SHA} ok\\n$`));
  assert.match(r.out, /✓ sha-0123456789abcdef0123456789abcdef01234567 is live \(slack\): 'Slack bot running'/);
  const c = calls();
  assert.equal(c[0], 'systemctl is-active --quiet zz-svc.service');
  assert.equal(c[1], `docker pull --quiet ghcr.io/pedalix/coach-aven:${SHA}`);
  assert.equal(c[2], 'docker compose up -d');
  assert.match(c[3], /^docker compose logs --no-log-prefix --since \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z bot$/);
  assert.equal(c.length, 4);
});

test('the line does not come: deploys.log records failed, the log’s tail is shown, exit 1 — and the earlier version is one deploy away', () => {
  const r = runOnBox(script(['deploy', 'v1.4.0']).out, {});
  assert.equal(r.status, 1);
  assert.match(readFileSync(`${DIR}/deploys.log`, 'utf8'), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z v1\.4\.0 failed\n$/);
  assert.equal(readFileSync(`${DIR}/compose/.env`, 'utf8'), 'AVEN_VERSION=v1.4.0\nAVEN_RELEASE=v1.4.0\n');
  assert.match(r.out, /the bot's last lines: boom/);
  assert.match(r.out, /✗ v1\.4\.0 did not report 'Slack bot running' in 90 s — recorded as failed .* deploy the earlier version/);
  const c = calls();
  assert.equal(c.filter((l) => l.includes('--since')).length, 45, 'the wait polls 45 times (2 s each)');
  assert.equal(c.at(-1), 'docker compose logs --no-log-prefix --tail=30 bot');
  // Teams and the web chat wait for their own lines.
  writeFileSync(`${OVERLAY}/deploy.env`, deployEnv('CANARY=1\nCHAT_DRIVER=web\n'));
  assert.match(script(['deploy', 'v1.4.0']).out, /grep -q 'Web chat running'/);
  writeFileSync(`${OVERLAY}/deploy.env`, deployEnv('CANARY=1\n'));
});

test('restart recreates the containers and waits the same way, without a pull or a log line', () => {
  const body = script(['restart']).out;
  assert.match(body, /docker compose up -d --force-recreate/);
  assert.doesNotMatch(body, /docker pull|deploys\.log/);
  const r = runOnBox(body, { FAKE_HEALTHY: '1' }, 'AVEN_VERSION=v1.4.0\nAVEN_RELEASE=v1.4.0\n');
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /up -d --force-recreate \(v1\.4\.0\)/);
  assert.match(r.out, /✓ the pinned version is live/);
  assert.ok(!existsSync(`${DIR}/deploys.log`));
});
