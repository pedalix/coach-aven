import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Config } from './config.js';
import { FactStore } from './facts.js';
import { sessionWiring } from './tasks.js';

const cfg = (repoSkills = true) => ({ sandbox: { workDir: '/root/work' }, repoSkills }) as unknown as Config;

test('sessionWiring — a multi-repo project\'s sessions get --add-dir for every checkout; a single repo, or REPO_SKILLS=0, none', () => {
  const facts = new FactStore(mkdtempSync(join(tmpdir(), 'aven-wiring-')));
  assert.deepEqual(sessionWiring(cfg(), { slug: 'acme-suite', repos: ['AcmeOrg/acme-admin', 'AcmeOrg/acme-shop'] }, facts).addDirs, ['/root/work/acme-suite/acme-admin', '/root/work/acme-suite/acme-shop']);
  assert.deepEqual(sessionWiring(cfg(), { slug: 'caldora', repos: ['Org/caldora'] }, facts), {});
  assert.deepEqual(sessionWiring(cfg(false), { slug: 'acme-suite', repos: ['AcmeOrg/acme-admin', 'AcmeOrg/acme-shop'] }, facts), {});
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
