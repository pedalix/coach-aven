// The installation directory (OpenSpec `installation-directory`): AVEN_DIR, else the package root; path
// settings resolve against it, never against the working directory; and a guard that keeps every runtime
// file located through src/paths.ts — not through the code's own location, not through the working directory.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dataRootDefault, dotenvPath, installDir, installPath, PACKAGE_ROOT, projectsConfigDefault, settingPath, statePath } from './paths.js';

const SRC = new URL('./', import.meta.url).pathname;

test('installDir: unset or empty is the package root; an absolute value is used as it is; a relative value throws naming AVEN_DIR', () => {
  assert.equal(installDir({}), PACKAGE_ROOT);
  assert.equal(installDir({ AVEN_DIR: '' }), PACKAGE_ROOT);
  assert.equal(installDir({ AVEN_DIR: '   ' }), PACKAGE_ROOT);
  assert.equal(installDir({ AVEN_DIR: '/srv/acme' }), '/srv/acme');
  assert.equal(installDir({ AVEN_DIR: '/srv/acme/' }), '/srv/acme');
  assert.throws(() => installDir({ AVEN_DIR: 'state' }), /AVEN_DIR must be an absolute path \(got 'state'\)/);
  assert.throws(() => installDir({ AVEN_DIR: './acme' }), /AVEN_DIR must be an absolute path/);
  assert.equal(installDir({}, '/opt/code'), '/opt/code');
  assert.ok(PACKAGE_ROOT.endsWith('/') === false && existsSync(join(PACKAGE_ROOT, 'package.json')), PACKAGE_ROOT);
});

test('the runtime paths follow the installation directory', () => {
  const env = { AVEN_DIR: '/srv/acme' };
  assert.equal(statePath(env), '/srv/acme/state.json');
  assert.equal(installPath('queue.jsonl', env), '/srv/acme/queue.jsonl');
  assert.equal(dotenvPath(env), '/srv/acme/.env');
  assert.equal(projectsConfigDefault(env), '/srv/acme/projects.config.json');
  assert.equal(statePath({}), join(PACKAGE_ROOT, 'state.json'));
});

test('AVEN_DATA_DIR still narrows data/: absolute as it is, relative against the installation directory, unset = data/ in it', () => {
  assert.equal(dataRootDefault({ AVEN_DIR: '/srv/acme' }), '/srv/acme/data');
  assert.equal(dataRootDefault({ AVEN_DIR: '/srv/acme', AVEN_DATA_DIR: '/data/acme' }), '/data/acme');
  assert.equal(dataRootDefault({ AVEN_DIR: '/srv/acme', AVEN_DATA_DIR: 'tenants' }), '/srv/acme/tenants');
  assert.equal(dataRootDefault({}), join(PACKAGE_ROOT, 'data'));
});

test('settingPath: a relative setting resolves against the installation directory, an absolute one is used as it is, empty is undefined', () => {
  assert.equal(settingPath('github-app-private-key.pem', { AVEN_DIR: '/srv/acme' }), '/srv/acme/github-app-private-key.pem');
  assert.equal(settingPath('./github-app-private-key.pem', { AVEN_DIR: '/srv/acme' }), '/srv/acme/github-app-private-key.pem');
  assert.equal(settingPath('/home/deployer/.config/coach-aven/hub.key', { AVEN_DIR: '/srv/acme' }), '/home/deployer/.config/coach-aven/hub.key');
  assert.equal(settingPath('conf/m.json', {}), join(PACKAGE_ROOT, 'conf/m.json'));
  assert.equal(settingPath(undefined, {}), undefined);
  assert.equal(settingPath('  ', {}), undefined);
});

// ── the guard: no runtime file located through the code or the working directory ─────────────────────

function tsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return name === 'fixtures' ? [] : tsFiles(p);
    return p.endsWith('.ts') && !p.endsWith('.test.ts') ? [p] : [];
  });
}

// What may be located through the code: the code's own assets. Anything else is a runtime file and belongs
// under the installation directory (src/paths.ts).
const CODE_ASSET = (target: string): boolean =>
  /fixtures/.test(target) || /\/static\/$/.test(target) || /\.mjs$/.test(target);
// The two modules that may name the package root itself: the resolver, and the CLI probe, which type-checks the code.
const ROOT_ALLOWED = new Set(['paths.ts', 'cliprobe/cli.ts']);

test('no runtime file is located through the code: new URL(…, import.meta.url) under src/ names a code asset only', () => {
  const offenders: string[] = [];
  for (const p of tsFiles(SRC)) {
    const rel = relative(SRC, p);
    const text = readFileSync(p, 'utf8');
    for (const m of text.matchAll(/new URL\(\s*(['"`])([^'"`]+)\1\s*,\s*import\.meta\.url\s*\)/g)) {
      const target = m[2];
      if (CODE_ASSET(target)) continue;
      if (ROOT_ALLOWED.has(rel) && /^(\.\.\/)+$|^\.\.\/\.\.$/.test(target)) continue;
      offenders.push(`${rel}: ${target}`);
    }
  }
  assert.deepEqual(offenders, [], 'a runtime file located through the code — resolve it through src/paths.ts instead');
});

test('no runtime file is located through the working directory: process.cwd() under src/ only in the CLI probe’s type-check helper', () => {
  const offenders = tsFiles(SRC)
    .map((p) => relative(SRC, p))
    .filter((rel) => rel !== 'cliprobe/typecheck.ts')
    .filter((rel) => /process\.cwd\(\)/.test(readFileSync(join(SRC, rel), 'utf8')));
  assert.deepEqual(offenders, [], 'a path built from the working directory — resolve it through src/paths.ts instead');
});

// ── the CLI from another working directory: it reads the installation's .env and nothing of the shell's directory ──

const CLI = join(PACKAGE_ROOT, 'src/cli.ts');
const LOADER = fileURLToPath(import.meta.resolve('tsx'));

function cli(args: string[], o: { cwd: string; env: Record<string, string> }): { out: string; status: number } {
  // The child must not carry NODE_TEST_CONTEXT, or config.ts never loads .env (that is the test runner's guard).
  const env: Record<string, string> = { ...(process.env as Record<string, string>), ...o.env };
  delete env.NODE_TEST_CONTEXT;
  try {
    return { out: execFileSync(process.execPath, ['--import', LOADER, CLI, ...args], { cwd: o.cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }), status: 0 };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; status?: number };
    return { out: `${err.stdout ?? ''}${err.stderr ?? ''}`, status: err.status ?? 1 };
  }
}

test('a command started elsewhere with AVEN_DIR reads that installation’s .env, and a relative path setting lands in that directory', () => {
  const install = mkdtempSync(join(tmpdir(), 'aven-install-'));
  const elsewhere = mkdtempSync(join(tmpdir(), 'aven-cwd-'));
  try {
    writeFileSync(join(install, '.env'), 'INSTALLATION_ID=zz-fixture\nHUB_KEY_PATH=hub.key\n');
    writeFileSync(join(elsewhere, '.env'), 'INSTALLATION_ID=zz-wrong\nHUB_KEY_PATH=wrong.key\n');
    const r = cli(['hub', 'keygen'], { cwd: elsewhere, env: { AVEN_DIR: install } });
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /"zz-fixture"/);
    assert.ok(existsSync(join(install, 'hub.key')), 'the key file goes under AVEN_DIR');
    assert.ok(!existsSync(join(elsewhere, 'hub.key')) && !existsSync(join(elsewhere, 'wrong.key')), 'nothing lands in the working directory');
  } finally {
    rmSync(install, { recursive: true, force: true });
    rmSync(elsewhere, { recursive: true, force: true });
  }
});

test('a .env that sets AVEN_DIR stops the boot in one sentence; so does a relative AVEN_DIR', () => {
  const install = mkdtempSync(join(tmpdir(), 'aven-install-'));
  try {
    writeFileSync(join(install, '.env'), 'AVEN_DIR=/srv/acme\n');
    const inFile = cli(['hub', 'keygen'], { cwd: install, env: { AVEN_DIR: install } });
    assert.notEqual(inFile.status, 0);
    assert.match(inFile.out, /\.env sets AVEN_DIR, but the setting names where \.env is read from and belongs in the service's environment/);
    const relative_ = cli(['hub', 'keygen'], { cwd: install, env: { AVEN_DIR: 'state' } });
    assert.notEqual(relative_.status, 0);
    assert.match(relative_.out, /AVEN_DIR must be an absolute path \(got 'state'\)/);
  } finally {
    rmSync(install, { recursive: true, force: true });
  }
});

// ── the stores follow AVEN_DIR (installation-directory: one setting names the installation directory) ──

test('with AVEN_DIR set, state.json, queue.jsonl and the month’s usage file are written there and nothing beside the code', async () => {
  const install = mkdtempSync(join(tmpdir(), 'aven-install-'));
  const before = process.env.AVEN_DIR;
  process.env.AVEN_DIR = install;
  try {
    const { Store } = await import('./state.js');
    const { QueueJournal } = await import('./queuejournal.js');
    const { UsageLog } = await import('./metering.js');
    new Store().addRoutine({ slug: 'acme', channel: 'C1', cron: '0 9 * * 1-5', tz: 'UTC', spec: 'weekdays 9:00', prompt: 'the standing brief', enabled: true, createdBy: 'U1' });
    new QueueJournal().add({ turnId: 't1-1', key: 'C1', slug: 'acme', channel: 'C1', statusTs: '1.1', text: 'hi', userId: 'U1' } as unknown as Parameters<InstanceType<typeof QueueJournal>['add']>[0]);
    new UsageLog().record({ at: new Date().toISOString(), key: 'C1', slug: 'acme', kind: 'turn', status: 'ok', elapsedMs: 1 });
    assert.ok(existsSync(join(install, 'state.json')), 'state.json under AVEN_DIR');
    assert.ok(existsSync(join(install, 'queue.jsonl')), 'queue.jsonl under AVEN_DIR');
    const month = `${new Date().toISOString().slice(0, 7)}.jsonl`;
    assert.ok(existsSync(join(install, 'usage', month)), 'the month’s usage file under AVEN_DIR');
    assert.match(readFileSync(join(install, 'state.json'), 'utf8'), /the standing brief/);
  } finally {
    if (before === undefined) delete process.env.AVEN_DIR;
    else process.env.AVEN_DIR = before;
    rmSync(install, { recursive: true, force: true });
  }
});
