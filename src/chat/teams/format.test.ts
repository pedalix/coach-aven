import { test } from 'node:test';
import assert from 'node:assert/strict';
import { markdownToTeams, mrkdwnToTeams, rewriteMentions, splitText, stripBotMention, teamsMentions } from './format.js';

test('inbound mentions: the bot’s is dropped, a person’s becomes <@id>', () => {
  const entities = [
    { type: 'mention', mentioned: { id: '28:BOT', name: 'Aven' }, text: '<at>Aven</at>' },
    { type: 'mention', mentioned: { id: '29:USER2', name: 'Example Admin' }, text: '<at>Example Admin</at>' },
    { type: 'clientInfo' },
  ];
  assert.equal(rewriteMentions('<at>Aven</at> /users allow <at>Example Admin</at>', entities, '28:BOT'), ' /users allow <@29:USER2>');
  assert.equal(rewriteMentions('no entities', undefined, '28:BOT'), 'no entities');
});

test('outbound mentions: <@id> → <at>Name</at> + entity when the name is known', () => {
  const names: Record<string, string> = { '29:USER2': 'Example Admin' };
  assert.deepEqual(teamsMentions('ask <@29:USER2> or <@29:USER9|x>', (id) => names[id]), {
    text: 'ask <at>Example Admin</at> or @29:USER9',
    entities: [{ type: 'mention', mentioned: { id: '29:USER2', name: 'Example Admin' }, text: '<at>Example Admin</at>' }],
  });
  assert.deepEqual(teamsMentions('plain', () => undefined), { text: 'plain' });
});

test('mrkdwn → Teams markdown: bold, links, shortcodes', () => {
  assert.equal(mrkdwnToTeams(':information_source: *Config reloaded* — see <https://x.y/z|the log>'), 'ℹ️ **Config reloaded** — see [the log](https://x.y/z)');
  assert.equal(mrkdwnToTeams(':x: boom <https://a.b/c>'), '❌ boom https://a.b/c');
  // The router's hints name the Slack slash command; on Teams the verb follows the slash.
  assert.equal(mrkdwnToTeams('• *Status* — `/aven status`'), '• **Status** — `/status`');
  assert.equal(mrkdwnToTeams('_Manage:_ `/aven routines` · `/aven users allow @user`'), '_Manage:_ `/routines` · `/users allow @user`');
  assert.equal(mrkdwnToTeams('a bare `/aven` or /aven status in prose stays'), 'a bare `/aven` or /aven status in prose stays');
  assert.equal(mrkdwnToTeams('**already** bold and 2*3*4 math'), '**already** bold and 2*3*4 math');
  assert.equal(mrkdwnToTeams(':unknown_code: stays'), ':unknown_code: stays');
  // The router's own short texts: seen rendered as written on the canary (2026-10-18).
  assert.equal(mrkdwnToTeams(':envelope_with_arrow: Answering you in DM…'), '📩 Answering you in DM…');
  assert.equal(mrkdwnToTeams(':bar_chart: Gathering status…'), '📊 Gathering status…');
  assert.equal(mrkdwnToTeams(':lock: Usage reporting is operator-only.'), '🔒 Usage reporting is operator-only.');
});

test('GitHub markdown passes through unchanged (Teams renders tables, code and headings)', () => {
  const md = '# Title\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n```ts\nx\n```\n\nAfter **bold**';
  assert.equal(markdownToTeams(md), md);
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
