import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Config } from './config.js';
import { FactStore } from './facts.js';
import { sessionWiring } from './tasks.js';
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

// The idle stop's notice (OpenSpec sandbox-idle-stop D7): the engine hands it to every live session of the
// stopped project, and only the rule in idlestop.ts (stopCutWork, tested there) decides which thread hears
// it — a regression here would post it into every conversation of a project at every quiet half hour.
test('openChat — processEnded ends the process first, then posts the stop notice only where stopCutWork says so', () => {
  const src = readFileSync(new URL('./tasks.ts', import.meta.url), 'utf8');
  const body = src.slice(src.indexOf('processEnded: (notice) => {'), src.indexOf('pendingTurnTakenUp:'));
  assert.match(body, /const cut = s\.idleState\(\);\s*s\.markExited\(\);/);
  assert.match(body, /if \(notice && stopCutWork\(cut\)\) idleNotify\?\.\(notice\);/);
  assert.equal(body.match(/idleNotify/g)?.length, 1, 'no other path posts');
});
