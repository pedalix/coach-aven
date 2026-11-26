import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Config } from './config.js';
import { FactStore } from './facts.js';
import { grantExtras, sessionModel, sessionWiring } from './tasks.js';
import { addDirArgs, claudeLaunch } from './claudeSession.js';

const cfg = (repoSkills = false) => ({ sandbox: { workDir: '/root/work' }, repoSkills }) as unknown as Config;

const MULTI = { slug: 'acme-suite', repos: ['AcmeOrg/acme-admin', 'AcmeOrg/acme-shop'] };
const SINGLE = { slug: 'caldora', repos: ['Org/caldora'] };
// The spawn line a session with this wiring gets (claudeSession.ts), from the project folder as cwd.
const line = (w: { addDirs?: string[] }) => claudeLaunch({ ...(w.addDirs ? { extraArgs: addDirArgs(w.addDirs) } : {}) }).command('/root/work/acme-suite');

test('sessionWiring — REPO_SKILLS off (the default): a multi-repo spawn line is byte-identical to today; a single repo, too', () => {
  const facts = new FactStore(mkdtempSync(join(tmpdir(), 'aven-wiring-')));
  assert.deepEqual(sessionWiring(cfg(), MULTI, facts), {});
  assert.equal(line(sessionWiring(cfg(), MULTI, facts)), claudeLaunch({}).command('/root/work/acme-suite'));
  assert.deepEqual(sessionWiring(cfg(), SINGLE, facts), {});
});

test('sessionWiring — REPO_SKILLS=1: --add-dir with every checkout of a multi-repo project, last on the line; a single repo is unaffected', () => {
  const facts = new FactStore(mkdtempSync(join(tmpdir(), 'aven-wiring-')));
  const w = sessionWiring(cfg(true), MULTI, facts);
  assert.deepEqual(w.addDirs, ['/root/work/acme-suite/acme-admin', '/root/work/acme-suite/acme-shop']);
  assert.ok(line(w).endsWith(`'--add-dir' '/root/work/acme-suite/acme-admin' '/root/work/acme-suite/acme-shop' `));
  assert.deepEqual(sessionWiring(cfg(true), SINGLE, facts), {});
});

test('sessionWiring — only a project that offers skills records its sessions\' init commands', () => {
  const facts = new FactStore(mkdtempSync(join(tmpdir(), 'aven-wiring-')));
  assert.equal(sessionWiring(cfg(), { slug: 'caldora', repos: ['Org/caldora'] }, facts).onInitCommands, undefined);
  const w = sessionWiring(cfg(), { slug: 'brand-studio', repos: ['Org/brand-studio'], scanSkills: true }, facts);
  w.onInitCommands!(['review', 'brand-profile']);
  assert.deepEqual(facts.sessionCommands('brand-studio'), ['brand-profile', 'review']);
});

// Structural, like imports.test.ts: both sessions openChat creates — a fresh spawn and a reattach — carry the
// wiring. Dropping it from either would silently lose the repos' skills or the init record for that path.
test('openChat — every `new ClaudeSession` in tasks.ts spreads the session wiring', () => {
  const src = readFileSync(new URL('./tasks.ts', import.meta.url), 'utf8');
  const blocks = src.split('new ClaudeSession(sandbox, {').slice(1).map((b) => b.slice(0, b.indexOf('});')));
  assert.equal(blocks.length, 2, 'a fresh spawn and a reattach');
  for (const b of blocks) assert.match(b, /\.\.\.wiring,/);
  assert.match(src, /const wiring = sessionWiring\(cfg, opts, facts\);/);
});

// The idle stop's notice (OpenSpec sandbox-idle-stop D7): which conversation hears it is decided by the engine
// before the stop, while the processes still run (sandboxUse in the stop's re-check: idlestop.test.ts,
// turn.idle.test.ts). The session's end only posts what it is given — also when the log stream's end has
// already marked the process ended, as it usually has after a stop (endStoppedSession, driven over a real
// ClaudeSession in turn.idle.test.ts). Pinned here: openChat's processEnded is exactly that, through this
// conversation's own idle-notify target (where its 🔔 Background updates go).
test('openChat — processEnded hands its notice to endStoppedSession with this conversation\'s idle-notify target', () => {
  const src = readFileSync(new URL('./tasks.ts', import.meta.url), 'utf8');
  assert.match(src, /\n {4}processEnded: \(notice\) => endStoppedSession\(session, idleNotify, notice\),\n/);
  assert.equal(src.match(/endStoppedSession\(/g)?.length, 2, 'its definition and that one call');
});

// OpenSpec project-grants: every token the bot seeds into a sandbox asks for the project's active grants; the
// orchestrator's own reads (pollers, sources) never do.
test('grants — every sandbox token mint in tasks.ts passes the project\'s grant extras', () => {
  const src = readFileSync(new URL('./tasks.ts', import.meta.url), 'utf8');
  // One mint, in githubToken (bitbucket-repos D4), with the project's grants; every seed goes through it.
  const mints = src.match(/getGitHubToken\([^;]*\);/g) ?? [];
  assert.deepEqual(mints, ['getGitHubToken(cfg, scope, grantExtras(store, slug));']);
  const seeds = src.match(/await githubToken\(cfg, store, (opts\.)?slug, (opts\.)?repos, /g) ?? [];
  assert.equal(seeds.length, 3, 'project preparation (before + after the dependency scan) and seedRepoAuth (both ensureSession paths)');
  assert.equal(src.match(/await seedRepoAuth\(\);/g)?.length, 2, 'the two ensureSession seeds');
});

test('grants — grantExtras: none without a grant or after its end, workflows write while it is active', () => {
  const g = { slug: 'caldora', capability: 'workflows', at: '2026-03-02T14:00:00.000Z', until: '2026-03-02T14:30:00.000Z', by: 'U1', channel: 'C1' };
  const store = { listGrants: () => [g] };
  assert.deepEqual(grantExtras({ listGrants: () => [] }, 'caldora'), {});
  assert.deepEqual(grantExtras(store, 'caldora', Date.parse('2026-03-02T14:29:59Z')), { workflows: 'write' });
  assert.deepEqual(grantExtras(store, 'caldora', Date.parse('2026-03-02T14:30:00Z')), {});
  assert.deepEqual(grantExtras(store, 'atlas', Date.parse('2026-03-02T14:10:00Z')), {});
});

test('grants — the orchestrator\'s own mints pass no extras', () => {
  for (const f of ['./github.ts', './sources/run.ts', './pollers.ts']) {
    const src = readFileSync(new URL(f, import.meta.url), 'utf8');
    for (const m of src.match(/getGitHubToken\([^)]*\)/g) ?? []) assert.doesNotMatch(m, /grant/i, `${f}: ${m}`);
  }
});

// --- bitbucket-repos ---------------------------------------------------------------------------------------------
import type { SandboxHandle } from './driver.js';
import type { Store } from './state.js';
import { githubToken, seedBitbucket, seedComposer } from './tasks.js';
import { composerAuthScript } from './project.js';

const rec = () => {
  const execs: string[] = [];
  const uploads: Record<string, string> = {};
  const sandbox = {
    uploadFile: async (b: Buffer, p: string) => void (uploads[p] = b.toString()),
    exec: async (c: string) => (execs.push(c), { exitCode: 0, result: '' }),
  } as unknown as SandboxHandle;
  return { sandbox, execs, uploads };
};
const appCfg = { github: { kind: 'app', appId: '1', privateKey: 'k' }, bitbucket: { token: 'BB', email: 'reader@example.com' } } as unknown as Config;
const tokenCfg = { github: { kind: 'token', token: 'ghp_static' }, gitIdentity: { login: 'reader', email: 'reader@users.noreply.example' }, bitbucket: { token: 'BB' } } as unknown as Config;
const noStore = { listGrants: () => [] } as unknown as Store;

test('bitbucket-repos: the App mints nothing for a Bitbucket-only project (no GitHub call)', async () => {
  assert.equal(await githubToken(appCfg, noStore, 'atlas', ['bitbucket.org/northwind/booking-api'], []), '');
});

test('bitbucket-repos: a static GITHUB_TOKEN is still handed to a Bitbucket-only project', async () => {
  assert.equal(await githubToken(tokenCfg, noStore, 'atlas', ['bitbucket.org/northwind/booking-api'], []), 'ghp_static');
});

test('bitbucket-repos: a GitHub-only project without composerAuth gets today\'s composer script, byte for byte, and no Bitbucket seeding', async () => {
  const r = rec();
  await seedBitbucket(r.sandbox, tokenCfg, ['northwind/web']);
  await seedComposer(r.sandbox, tokenCfg, ['northwind/web'], ['/root/work/atlas/web'], undefined, 'ghp_static');
  assert.deepEqual(r.execs, [composerAuthScript(['/root/work/atlas/web'])]);
  assert.deepEqual(r.uploads, {});
});

test('bitbucket-repos: a Bitbucket project gets the helper and one auth.json with GitHub, Bitbucket (account e-mail) and its registries', async () => {
  const r = rec();
  const prev = process.env.REGISTRY_TOKEN;
  process.env.REGISTRY_TOKEN = 'reg-secret';
  try {
    const repos = ['northwind/web', 'bitbucket.org/northwind/booking-api'];
    await seedBitbucket(r.sandbox, appCfg, repos);
    await seedComposer(r.sandbox, appCfg, repos, ['/w/web', '/w/booking-api'], { 'repo.registry.example': { username: 'token', password: '${REGISTRY_TOKEN}' } }, 'ghs_minted');
  } finally {
    if (prev === undefined) delete process.env.REGISTRY_TOKEN;
    else process.env.REGISTRY_TOKEN = prev;
  }
  assert.equal(r.uploads['/root/.bb-token'], 'BB');
  const auth = JSON.parse(r.uploads['/root/.composer-auth.json']!)['http-basic'];
  assert.deepEqual(auth['github.com'], { username: 'x-access-token', password: 'ghs_minted' });
  assert.deepEqual(auth['bitbucket.org'], { username: 'reader@example.com', password: 'BB' });
  assert.deepEqual(auth['repo.registry.example'], { username: 'token', password: 'reg-secret' });
  assert.ok(!r.execs.some((c) => /BB|ghs_minted|reg-secret/.test(c.replace(/\/root\/\.bb-token/g, ''))), 'no value on a command line');
});

// operator-controls D3: a project's chat-set model and effort reach a new session only with the flag on.
test('sessionModel: flag off is exactly the installation setting, whatever the state holds', () => {
  const set = { getProjectSettings: () => ({ model: { value: 'opus', by: 'UDANA', at: '2026-03-02T10:00:00Z' }, effort: { value: 'high', by: 'UDANA', at: '2026-03-02T10:00:00Z' } }) };
  assert.deepEqual(sessionModel({ claudeModel: 'claude-sonnet-5-5', operatorControls: false }, set, 'atlas'), { model: 'claude-sonnet-5-5' });
  assert.deepEqual(sessionModel({ claudeModel: undefined, operatorControls: false }, set, 'atlas'), { model: undefined });
});

test('sessionModel: flag on, the chat-set value wins, and a project with nothing set starts as before', () => {
  const none = { getProjectSettings: () => ({}) };
  assert.deepEqual(sessionModel({ claudeModel: 'claude-sonnet-5-5', operatorControls: true }, none, 'atlas'), { model: 'claude-sonnet-5-5' });
  const set = { getProjectSettings: (slug: string) => (slug === 'atlas' ? { model: { value: 'opus', by: 'UDANA', at: '2026-03-02T10:00:00Z' }, effort: { value: 'high', by: 'UDANA', at: '2026-03-02T10:00:00Z' } } : {}) };
  assert.deepEqual(sessionModel({ claudeModel: 'claude-sonnet-5-5', operatorControls: true }, set, 'atlas'), { model: 'opus', effort: 'high' });
  assert.deepEqual(sessionModel({ claudeModel: 'claude-sonnet-5-5', operatorControls: true }, set, 'borealis'), { model: 'claude-sonnet-5-5' });
});

test('claudeLaunch: --effort follows the model, and no effort leaves the command as it was', () => {
  const base = claudeLaunch({ model: 'opus' });
  const withEffort = claudeLaunch({ model: 'opus', effort: 'high' });
  assert.equal(withEffort.command('/w'), base.command('/w').replace("--model 'opus' ", "--model 'opus' --effort 'high' "));
  assert.deepEqual(withEffort.args.slice(withEffort.args.indexOf('--model'), withEffort.args.indexOf('--model') + 4), ['--model', 'opus', '--effort', 'high']);
  assert.ok(!base.command('/w').includes('--effort') && !base.args.includes('--effort'));
});
