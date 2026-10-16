import { test } from 'node:test';
import assert from 'node:assert/strict';
import { utf8Chunks } from './utf8.js';

test('utf8Chunks — a multibyte char split across two chunks survives intact', () => {
  const full = Buffer.from('{"text":"Привет, мир 👋"}', 'utf8');
  const whole = full.toString('utf8');
  // Every possible split point must reassemble to exactly the same string. The naive
  // per-chunk Buffer.toString('utf8') fails most of these with U+FFFD on both sides.
  for (let cut = 1; cut < full.length; cut++) {
    const d = utf8Chunks();
    const got = d.push(full.subarray(0, cut)) + d.push(full.subarray(cut)) + d.flush();
    assert.equal(got, whole, `split at byte ${cut}`);
    assert.equal(got.length, whole.length, `char count drift at byte ${cut}`);
  }
  // …and the bug it replaces really is one: a cut inside "П" garbles the naive decode.
  const naive = full.subarray(0, 10).toString('utf8') + full.subarray(10).toString('utf8');
  assert.notEqual(naive, whole);
});

test('utf8Chunks — byte-at-a-time streaming reassembles exactly', () => {
  const full = Buffer.from('код 🚀 ünïcode', 'utf8');
  const d = utf8Chunks();
  let got = '';
  for (const byte of full) got += d.push(Buffer.from([byte]));
  got += d.flush();
  assert.equal(got, full.toString('utf8'));
});

test('utf8Chunks — flush surfaces a truncated trailing sequence', () => {
  const d = utf8Chunks();
  // First two bytes of a 3-byte character, then the stream dies (killed ssh).
  assert.equal(d.push(Buffer.from([0xe2, 0x82])), '');
  assert.equal(d.flush(), '�'); // one replacement char — not silently swallowed
});
