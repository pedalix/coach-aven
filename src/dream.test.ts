import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dreamDigest, DREAM_FRAMING } from './dream.js';

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

test('DREAM_FRAMING forbids code changes', () => {
  assert.match(DREAM_FRAMING, /Do NOT modify code/);
});
