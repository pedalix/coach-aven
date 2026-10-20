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
