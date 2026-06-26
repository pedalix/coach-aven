import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dreamDigest, dreamPrompt } from './dream.js';

test('dreamDigest takes the first non-empty line, stripped of markdown', () => {
  assert.equal(dreamDigest('\n\n  **Merged** two `notes` files.\nmore detail here'), 'Merged two notes files.');
});

test('dreamDigest falls back when there is nothing', () => {
  assert.equal(dreamDigest('   \n  '), 'no changes');
  assert.equal(dreamDigest(''), 'no changes');
});

test('dreamDigest caps length with an ellipsis', () => {
  const d = dreamDigest('x'.repeat(500), 50);
  assert.equal(d.length, 50);
  assert.ok(d.endsWith('…'));
});

test('dreamPrompt forbids code changes and points at this project memory + transcripts', () => {
  const p = dreamPrompt('/root/work/caldora');
  assert.match(p, /do\s+NOT modify code/i);
  // derives the memory dir and the sibling transcript dir from the cwd
  assert.match(p, /\/root\/\.claude\/projects\/-root-work-caldora\/memory\//);
  assert.match(p, /\/root\/\.claude\/projects\/-root-work-caldora\/\*\.jsonl/);
  // the multi-phase structure that the terse version lacked
  assert.match(p, /Phase 1 — Orient/);
  assert.match(p, /Phase 2 — Gather recent signal/);
  assert.match(p, /Phase 4 — Prune & index/);
});
