import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isBotAuthor, parseSlackDirectory, resolveSlackContainer, resolveSlackName } from './bots.js';

const dir = parseSlackDirectory(
  JSON.stringify({
    T1: {
      fetched_at: '2026-10-09T00:00:00Z',
      users: [
        { id: 'U03D1FXGTFZ', name: 'florin', real_name: 'Fabio Ganz', profile: { display_name: 'Florin' } },
        { id: 'U09BOT00001', name: 'intercom', is_bot: true, profile: { display_name: 'Intercom Convert' } },
        { id: 'USLACKBOT', name: 'slackbot', is_app_user: true, real_name: 'Slackbot' },
      ],
    },
  }),
);

test('parseSlackDirectory: labels, handles, bot flags; malformed text → empty', () => {
  assert.deepEqual(dir.get('U03D1FXGTFZ'), { label: 'Florin', handle: '@florin', isBot: false });
  assert.equal(dir.get('U09BOT00001')!.isBot, true);
  assert.equal(dir.get('USLACKBOT')!.isBot, false);
  assert.equal(parseSlackDirectory('nope').size, 0);
});

test('resolveSlackContainer: dm and mpim ids become handles; channels and unknown ids untouched', () => {
  assert.equal(resolveSlackContainer('dm:U03D1FXGTFZ', dir), 'dm:@florin');
  assert.equal(resolveSlackContainer('dm:U09QA32491N', dir), 'dm:U09QA32491N');
  assert.equal(resolveSlackContainer('mpim:@rowan+U03D1FXGTFZ', dir), 'mpim:@rowan+@florin');
  assert.equal(resolveSlackContainer('#general', dir), '#general');
  assert.equal(resolveSlackName('U03D1FXGTFZ', dir), 'Florin');
  assert.equal(resolveSlackName('Florin', dir), 'Florin');
});

test('isBotAuthor: explicit flag, known integrations, users-map bots, mail no-reply senders', () => {
  assert.equal(isBotAuthor('slack', 'Rowan', dir, true), true);
  assert.equal(isBotAuthor('slack', 'Intercom Convert', dir), true);
  assert.equal(isBotAuthor('slack', 'monto-webhook', dir), true);
  assert.equal(isBotAuthor('slack', 'U09BOT00001', dir), true);
  assert.equal(isBotAuthor('slack', 'Florin', dir), false);
  assert.equal(isBotAuthor('slack', 'U09QA32491N', dir), false); // unknown Slack Connect human
  assert.equal(isBotAuthor('gmail', 'noreply@tm.openai.com', dir), true);
  assert.equal(isBotAuthor('gmail', 'Google <calendar-notification@google.com>', dir), true);
  assert.equal(isBotAuthor('gmail', 'gemini-notes@google.com', dir), true);
  assert.equal(isBotAuthor('gmail', 'tess.north@partner.example', dir), false);
  assert.equal(isBotAuthor('msgraph', 'account-security-noreply@accountprotection.microsoft.com', dir), true);
});
