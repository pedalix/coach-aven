// The `teams` config block: absent, partial (refused), full — and `orch slack` never needs it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../../config.js';

const BASE = { SNAPSHOT_IMAGE: 'img', SNAPSHOT_NAME: 'snap', CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-test', GITHUB_TOKEN: 'ghp_x' };
const TEAMS = { TEAMS_APP_ID: 'app', TEAMS_APP_PASSWORD: 'pw', TEAMS_TENANT_ID: 'tenant' };
const KEYS = [...Object.keys(BASE), ...Object.keys(TEAMS), 'TEAMS_PORT', 'TEAMS_OPERATORS', 'TEAMS_TARGETED', 'TEAMS_STATUS_MIN_MS'];

function withEnv<T>(env: Record<string, string>, fn: () => T): T {
  const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  for (const k of KEYS) delete process.env[k];
  Object.assign(process.env, env);
  try {
    return fn();
  } finally {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

test('no TEAMS_* → no teams block (a Slack installation is untouched)', () => {
  assert.equal(withEnv(BASE, () => loadConfig().teams), undefined);
});

test('a partial Teams config refuses to load, naming the missing keys', () => {
  assert.throws(() => withEnv({ ...BASE, TEAMS_APP_ID: 'app' }, () => loadConfig()), /missing TEAMS_APP_PASSWORD, TEAMS_TENANT_ID/);
});

test('the full block, with defaults and the optional knobs', () => {
  const t = withEnv({ ...BASE, ...TEAMS }, () => loadConfig().teams);
  assert.deepEqual(t, { appId: 'app', appPassword: 'pw', tenantId: 'tenant', port: 3978, statusMinMs: 2000, operators: [], targeted: false });
  const u = withEnv({ ...BASE, ...TEAMS, TEAMS_PORT: '4000', TEAMS_OPERATORS: 'a, b', TEAMS_TARGETED: '1', TEAMS_STATUS_MIN_MS: '500' }, () => loadConfig().teams);
  assert.deepEqual(u, { appId: 'app', appPassword: 'pw', tenantId: 'tenant', port: 4000, statusMinMs: 500, operators: ['a', 'b'], targeted: true });
});
