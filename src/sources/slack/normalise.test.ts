import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  compareTs,
  containerLabel,
  flattenText,
  isNoise,
  isThreadParent,
  isThreadReply,
  knownMembers,
  mentionedUserIds,
  mpimHandles,
  normaliseFiles,
  normaliseMessage,
  permalink,
  slackTsToIso,
  sortByTs,
  type RawConversation,
  type RawMessage,
  type RawUser,
  type WorkspaceContext,
} from './normalise.js';

// ---------------------------------------------------------------------------------------
// Fixtures — shaped after the examples on docs.slack.dev (users.list, users.conversations,
// conversations.history, conversations.replies). Ids and names are synthetic.
// ---------------------------------------------------------------------------------------

const users: RawUser[] = [
  { id: 'U0OWEN0001', name: 'owen', real_name: 'Owen Hale', profile: { display_name: 'Owen', real_name: 'Owen Hale' } },
  { id: 'U0ALICE001', name: 'alice', real_name: 'Alice Example', profile: { display_name: '', real_name: 'Alice Example' } },
  { id: 'U0BOB00001', name: 'bob', real_name: 'Bob Builder', profile: { display_name: 'bobby' } },
  { id: 'U0DELETED1', name: 'olduser', real_name: 'Old User', deleted: true, profile: {} },
];

const ctx: WorkspaceContext = {
  team_id: 'T0000FAKE01',
  url: 'https://pedalix.slack.com/',
  self_user_id: 'U0OWEN0001',
  users: new Map(users.map((u) => [u.id, u])),
};

const channel: RawConversation = {
  id: 'C012AB3CD',
  name: 'hcg-p5',
  is_channel: true,
  is_private: false,
  is_archived: false,
  topic: { value: 'P5 platform' },
  purpose: { value: 'Brandhaus platform work' },
};

const privateChannel: RawConversation = { id: 'G024BE91L', name: 'secret-plans', is_group: true, is_private: true };
const im: RawConversation = { id: 'D0123ABCD', is_im: true, user: 'U0ALICE001' };
const mpim: RawConversation = { id: 'G0MPIM001', name: 'mpdm-owen--alice--bob-1', is_mpim: true, is_private: true };

const parent: RawMessage = {
  type: 'message',
  user: 'U0ALICE001',
  text: 'Hey <@U0OWEN0001>, can you ship the &lt;config&gt; change to <#C012AB3CD|hcg-p5> by Friday? See <https://example.com/ticket/42|P5-42> &amp; <https://example.com/raw>',
  ts: '1759740000.000100',
  thread_ts: '1759740000.000100',
  reply_count: 2,
  reply_users_count: 2,
  latest_reply: '1759743600.000300',
  reply_users: ['U0OWEN0001', 'U0BOB00001'],
  is_locked: false,
  subscribed: true,
} as RawMessage;

const reply: RawMessage = {
  type: 'message',
  user: 'U0OWEN0001',
  text: 'Yes, by Friday. cc <@U0BOB00001>',
  ts: '1759743600.000300',
  thread_ts: '1759740000.000100',
  parent_user_id: 'U0ALICE001',
} as RawMessage;

const botMessage: RawMessage = {
  type: 'message',
  subtype: 'bot_message',
  bot_id: 'B0ABCDEF',
  username: 'deploybot',
  bot_profile: { name: 'Deploy Bot' },
  text: 'Deploy finished',
  ts: '1759750000.000200',
  attachments: [{ title: 'Build 123', text: 'all green', fallback: 'Build 123: all green' }],
};

const join: RawMessage = { type: 'message', subtype: 'channel_join', user: 'U0BOB00001', text: '<@U0BOB00001> has joined the channel', ts: '1759700000.000001' };

const withFile: RawMessage = {
  type: 'message',
  user: 'U0ALICE001',
  text: '',
  ts: '1759760000.000500',
  files: [
    {
      id: 'F0S43PECT',
      created: 1759759990,
      timestamp: 1759759990,
      name: 'offer.pdf',
      title: 'Offer v2',
      mimetype: 'application/pdf',
      filetype: 'pdf',
      size: 48213,
      url_private: 'https://files.slack.com/files-pri/T0000FAKE01-F0S43PECT/offer.pdf',
      permalink: 'https://pedalix.slack.com/files/U0ALICE001/F0S43PECT/offer.pdf',
      mode: 'hosted',
    },
    { id: 'F0GONE000', mode: 'tombstone' },
  ],
};

// ---------------------------------------------------------------------------------------

test('slackTsToIso keeps millisecond precision and UTC', () => {
  assert.equal(slackTsToIso('1759740000.000100'), '2025-10-06T08:40:00.000Z');
  assert.equal(slackTsToIso('1759740000.123456'), '2025-10-06T08:40:00.123Z');
  assert.equal(slackTsToIso('1759740000'), '2025-10-06T08:40:00.000Z');
});

test('compareTs is numeric, not lexicographic', () => {
  assert.ok(compareTs('1759740000.000100', '1759740000.000099') > 0);
  assert.ok(compareTs('999999999.999999', '1000000000.000001') < 0);
  assert.deepEqual(
    sortByTs([{ ts: '1759740000.000100' }, { ts: '1759739999.999999' }]).map((m) => m.ts),
    ['1759739999.999999', '1759740000.000100'],
  );
});

test('containerLabel names channels, DMs by the other party, mpims by members minus self', () => {
  assert.equal(containerLabel(channel, ctx), '#hcg-p5');
  assert.equal(containerLabel(privateChannel, ctx), '#secret-plans');
  assert.equal(containerLabel(im, ctx), 'dm:@alice');
  assert.equal(containerLabel(mpim, ctx), 'mpim:@alice+@bob');
  // Unknown DM counterpart (deactivated and dropped from users.list) falls back to the id.
  assert.equal(containerLabel({ id: 'D0UNKNOWN', is_im: true, user: 'U0NOBODY00' }, ctx), 'dm:U0NOBODY00');
});

test('mpimHandles parses the mpdm-… naming scheme and rejects other names', () => {
  assert.deepEqual(mpimHandles('mpdm-owen--alice--bob-1'), ['owen', 'alice', 'bob']);
  assert.deepEqual(mpimHandles('mpdm-a.b--c_d-12'), ['a.b', 'c_d']);
  assert.deepEqual(mpimHandles('general'), []);
  assert.deepEqual(mpimHandles(''), []);
});

test('knownMembers resolves mpim handles to ids and DM to both parties', () => {
  assert.deepEqual(knownMembers(im, ctx), ['U0OWEN0001', 'U0ALICE001']);
  assert.deepEqual(knownMembers(mpim, ctx), ['U0OWEN0001', 'U0ALICE001', 'U0BOB00001']);
  assert.deepEqual(knownMembers(channel, ctx), []);
});

test('mentionedUserIds finds user and workspace-user mentions, deduplicated, with labels', () => {
  assert.deepEqual(mentionedUserIds('<@U0OWEN0001> and <@U0BOB00001|bob> and <@U0OWEN0001> and <@W0ENT00001>'), [
    'U0OWEN0001',
    'U0BOB00001',
    'W0ENT00001',
  ]);
});

test('flattenText rewrites mrkdwn tokens into readable text', () => {
  assert.equal(flattenText(parent.text!, ctx.users), 'Hey @Owen, can you ship the <config> change to #hcg-p5 by Friday? See P5-42 (https://example.com/ticket/42) & https://example.com/raw');
  assert.equal(flattenText('<!channel> ping <!here|here> <!subteam^S0ENG|@eng> <@U0NOBODY00>', ctx.users), '@channel ping @here @eng @U0NOBODY00');
  assert.equal(flattenText('<https://a.b|https://a.b> <mailto:x@y.z|x@y.z>', ctx.users), 'https://a.b x@y.z');
  assert.equal(flattenText('<!date^1759740000^{date_short} at {time}|Oct 6 at 10:40> meeting', ctx.users), 'Oct 6 at 10:40 meeting');
  // display_name empty → real_name; display_name set → display_name
  assert.equal(flattenText('<@U0ALICE001> <@U0BOB00001>', ctx.users), '@Alice Example @bobby');
});

test('noise subtypes are dropped, everything else passes', () => {
  assert.equal(isNoise(join), true);
  assert.equal(isNoise(botMessage), false);
  assert.equal(isNoise(parent), false);
  assert.equal(normaliseMessage(join, channel, ctx), null);
});

test('thread predicates', () => {
  assert.equal(isThreadParent(parent), true);
  assert.equal(isThreadReply(parent), false);
  assert.equal(isThreadReply(reply), true);
  assert.equal(isThreadParent(reply), false);
  assert.equal(isThreadParent({ type: 'message', ts: '1', thread_ts: '1', reply_count: 0 }), false);
});

test('permalink matches the Slack UI format, with thread params for replies', () => {
  assert.equal(permalink('https://pedalix.slack.com/', 'C012AB3CD', '1759740000.000100'), 'https://pedalix.slack.com/archives/C012AB3CD/p1759740000000100');
  assert.equal(
    permalink('https://pedalix.slack.com', 'C012AB3CD', '1759743600.000300', '1759740000.000100'),
    'https://pedalix.slack.com/archives/C012AB3CD/p1759743600000300?thread_ts=1759740000.000100&cid=C012AB3CD',
  );
  // A parent's thread_ts equals its ts → plain link.
  assert.equal(permalink('https://pedalix.slack.com', 'C012AB3CD', '1759740000.000100', '1759740000.000100'), 'https://pedalix.slack.com/archives/C012AB3CD/p1759740000000100');
});

test('normaliseMessage maps a thread parent in a channel', () => {
  const rec = normaliseMessage(parent, channel, ctx);
  assert.deepEqual(rec, {
    source: 'slack',
    account: 'T0000FAKE01',
    container: '#hcg-p5',
    id: 'C012AB3CD:1759740000.000100',
    ts: '2025-10-06T08:40:00.000Z',
    author: 'Alice Example',
    participants: ['Alice Example', 'Owen', 'bobby'],
    text: 'Hey @Owen, can you ship the <config> change to #hcg-p5 by Friday? See P5-42 (https://example.com/ticket/42) & https://example.com/raw',
    permalink: 'https://pedalix.slack.com/archives/C012AB3CD/p1759740000000100',
    raw_ref: 'slack:T0000FAKE01/C012AB3CD/1759740000.000100',
  });
});

test('normaliseMessage maps a thread reply with subject from the parent and a thread permalink', () => {
  const rec = normaliseMessage(reply, channel, ctx, { parentText: parent.text });
  assert.ok(rec);
  assert.equal(rec.author, 'Owen');
  assert.equal(rec.subject, 're: Hey @Owen, can you ship the <config> change to #hcg-p5 by F…');
  assert.deepEqual(rec.participants, ['Owen', 'bobby']);
  assert.equal(rec.permalink, 'https://pedalix.slack.com/archives/C012AB3CD/p1759743600000300?thread_ts=1759740000.000100&cid=C012AB3CD');
  assert.equal(rec.raw_ref, 'slack:T0000FAKE01/C012AB3CD/1759743600.000300#1759740000.000100');
});

test('normaliseMessage in a DM adds the counterpart; in an mpim all members', () => {
  const dm = normaliseMessage({ type: 'message', user: 'U0ALICE001', text: 'ping', ts: '1759740001.000000' }, im, ctx);
  assert.ok(dm);
  assert.equal(dm.container, 'dm:@alice');
  assert.deepEqual(dm.participants, ['Alice Example', 'Owen']);

  const group = normaliseMessage({ type: 'message', user: 'U0OWEN0001', text: 'hi all', ts: '1759740002.000000' }, mpim, ctx);
  assert.ok(group);
  assert.equal(group.container, 'mpim:@alice+@bob');
  assert.deepEqual(group.participants, ['Owen', 'Alice Example', 'bobby']);
});

test('normaliseMessage labels bot authors and folds attachment text in', () => {
  const rec = normaliseMessage(botMessage, channel, ctx);
  assert.ok(rec);
  assert.equal(rec.author, 'Deploy Bot');
  assert.deepEqual(rec.participants, ['Deploy Bot']);
  assert.equal(rec.text, 'Deploy finished\nBuild 123: all green');
  assert.equal(rec.id, 'C012AB3CD:1759750000.000200');
  assert.equal(rec.is_bot, true, 'apps are flagged so search can hide them');
  const human = normaliseMessage({ type: 'message', user: 'U0ALICE001', text: 'hi', ts: '1759740009.000000' }, channel, ctx);
  assert.equal(human?.is_bot, undefined);
});

test('unknown user ids and deleted users degrade gracefully', () => {
  const rec = normaliseMessage({ type: 'message', user: 'U0NOBODY00', text: 'hello <@U0DELETED1>', ts: '1759740003.000000' }, channel, ctx);
  assert.ok(rec);
  assert.equal(rec.author, 'U0NOBODY00');
  assert.deepEqual(rec.participants, ['U0NOBODY00', 'Old User']);
});

test('files: message text lists them, normaliseFiles emits records and skips tombstones', () => {
  const rec = normaliseMessage(withFile, channel, ctx);
  assert.ok(rec);
  assert.equal(rec.text, '[file: Offer v2] [file: F0GONE000]');
  const files = normaliseFiles(withFile, channel, ctx);
  assert.deepEqual(files, [
    {
      source: 'slack',
      account: 'T0000FAKE01',
      id: 'F0S43PECT',
      name: 'Offer v2',
      path: '#hcg-p5',
      mime: 'application/pdf',
      modified: '2025-10-06T14:13:10.000Z',
      size: 48213,
      link: 'https://pedalix.slack.com/files/U0ALICE001/F0S43PECT/offer.pdf',
    },
  ]);
});
