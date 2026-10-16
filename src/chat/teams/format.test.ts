import { test } from 'node:test';
import assert from 'node:assert/strict';
import { markdownToTeams, mrkdwnToTeams, splitText, stripBotMention } from './format.js';

test('mrkdwn → Teams markdown: bold, links, shortcodes', () => {
  assert.equal(mrkdwnToTeams(':information_source: *Config reloaded* — see <https://x.y/z|the log>'), 'ℹ️ **Config reloaded** — see [the log](https://x.y/z)');
  assert.equal(mrkdwnToTeams(':x: boom <https://a.b/c>'), '❌ boom https://a.b/c');
  assert.equal(mrkdwnToTeams('• *Status* — `/aven status`'), '• **Status** — `/aven status`');
  assert.equal(mrkdwnToTeams('**already** bold and 2*3*4 math'), '**already** bold and 2*3*4 math');
  assert.equal(mrkdwnToTeams(':unknown_code: stays'), ':unknown_code: stays');
});

test('markdown tables become code blocks, the rest passes through', () => {
  const md = 'Intro\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\nAfter **bold**';
  assert.equal(markdownToTeams(md), 'Intro\n\n```\n| a | b |\n|---|---|\n| 1 | 2 |\n```\n\nAfter **bold**');
  assert.equal(markdownToTeams('no | table | here'), 'no | table | here');
});

test('split parts concatenate to the input and prefer paragraph boundaries', () => {
  const para = 'x'.repeat(40);
  const text = Array.from({ length: 10 }, () => para).join('\n\n');
  const parts = splitText(text, 100);
  assert.equal(parts.join(''), text);
  assert.ok(parts.length > 1);
  for (const p of parts) assert.ok(p.length <= 100);
  assert.deepEqual(splitText('short', 100), ['short']);
  const hard = 'y'.repeat(250);
  assert.deepEqual(splitText(hard, 100), ['y'.repeat(100), 'y'.repeat(100), 'y'.repeat(50)]);
});

test('the bot mention is stripped in both forms', () => {
  assert.equal(stripBotMention('<at>Aven</at> fix the build', 'Aven'), 'fix the build');
  assert.equal(stripBotMention('@Aven card', 'Aven'), 'card');
  assert.equal(stripBotMention('mail me at aven@example.com', 'Aven'), 'mail me at aven@example.com');
  assert.equal(stripBotMention('  spaced   out  ', undefined), 'spaced out');
});
