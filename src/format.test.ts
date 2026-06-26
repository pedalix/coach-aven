import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prUrls, fallbackText, fmtElapsed, stripMention } from './format.js';

test('prUrls — extracts PR URLs, dedupes, ignores non-PRs', () => {
  assert.deepEqual(prUrls('Opened https://github.com/pedalix/caldora-admin/pull/15 for review.'), [
    'https://github.com/pedalix/caldora-admin/pull/15',
  ]);
  assert.deepEqual(prUrls('see https://github.com/a/b/pull/7 and https://github.com/a/b/pull/7'), [
    'https://github.com/a/b/pull/7',
  ]);
  assert.deepEqual(prUrls('an issue https://github.com/a/b/issues/3 is not a PR'), []);
  assert.deepEqual(prUrls('none here'), []);
  assert.deepEqual(prUrls('https://github.com/o/r1/pull/1 then https://github.com/o/r2/pull/9'), [
    'https://github.com/o/r1/pull/1',
    'https://github.com/o/r2/pull/9',
  ]);
});

test('fallbackText — first non-blank line, markdown stripped, capped', () => {
  assert.equal(fallbackText('Hello *world*'), 'Hello world');
  assert.equal(fallbackText('\n\nfirst line\nsecond'), 'first line');
  assert.equal(fallbackText('`code` works'), 'code works');
  assert.equal(fallbackText(''), 'Answer');
  assert.equal(fallbackText('a'.repeat(300)).length, 200);
});

test('fmtElapsed — seconds under a minute, m+ss beyond', () => {
  assert.equal(fmtElapsed(5000), '5s');
  assert.equal(fmtElapsed(59_000), '59s');
  assert.equal(fmtElapsed(60_000), '1m00s');
  assert.equal(fmtElapsed(125_000), '2m05s');
});

test('stripMention — removes <@…> mentions and trims', () => {
  assert.equal(stripMention('<@U123> fix the bug'), 'fix the bug');
  assert.equal(stripMention('no mention'), 'no mention');
  assert.equal(stripMention('<@U1> <@U2> hi'), 'hi');
});
