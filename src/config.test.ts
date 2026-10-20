import { test } from 'node:test';
import assert from 'node:assert/strict';
import { autoStopMinutesEnv, loadConfig, repoSkillsEnv, retiredEnvWarnings, sandboxDriverEnv } from './config.js';
import { ConfigError } from './sources/errors.js';

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

// ── the sandbox driver after the Daytona driver's removal (OpenSpec retire-daytona-driver) ─────────────

// Every key loadConfig's sandbox part or the retired-settings warning reads, so a developer shell that
// exports one cannot change a result (tests never load .env).
const SANDBOX_KEYS = [
  'SANDBOX_DRIVER', 'SSHDOCKER_HOST', 'SSHDOCKER_RUNTIME', 'SANDBOX_MANAGED_BY', 'SANDBOX_NAME_PREFIX', 'SANDBOX_WORK_DIR',
  'SNAPSHOT_IMAGE', 'SANDBOX_AUTOSTOP_MINUTES', 'SNAPSHOT_NAME', 'SANDBOX_CPU', 'SANDBOX_MEMORY', 'SANDBOX_DISK',
  'CLAUDE_CODE_OAUTH_TOKEN', 'GITHUB_TOKEN',
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

test('today\'s shape (D11 proof 1): an installation\'s sandbox settings load as before — same driver, host, runtime, image, work dir, prefix and idle minutes; no old default, no warning', () => {
  const env = {
    SANDBOX_DRIVER: 'ssh-docker',
    SSHDOCKER_HOST: 'aven@sandboxes.example',
    SSHDOCKER_RUNTIME: 'sysbox-runc',
    SANDBOX_MANAGED_BY: 'aven-example',
    SANDBOX_NAME_PREFIX: 'acme-proj-',
    SANDBOX_WORK_DIR: '/root/work',
    SNAPSHOT_IMAGE: 'registry.example/acme/sandbox:2026-10-01',
    SANDBOX_AUTOSTOP_MINUTES: '45',
  };
  const cfg = withEnv({ ...env, CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-test', GITHUB_TOKEN: 'ghp_x' }, () => loadConfig());
  assert.equal(cfg.sandboxDriver, 'ssh-docker');
  assert.deepEqual(cfg.sshDocker, { host: 'aven@sandboxes.example', runtime: 'sysbox-runc' });
  assert.deepEqual(cfg.snapshot, { image: 'registry.example/acme/sandbox:2026-10-01' });
  assert.deepEqual(cfg.sandbox, { autoStopMinutes: 45, workDir: '/root/work', namePrefix: 'acme-proj-' });
  assert.equal(cfg.daytonaDefault, undefined);
  assert.deepEqual(retiredEnvWarnings(env), []);
});

test('SANDBOX_DRIVER unset or empty: ssh-docker, no old default (D2); a typo stops the boot naming ssh-docker, as a one-line ConfigError (D3)', () => {
  assert.deepEqual(sandboxDriverEnv({}), { sandboxDriver: 'ssh-docker' });
  assert.deepEqual(sandboxDriverEnv({ SANDBOX_DRIVER: '' }), { sandboxDriver: 'ssh-docker' });
  assert.deepEqual(sandboxDriverEnv({ SANDBOX_DRIVER: 'ssh-docker' }), { sandboxDriver: 'ssh-docker' });
  for (const v of ['ssh-dokcer', 'kubernetes', 'Daytona']) {
    assert.throws(
      () => sandboxDriverEnv({ SANDBOX_DRIVER: v }),
      (e: Error) => e instanceof ConfigError && e.message === `SANDBOX_DRIVER must be "ssh-docker", the only sandbox driver; got "${v}"`,
      v,
    );
  }
  assert.throws(
    () => withEnv({ SANDBOX_DRIVER: 'kubernetes', SNAPSHOT_IMAGE: 'img', CLAUDE_CODE_OAUTH_TOKEN: 't', GITHUB_TOKEN: 'g' }, () => loadConfig()),
    (e: Error) => e instanceof ConfigError && /SANDBOX_DRIVER must be "ssh-docker"/.test(e.message),
    'loadConfig refuses it at boot',
  );
});

test('an old Daytona default is recorded, naming its setting, and refuses nothing here (D4): SANDBOX_DRIVER=daytona, or DAYTONA_API_URL without SANDBOX_DRIVER', () => {
  const daytona = { sandboxDriver: 'ssh-docker', daytonaDefault: 'SANDBOX_DRIVER' };
  assert.deepEqual(sandboxDriverEnv({ SANDBOX_DRIVER: 'daytona' }), daytona);
  assert.deepEqual(sandboxDriverEnv({ SANDBOX_DRIVER: 'daytona', DAYTONA_API_URL: 'https://daytona.example/api' }), daytona, 'the explicit setting is the one named');
  const byUrl = { sandboxDriver: 'ssh-docker', daytonaDefault: 'DAYTONA_API_URL' };
  assert.deepEqual(sandboxDriverEnv({ DAYTONA_API_URL: 'https://daytona.example/api' }), byUrl);
  assert.deepEqual(sandboxDriverEnv({ SANDBOX_DRIVER: '', DAYTONA_API_URL: 'https://daytona.example/api' }), byUrl, 'an empty SANDBOX_DRIVER counts as unset');
  assert.deepEqual(sandboxDriverEnv({ SANDBOX_DRIVER: 'ssh-docker', DAYTONA_API_URL: 'https://daytona.example/api' }), { sandboxDriver: 'ssh-docker' }, 'a leftover URL after the move');
  assert.deepEqual(sandboxDriverEnv({ DAYTONA_API_URL: '' }), { sandboxDriver: 'ssh-docker' }, 'an empty URL never configured Daytona');
  // The old driver could not be built without the URL, so the other keys alone never made Daytona the
  // default: they only warn (D5), and a project without a `driver` field loads.
  assert.deepEqual(
    sandboxDriverEnv({ DAYTONA_API_KEY: 'k', DAYTONA_ORGANIZATION_ID: 'o', DAYTONA_TARGET: 'eu' }),
    { sandboxDriver: 'ssh-docker' },
    'keys without the URL never made Daytona the default',
  );
  const cfg = withEnv({ DAYTONA_API_URL: 'https://daytona.example/api', SNAPSHOT_IMAGE: 'img', CLAUDE_CODE_OAUTH_TOKEN: 't', GITHUB_TOKEN: 'g' }, () => loadConfig());
  assert.equal(cfg.sandboxDriver, 'ssh-docker');
  assert.equal(cfg.daytonaDefault, 'DAYTONA_API_URL', 'loadConfig carries it to loadProjects');
});

test('retired Daytona settings (D5): one warning line naming every one with a value — each key alone, several together, DAYTONA_TARGET; SANDBOX_DRIVER=daytona asks for ssh-docker', () => {
  for (const k of ['DAYTONA_API_URL', 'DAYTONA_API_KEY', 'DAYTONA_ORGANIZATION_ID', 'DAYTONA_TARGET', 'SNAPSHOT_NAME', 'SANDBOX_CPU', 'SANDBOX_MEMORY', 'SANDBOX_DISK']) {
    assert.deepEqual(retiredEnvWarnings({ [k]: 'x' }), [`config: ${k} is retired with the Daytona sandbox driver and changes nothing — remove it`], k);
  }
  assert.deepEqual(retiredEnvWarnings({ SANDBOX_DRIVER: 'daytona' }), ['config: SANDBOX_DRIVER=daytona is retired with the Daytona sandbox driver and changes nothing — set SANDBOX_DRIVER=ssh-docker']);
  assert.deepEqual(retiredEnvWarnings({ SANDBOX_DRIVER: 'ssh-docker', SNAPSHOT_NAME: 'sandbox-snap', SANDBOX_CPU: '2', DAYTONA_API_KEY: 'k' }), [
    'config: DAYTONA_API_KEY, SNAPSHOT_NAME and SANDBOX_CPU are retired with the Daytona sandbox driver and change nothing — remove them',
  ]);
  assert.deepEqual(retiredEnvWarnings({ SANDBOX_DRIVER: 'daytona', DAYTONA_API_URL: 'u', DAYTONA_TARGET: 'eu', SANDBOX_DISK: '20' }), [
    'config: SANDBOX_DRIVER=daytona, DAYTONA_API_URL, DAYTONA_TARGET and SANDBOX_DISK are retired with the Daytona sandbox driver and change nothing — set SANDBOX_DRIVER=ssh-docker, and remove DAYTONA_API_URL, DAYTONA_TARGET and SANDBOX_DISK',
  ]);
  assert.deepEqual(retiredEnvWarnings({ DISPATCH: '1', SNAPSHOT_NAME: 's' }), [
    'config: DISPATCH is retired — agent messaging replaces it',
    'config: SNAPSHOT_NAME is retired with the Daytona sandbox driver and changes nothing — remove it',
  ], 'one line per family');
});

test('retired Daytona settings (D5): an empty value is not named, a clean environment warns nothing, and SANDBOX_AUTOSTOP_MINUTES is never named — it sets the ssh-docker idle stop', () => {
  assert.deepEqual(retiredEnvWarnings({ SANDBOX_DRIVER: 'ssh-docker', DAYTONA_API_URL: '', SNAPSHOT_NAME: '', SANDBOX_CPU: '' }), []);
  assert.deepEqual(retiredEnvWarnings({ SANDBOX_DRIVER: 'ssh-docker' }), []);
  assert.deepEqual(retiredEnvWarnings({ SANDBOX_DRIVER: 'ssh-docker', SANDBOX_AUTOSTOP_MINUTES: '45' }), []);
  assert.deepEqual(retiredEnvWarnings({ SANDBOX_AUTOSTOP_MINUTES: '45', SANDBOX_MEMORY: '4' }), [
    'config: SANDBOX_MEMORY is retired with the Daytona sandbox driver and changes nothing — remove it',
  ]);
});
