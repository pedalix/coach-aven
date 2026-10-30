import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CC_TOKEN_ENV, ccCreditEnv, composerAuthScript, repoSkillDirs, seedClaudeAuth, seedGatewayAuth, seedGitHubAuth, skillOrigins } from './project.js';
import type { Config } from './config.js';
import type { SandboxHandle } from './driver.js';

test('composerAuthScript — http-basic + x-access-token (the only form GitHub accepts for ghs_ tokens), token read from file, per-checkout guard', () => {
  const s = composerAuthScript(['/w/p/admin', '/w/p/frontend']);
  assert.ok(s.includes('"http-basic"'));
  assert.ok(s.includes('"username":"x-access-token"'));
  assert.ok(!s.includes('github-oauth'));
  assert.ok(s.includes('$(cat /root/.gh-token)')); // never inlined by the orchestrator
  assert.ok(s.includes('if [ -f /w/p/admin/composer.json ]'));
  assert.ok(s.includes('if [ -f /w/p/frontend/composer.json ]'));
  assert.ok(s.includes('else rm -f /w/p/frontend/auth.json')); // stale file from the PAT era goes away
  assert.ok(s.includes('/w/p/admin-wt/*/')); // existing worktree copies are refreshed
  assert.ok(s.includes('.git/info/exclude'));
  assert.ok(s.endsWith('; true'));
});

test('seedGatewayAuth: writes the helper + a 600 token file per gateway entry; skips others', async () => {
  const uploads: Record<string, string> = {};
  const execs: string[] = [];
  const sandbox = {
    uploadFile: async (b: Buffer, p: string) => void (uploads[p] = b.toString()),
    exec: async (c: string) => (execs.push(c), { exitCode: 0, result: '' }),
  } as unknown as SandboxHandle;
  const asked: unknown[] = [];
  await seedGatewayAuth(
    sandbox,
    'caldora',
    [
      { name: 'gw', url: 'https://engine.example.com/gw/caldora/mcp', auth: 'gateway-m2m' },
      { name: 'grafana', url: 'https://observe.example.com/mcp' },
    ],
    { get: async (slug, target) => (asked.push([slug, target]), 'TOKEN') },
  );
  // An entry without `oauth` asks with its url and nothing else — the registry's Auth0 path.
  assert.deepEqual(asked, [['caldora', { url: 'https://engine.example.com/gw/caldora/mcp' }]]);
  assert.equal(uploads['/root/.aven/gw-token-gw'], 'TOKEN');
  assert.ok(uploads['/root/.aven/gw-headers.sh'].startsWith('#!/bin/sh'));
  assert.ok(execs.some((c) => c === 'chmod 600 /root/.aven/gw-token-gw'));
  assert.ok(!Object.keys(uploads).some((p) => p.includes('grafana')));
});

test('seedGatewayAuth: an oauth entry hands its request to the registry; the token file is the same', async () => {
  const uploads: Record<string, string> = {};
  const sandbox = {
    uploadFile: async (b: Buffer, p: string) => void (uploads[p] = b.toString()),
    exec: async () => ({ exitCode: 0, result: '' }),
  } as unknown as SandboxHandle;
  const asked: unknown[] = [];
  const oauth = { tokenUrl: 'https://idp.example/oauth2/token', scope: 'gw-caldora/bot' };
  await seedGatewayAuth(
    sandbox,
    'caldora',
    [{ name: 'gw', url: 'http://gw.internal.example:4600/gw/caldora/mcp', auth: 'gateway-m2m', oauth }],
    { get: async (slug, target) => (asked.push([slug, target]), 'COGNITO-TOKEN') },
  );
  assert.deepEqual(asked, [['caldora', { url: 'http://gw.internal.example:4600/gw/caldora/mcp', oauth }]]);
  assert.equal(uploads['/root/.aven/gw-token-gw'], 'COGNITO-TOKEN');
});

test('seedGatewayAuth: a mint failure does not throw (the turn goes on without gateway tools)', async () => {
  const sandbox = {
    uploadFile: async () => {},
    exec: async () => ({ exitCode: 0, result: '' }),
  } as unknown as SandboxHandle;
  await seedGatewayAuth(sandbox, 'caldora', [{ name: 'gw', url: 'https://x', auth: 'gateway-m2m' }], {
    get: async () => {
      throw new Error('auth0 down');
    },
  });
});

test('seedGatewayAuth: no gateway entry → touches nothing', async () => {
  let touched = false;
  const sandbox = {
    uploadFile: async () => void (touched = true),
    exec: async () => ((touched = true), { exitCode: 0, result: '' }),
  } as unknown as SandboxHandle;
  await seedGatewayAuth(sandbox, 'lumora', [{ name: 'grafana', url: 'https://observe.example.com/mcp' }]);
  assert.equal(touched, false);
});

// A sandbox whose `gh auth login` answers per call (exit codes in order; the last repeats);
// every other exec succeeds. `check: true` throws like the real drivers do.
function ghSandbox(codes: number[], output = 'error validating token: Get "https://api.github.com/": EOF') {
  const execs: { cmd: string; check?: boolean }[] = [];
  let n = 0;
  const sandbox = {
    uploadFile: async () => {},
    exec: async (cmd: string, opts: { check?: boolean } = {}) => {
      execs.push({ cmd, check: opts.check });
      if (!cmd.startsWith('gh auth login')) return { exitCode: 0, result: '' };
      const code = codes[Math.min(n++, codes.length - 1)]!;
      if (code !== 0 && opts.check) throw new Error(`command failed (exit ${code}): ${cmd}\n--- output ---\n${output}`);
      return { exitCode: code, result: code === 0 ? '' : output };
    },
  } as unknown as SandboxHandle;
  return { sandbox, execs, ghCalls: () => execs.filter((e) => e.cmd.startsWith('gh auth login')) };
}

test('seedGitHubAuth strict (prod default): the gh login runs once with check:true and a failure is fatal, as before', async () => {
  const good = ghSandbox([0]);
  await seedGitHubAuth(good.sandbox, 'ghs_x', 'strict');
  assert.deepEqual(good.ghCalls(), [{ cmd: 'gh auth login --with-token < /root/.gh-token', check: true }]);
  const bad = ghSandbox([1]);
  await assert.rejects(seedGitHubAuth(bad.sandbox, 'ghs_x', 'strict'), /error validating token/);
  assert.equal(bad.ghCalls().length, 1);
});

test('seedGitHubAuth tolerant (ROUTINE_GUARD): a transient gh failure is retried, a persistent one is a warning, the git side is seeded either way', async () => {
  const quiet = { sleep: async () => {} };
  const flaky = ghSandbox([1, 1, 0]);
  await seedGitHubAuth(flaky.sandbox, 'ghs_x', 'tolerant', quiet);
  assert.equal(flaky.ghCalls().length, 3);
  assert.ok(flaky.ghCalls().every((c) => c.check === false)); // never fatal by itself
  const dead = ghSandbox([1]);
  await seedGitHubAuth(dead.sandbox, 'ghs_x', 'tolerant', quiet); // resolves: warn + continue
  assert.equal(dead.ghCalls().length, 3); // two retries, then gave up
  assert.ok(dead.execs.some((e) => e.cmd.includes('credential.helper'))); // git auth untouched by the gh outcome
  const timeout = ghSandbox([124], '');
  await seedGitHubAuth(timeout.sandbox, 'ghs_x', 'tolerant', quiet);
  assert.equal(timeout.ghCalls().length, 1); // not transient → no retry, still not fatal
});

// ── repo skills (OpenSpec agent-skills) ────────────────────────────────────────────────────────────
const skillCfg = (repoSkills: boolean) => ({ sandbox: { workDir: '/root/work' }, repoSkills }) as unknown as Config;

test('repoSkillDirs — with REPO_SKILLS=1 a multi-repo project loads every checkout with --add-dir; off (the default), none; a single-repo project never needs any (its cwd is the repo)', () => {
  assert.deepEqual(repoSkillDirs(skillCfg(true), 'acme-suite', ['AcmeOrg/acme-admin', 'AcmeOrg/acme-shop']), ['/root/work/acme-suite/acme-admin', '/root/work/acme-suite/acme-shop']);
  assert.deepEqual(repoSkillDirs(skillCfg(true), 'caldora', ['Org/caldora']), []);
  assert.deepEqual(repoSkillDirs(skillCfg(false), 'acme-suite', ['AcmeOrg/acme-admin', 'AcmeOrg/acme-shop']), []);
});

test('skillOrigins — the scanner looks exactly where the session loads skills: the cwd, then the --add-dir checkouts', () => {
  assert.deepEqual(skillOrigins(skillCfg(true), 'caldora', ['Org/caldora']), [{ origin: 'caldora', dir: '/root/work/caldora/caldora' }]);
  assert.deepEqual(skillOrigins(skillCfg(true), 'acme-suite', ['AcmeOrg/acme-admin', 'AcmeOrg/acme-shop']), [
    { origin: 'project', dir: '/root/work/acme-suite' },
    { origin: 'acme-admin', dir: '/root/work/acme-suite/acme-admin' },
    { origin: 'acme-shop', dir: '/root/work/acme-suite/acme-shop' },
  ]);
  assert.deepEqual(skillOrigins(skillCfg(false), 'acme-suite', ['AcmeOrg/acme-admin', 'AcmeOrg/acme-shop']), [{ origin: 'project', dir: '/root/work/acme-suite' }]);
});

// ── the model credit in the sandbox (OpenSpec api-key-credit D2) ──────────────────────────────────────

test('ccCreditEnv — a subscription is today\'s prefix byte for byte; a key reads the same file into ANTHROPIC_API_KEY only', () => {
  assert.equal(CC_TOKEN_ENV, 'CLAUDE_CODE_OAUTH_TOKEN=$(cat /root/.cc-token)');
  assert.equal(ccCreditEnv('subscription'), CC_TOKEN_ENV);
  assert.equal(ccCreditEnv('api-key'), 'ANTHROPIC_API_KEY=$(cat /root/.cc-token)');
  assert.ok(!ccCreditEnv('api-key').includes('CLAUDE_CODE_OAUTH_TOKEN'));
});

test('seedClaudeAuth — the credit goes into the one credit file through the file API, chmod 600; no command carries it', async () => {
  for (const value of ['sk-ant-api03-test', 'sk-ant-oat01-test']) {
    const uploads: Record<string, string> = {};
    const execs: string[] = [];
    const sandbox = {
      uploadFile: async (b: Buffer, p: string) => void (uploads[p] = b.toString()),
      exec: async (c: string) => (execs.push(c), { exitCode: 0, result: '' }),
    } as unknown as SandboxHandle;
    await seedClaudeAuth(sandbox, { value });
    assert.deepEqual(uploads, { '/root/.cc-token': value });
    assert.deepEqual(execs, ['chmod 600 /root/.cc-token']);
  }
});
