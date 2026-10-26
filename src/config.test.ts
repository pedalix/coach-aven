import { test } from 'node:test';
import assert from 'node:assert/strict';
import { autoStopMinutesEnv, loadConfig, repoSkillsEnv, retiredEnvWarnings, sandboxDriverEnv, type Config } from './config.js';

test('retired switches: DISPATCH set to 1 or true warns once at boot, and nothing else reads it (retire-agent-dispatch D4)', () => {
  for (const v of ['1', 'true']) assert.deepEqual(retiredEnvWarnings({ DISPATCH: v }), ['config: DISPATCH is retired — agent messaging replaces it']);
  for (const v of [undefined, '', '0', 'false']) assert.deepEqual(retiredEnvWarnings({ DISPATCH: v }), []);
  assert.deepEqual(retiredEnvWarnings({}), []);
});

test('REPO_SKILLS — opt-in (agent-skills, bucket 3): exactly 1 turns it on; unset or anything else keeps it off', () => {
  for (const v of ['1', ' 1 ']) assert.equal(repoSkillsEnv(v), true, v);
  for (const v of [undefined, '', '0', 'true', 'on', 'yes', 'false', '2']) assert.equal(repoSkillsEnv(v), false, String(v));
});

test('SANDBOX_AUTOSTOP_MINUTES — trimmed; unset, empty or only spaces is the default 30; 0 is never; not a number fails naming the key (sandbox-idle-stop D9)', () => {
  for (const v of [undefined, '', '   ']) assert.equal(autoStopMinutesEnv(v), 30, JSON.stringify(v));
  assert.equal(autoStopMinutesEnv(' 45 '), 45);
  assert.equal(autoStopMinutesEnv('0'), 0);
  assert.equal(autoStopMinutesEnv('-5'), -5);
  assert.throws(() => autoStopMinutesEnv('thirty'), /SANDBOX_AUTOSTOP_MINUTES must be a number, got: thirty/);
});

test('CHAT_SURFACES — the additional chat surfaces, validated against the drivers this build has (multi-driver-installation)', async () => {
  const { parseSurfaces } = await import('./chat/surfaces.js');
  assert.deepEqual(parseSurfaces(undefined), []);
  assert.deepEqual(parseSurfaces('teams'), ['teams']);
  assert.deepEqual(parseSurfaces('web'), ['web']);
  assert.throws(() => parseSurfaces('irc'), /unknown chat drivers: irc/);
});

// ── the sandbox driver after the Daytona driver's removal (OpenSpec retire-daytona-driver D3) ──────────

test('SANDBOX_DRIVER — unset, empty or ssh-docker is ssh-docker; any other value, daytona above all, stops the boot in one sentence', () => {
  for (const v of [undefined, '', 'ssh-docker']) assert.equal(sandboxDriverEnv(v), 'ssh-docker', JSON.stringify(v));
  for (const v of ['daytona', 'Daytona', 'ssh-dokcer', 'kubernetes']) {
    assert.throws(() => sandboxDriverEnv(v), { message: `SANDBOX_DRIVER=${v}: the Daytona driver was removed after v0.42.0; ssh-docker is the only sandbox driver` }, v);
  }
});

// The keys loadConfig's sandbox part reads, and those only the removed driver read: a developer shell that
// exports one must not change a result (tests never load .env).
const SANDBOX_KEYS = [
  'SANDBOX_DRIVER', 'SSHDOCKER_HOST', 'SSHDOCKER_RUNTIME', 'SANDBOX_NAME_PREFIX', 'SANDBOX_WORK_DIR', 'SNAPSHOT_IMAGE',
  'SANDBOX_AUTOSTOP_MINUTES', 'SNAPSHOT_NAME', 'SANDBOX_CPU', 'SANDBOX_MEMORY', 'SANDBOX_DISK', 'CLAUDE_CODE_OAUTH_TOKEN', 'GITHUB_TOKEN',
];
function withEnv<T>(env: Record<string, string>, fn: () => T): T {
  const keys = [...SANDBOX_KEYS, ...Object.keys(process.env).filter((k) => k.startsWith('DAYTONA_'))];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  for (const k of keys) delete process.env[k];
  Object.assign(process.env, env);
  try {
    return fn();
  } finally {
    for (const k of new Set([...keys, ...Object.keys(env)])) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

test('today\'s shape: an installation\'s sandbox settings load as before, leftover Daytona keys change nothing, and SANDBOX_DRIVER=daytona stops loadConfig', () => {
  const env = {
    SANDBOX_DRIVER: 'ssh-docker',
    SSHDOCKER_HOST: 'aven@sandboxes.example',
    SSHDOCKER_RUNTIME: 'sysbox-runc',
    SANDBOX_NAME_PREFIX: 'acme-proj-',
    SANDBOX_WORK_DIR: '/root/work',
    SNAPSHOT_IMAGE: 'registry.example/acme/sandbox:2026-10-01',
    SANDBOX_AUTOSTOP_MINUTES: '45',
    CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-test',
    GITHUB_TOKEN: 'ghp_x',
  };
  const leftovers = { DAYTONA_API_URL: 'https://daytona.example/api', DAYTONA_API_KEY: 'k', DAYTONA_TARGET: 'eu', SNAPSHOT_NAME: 'sandbox-snap', SANDBOX_CPU: '2', SANDBOX_DISK: '20' };
  const sandboxPart = (c: Config) => ({ sandboxDriver: c.sandboxDriver, sshDocker: c.sshDocker, snapshot: c.snapshot, sandbox: c.sandbox });
  const today = withEnv(env, () => sandboxPart(loadConfig()));
  assert.deepEqual(today, {
    sandboxDriver: 'ssh-docker',
    sshDocker: { host: 'aven@sandboxes.example', runtime: 'sysbox-runc' },
    snapshot: { image: 'registry.example/acme/sandbox:2026-10-01' },
    sandbox: { autoStopMinutes: 45, workDir: '/root/work', namePrefix: 'acme-proj-' },
  });
  assert.deepEqual(withEnv({ ...env, ...leftovers }, () => sandboxPart(loadConfig())), today, 'leftover keys are ignored, silently');
  assert.deepEqual(withEnv({ ...env, ...leftovers, SANDBOX_DRIVER: '' }, () => sandboxPart(loadConfig())), today, 'unset means ssh-docker, whatever DAYTONA_API_URL says');
  assert.throws(
    () => withEnv({ ...env, SANDBOX_DRIVER: 'daytona' }, () => loadConfig()),
    { message: 'SANDBOX_DRIVER=daytona: the Daytona driver was removed after v0.42.0; ssh-docker is the only sandbox driver' },
  );
});
