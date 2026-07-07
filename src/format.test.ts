import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prUrls, fallbackText, fmtElapsed, fmtAge, stripMention, mdToMrkdwn, parseTopics, trailText } from './format.js';

test('parseTopics — extracts local .md topic links, dedupes, ignores http/non-md', () => {
  const idx = [
    '# Memory Index',
    '- [Caldora overview](project_caldora_overview.md) — layout',
    '- [E-guma sync](project_eguma_voucher_sync.md) — incident',
    '- [Anthropic](https://anthropic.com) — not a topic',
    '- [dupe](project_caldora_overview.md) — same file again',
  ].join('\n');
  assert.deepEqual(parseTopics(idx), [
    { title: 'Caldora overview', file: 'project_caldora_overview.md' },
    { title: 'E-guma sync', file: 'project_eguma_voucher_sync.md' },
  ]);
  assert.deepEqual(parseTopics('no links here'), []);
});

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

test('fmtAge — minutes, hours, then days', () => {
  assert.equal(fmtAge(5 * 60_000), '5m');
  assert.equal(fmtAge(59 * 60_000), '59m');
  assert.equal(fmtAge(60 * 60_000), '1h');
  assert.equal(fmtAge(23 * 3_600_000), '23h');
  assert.equal(fmtAge(48 * 3_600_000), '2d');
});

test('stripMention — removes <@…> mentions and trims', () => {
  assert.equal(stripMention('<@U123> fix the bug'), 'fix the bug');
  assert.equal(stripMention('no mention'), 'no mention');
  assert.equal(stripMention('<@U1> <@U2> hi'), 'hi');
});

test('mdToMrkdwn — headers/bold to mrkdwn; URL links linked, file links keep target', () => {
  assert.equal(mdToMrkdwn('# Memory Index'), '*Memory Index*');
  assert.equal(mdToMrkdwn('### Sub'), '*Sub*');
  assert.equal(mdToMrkdwn('**bold** text'), '*bold* text');
  assert.equal(mdToMrkdwn('[Anthropic](https://anthropic.com)'), '<https://anthropic.com|Anthropic>');
  assert.equal(
    mdToMrkdwn('[Caldora overview](project_caldora_overview.md)'),
    'Caldora overview (`project_caldora_overview.md`)',
  );
});

test('trailText — header with count/duration, numbered steps', () => {
  const t = trailText(['📖 Read a.ts', '⚙️ npm test'], 65_000);
  assert.equal(t, '🧭 *2 steps · 1m05s*\n1. 📖 Read a.ts\n2. ⚙️ npm test');
  assert.equal(trailText(['one'], 5000).startsWith('🧭 *1 step · 5s*'), true); // singular
});

test('trailText — an oversized trail keeps the tail and notes the drop', () => {
  const steps = Array.from({ length: 100 }, (_, i) => `step ${i + 1} ${'x'.repeat(50)}`);
  const t = trailText(steps, 1000, 500);
  assert.equal(t.length <= 500, true);
  assert.match(t, /_\(first \d+ steps omitted\)_/);
  assert.equal(t.includes('100. step 100'), true); // the last (most recent) step survives
  assert.equal(t.includes('1. step 1 '), false); // the head was dropped
});
