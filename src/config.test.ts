import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { autoStopMinutesEnv, githubAuthNone, loadConfig, repoSkillsEnv, resolveCredit, retiredEnvWarnings, sandboxDriverEnv, type Config } from './config.js';

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
  'SANDBOX_DRIVER', 'SANDBOX_HOST', 'SANDBOX_DIND_RUNTIME', 'SANDBOX_NAME_PREFIX', 'SANDBOX_WORK_DIR', 'SANDBOX_IMAGE',
  'SSHDOCKER_HOST', 'SSHDOCKER_RUNTIME', 'SNAPSHOT_IMAGE',
  'SANDBOX_AUTOSTOP_MINUTES', 'SNAPSHOT_NAME', 'SANDBOX_CPU', 'SANDBOX_MEMORY', 'SANDBOX_DISK', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'GITHUB_TOKEN',
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
    SANDBOX_HOST: 'aven@sandboxes.example',
    SANDBOX_DIND_RUNTIME: 'sysbox-runc',
    SANDBOX_NAME_PREFIX: 'acme-proj-',
    SANDBOX_WORK_DIR: '/root/work',
    SANDBOX_IMAGE: 'registry.example/acme/sandbox:2026-10-01',
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

// ── the model credit (OpenSpec api-key-credit D1) ─────────────────────────────────────────────────────

const KEY = 'sk-ant-api03-test';
const TOKEN = 'sk-ant-oat01-test';
// A home directory with (or without) a developer machine's own Claude Code login.
function home(login?: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'aven-home-'));
  if (login !== undefined) {
    mkdirSync(join(dir, '.claude'));
    writeFileSync(join(dir, '.claude', '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: login } }));
  }
  return dir;
}
// Every refusal names variables and never echoes what it was given.
function refuses(env: Record<string, string>, h: string, message: RegExp): void {
  assert.throws(() => resolveCredit(env, h), (e: Error) => {
    assert.match(e.message, message);
    for (const v of Object.values(env)) if (v.trim()) assert.ok(!e.message.includes(v.trim()), 'the value is never in the message');
    return true;
  });
}

test('resolveCredit — D1\'s table: a key, a token, both, neither (with and without a ~/.claude login)', () => {
  const login = home('sk-ant-oat01-login-test');
  assert.deepEqual(resolveCredit({ ANTHROPIC_API_KEY: KEY }, login), { kind: 'api-key', value: KEY, source: 'ANTHROPIC_API_KEY' }, 'a key: the login is not read');
  assert.deepEqual(resolveCredit({ CLAUDE_CODE_OAUTH_TOKEN: TOKEN }, login), { kind: 'subscription', value: TOKEN, source: 'CLAUDE_CODE_OAUTH_TOKEN' });
  refuses({ ANTHROPIC_API_KEY: KEY, CLAUDE_CODE_OAUTH_TOKEN: TOKEN }, login, /^Both ANTHROPIC_API_KEY and CLAUDE_CODE_OAUTH_TOKEN are set: keep exactly one/);
  assert.deepEqual(resolveCredit({}, login), { kind: 'subscription', value: 'sk-ant-oat01-login-test', source: '~/.claude' });
  refuses({}, home(), /^No model credit: set ANTHROPIC_API_KEY .* or CLAUDE_CODE_OAUTH_TOKEN .*, exactly one$/);
  refuses({}, home(''), /^No model credit/); // a login file without a token is no login
});

test('resolveCredit — set means non-empty after trimming; a value is trimmed', () => {
  const none = home();
  assert.deepEqual(resolveCredit({ ANTHROPIC_API_KEY: '  ', CLAUDE_CODE_OAUTH_TOKEN: `${TOKEN}\n` }, none), { kind: 'subscription', value: TOKEN, source: 'CLAUDE_CODE_OAUTH_TOKEN' });
  assert.deepEqual(resolveCredit({ ANTHROPIC_API_KEY: ` ${KEY} `, CLAUDE_CODE_OAUTH_TOKEN: '' }, none), { kind: 'api-key', value: KEY, source: 'ANTHROPIC_API_KEY' });
  refuses({ ANTHROPIC_API_KEY: ' ', CLAUDE_CODE_OAUTH_TOKEN: '' }, none, /^No model credit/);
});

test('resolveCredit — a value in the other credit\'s variable stops the boot; an unknown prefix passes', () => {
  const none = home();
  refuses({ ANTHROPIC_API_KEY: TOKEN }, none, /^ANTHROPIC_API_KEY holds a subscription token \(sk-ant-oat…\): it belongs in CLAUDE_CODE_OAUTH_TOKEN$/);
  refuses({ CLAUDE_CODE_OAUTH_TOKEN: KEY }, none, /^CLAUDE_CODE_OAUTH_TOKEN holds an API key \(sk-ant-api…\): it belongs in ANTHROPIC_API_KEY$/);
  assert.equal(resolveCredit({ ANTHROPIC_API_KEY: 'sk-ant-future01-test' }, none).kind, 'api-key');
  assert.equal(resolveCredit({ CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-future01-test' }, none).kind, 'subscription');
});

test('loadConfig — the credit replaces the token field; a shell ANTHROPIC_API_KEY beside the token stops it', () => {
  const env = { SANDBOX_IMAGE: 'img', CLAUDE_CODE_OAUTH_TOKEN: TOKEN, GITHUB_TOKEN: 'ghp_x' };
  assert.deepEqual(withEnv(env, () => loadConfig().credit), { kind: 'subscription', value: TOKEN, source: 'CLAUDE_CODE_OAUTH_TOKEN' });
  assert.throws(() => withEnv({ ...env, ANTHROPIC_API_KEY: KEY }, () => loadConfig()), /keep exactly one/);
});

// ── the installation directory (OpenSpec installation-directory) ──────────────────────────────────────

test('AVEN_DIR — the boot line names the resolved directory, and says when it is the package root', async () => {
  const { installDirLine, dotenvSetsInstallDir } = await import('./config.js');
  const { PACKAGE_ROOT } = await import('./paths.js');
  assert.equal(installDirLine({ AVEN_DIR: '/srv/acme' }), 'installation directory: /srv/acme (AVEN_DIR)');
  assert.equal(installDirLine({}), `installation directory: ${PACKAGE_ROOT} (the package root; AVEN_DIR unset)`);
  assert.throws(() => installDirLine({ AVEN_DIR: 'state' }), /AVEN_DIR must be an absolute path/);
  assert.equal(
    dotenvSetsInstallDir('/srv/acme/.env'),
    "/srv/acme/.env sets AVEN_DIR, but the setting names where .env is read from and belongs in the service's environment (the unit, the compose file or the shell), not in .env",
  );
});

test('the SANDBOX_ names are the only ones: the retired names load nothing, a missing image names SANDBOX_IMAGE', () => {
  const base = { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-test', GITHUB_TOKEN: 'ghp_x' };
  const now = withEnv({ ...base, SANDBOX_HOST: 'aven@sandboxes.example', SANDBOX_DIND_RUNTIME: 'sysbox-runc', SANDBOX_IMAGE: 'registry.example/acme/sandbox:1' }, () => loadConfig());
  assert.deepEqual({ sshDocker: now.sshDocker, snapshot: now.snapshot }, { sshDocker: { host: 'aven@sandboxes.example', runtime: 'sysbox-runc' }, snapshot: { image: 'registry.example/acme/sandbox:1' } });
  assert.throws(() => withEnv({ ...base, SNAPSHOT_IMAGE: 'old:1' }, () => loadConfig()), /SANDBOX_IMAGE/);
  assert.equal(withEnv({ ...base, SANDBOX_IMAGE: 'i', SSHDOCKER_HOST: 'aven@old.example', SSHDOCKER_RUNTIME: 'runc' }, () => loadConfig()).sshDocker, undefined);
  assert.throws(() => withEnv({ ...base, SANDBOX_IMAGE: 'i', SANDBOX_DIND_RUNTIME: 'runc' }, () => loadConfig()), /SANDBOX_DIND_RUNTIME must be/);
});

test('GITHUB_AUTH: unset keeps the token or the App; `none` alone means no GitHub access; anything else, or none beside a credential, stops the boot', () => {
  for (const v of [undefined, '', '  ']) assert.equal(githubAuthNone({ GITHUB_AUTH: v, GITHUB_TOKEN: 'ghp_x' }), false, `${v}`);
  assert.equal(githubAuthNone({ GITHUB_AUTH: 'none' }), true);
  assert.throws(() => githubAuthNone({ GITHUB_AUTH: 'anonymous' }), /GITHUB_AUTH takes only "none"/);
  assert.throws(() => githubAuthNone({ GITHUB_AUTH: 'none', GITHUB_TOKEN: 'ghp_x' }), /keep one/);
  assert.throws(() => githubAuthNone({ GITHUB_AUTH: 'none', GITHUB_APP_ID: '1' }), /keep one/);
});
