// Inbound files: the three Teams shapes over the recorded fixtures → refs for the ingest
// pipeline, with the right auth per source; Graph answered by a fake fetch.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { activityShape, channelMessageFiles, htmlTags, hydrateTeamsFiles, isClientAsset, READ_BACK_DELAYS_MS, resolveShare, shareId, teamsFiles, type Sleep } from './files.js';
import { normalizeMessage, type InboundActivity } from './events.js';

const DIR = new URL('../../fixtures/chat/teams/activities/', import.meta.url).pathname;
const load = (name: string): InboundActivity => JSON.parse(readFileSync(`${DIR}${name}.json`, 'utf8'));
const TENANT = '00000000-0000-4000-8000-00000000000a';
const tokens = { botToken: async () => 'BOT', graphToken: async () => 'GRAPH' };

test('classification: an upload, a pasted image, a channel document; the html echo is not a file', () => {
  assert.deepEqual(teamsFiles(load('message-personal-file').attachments), [
    { kind: 'download', name: 'spec.pdf', url: 'https://example-my.sharepoint.example/personal/user_example/_layouts/15/download.aspx?UniqueId=0000&Translate=false&tempauth=TEMPAUTH', mime: 'application/pdf' },
  ]);
  assert.deepEqual(teamsFiles(load('message-channel-image').attachments), [
    { kind: 'image', name: 'pasted-image-1.png', url: 'https://smba.trafficmanager.net/teams/00000000-0000-4000-8000-00000000000a/v3/attachments/0-example-image/views/original', mime: 'image/png' },
  ]);
  assert.deepEqual(teamsFiles(load('message-channel-file').attachments), [
    { kind: 'reference', name: 'brief.docx', url: 'https://example.sharepoint.example/sites/Platform/Shared Documents/General/brief.docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
  ]);
  assert.deepEqual(teamsFiles(load('message-personal').attachments), []);
  assert.deepEqual(teamsFiles(undefined), []);
});

test('hydrate: an upload is pre-authorized, an image takes the bot token, a document goes through Graph', async () => {
  const seen: string[] = [];
  const fetchFn = (async (url: string, init?: { headers?: Record<string, string> }) => {
    seen.push(`${url} ${init?.headers?.Authorization ?? ''}`);
    return { ok: true, status: 200, json: async () => ({ name: 'brief (1).docx', size: 1234, file: { mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }, '@microsoft.graph.downloadUrl': 'https://example.sharepoint.example/_layouts/download?tempauth=X' }) };
  }) as unknown as typeof fetch;
  const files = [...teamsFiles(load('message-personal-file').attachments), ...teamsFiles(load('message-channel-image').attachments), ...teamsFiles(load('message-channel-file').attachments)];
  const { refs, bearer } = await hydrateTeamsFiles(files, tokens, fetchFn);
  assert.equal(bearer, 'BOT');
  assert.deepEqual(
    refs.map((r) => [r.name, r.auth ?? 'bearer', !!r.url, r.size]),
    [
      ['spec.pdf', 'none', true, 0],
      ['pasted-image-1.png', 'bearer', true, 0],
      ['brief (1).docx', 'none', true, 1234],
    ],
  );
  assert.equal(refs[2].url, 'https://example.sharepoint.example/_layouts/download?tempauth=X');
  assert.deepEqual(seen, [`https://graph.microsoft.com/v1.0/shares/${shareId(files[2].url)}/driveItem Bearer GRAPH`]);
});

test('hydrate: no Graph consent → the document is a ref without a URL (reported as not granted); no bot token → the image too', async () => {
  const files = [...teamsFiles(load('message-channel-image').attachments), ...teamsFiles(load('message-channel-file').attachments)];
  const { refs } = await hydrateTeamsFiles(files, { botToken: async () => undefined, graphToken: async () => undefined });
  assert.deepEqual(refs.map((r) => [r.name, r.url]), [['pasted-image-1.png', ''], ['brief.docx', '']]);
});

test('resolveShare: Graph refusing the share yields undefined, not a throw', async () => {
  const fetchFn = (async () => ({ ok: false, status: 403 })) as unknown as typeof fetch;
  assert.equal(await resolveShare('https://example.sharepoint.example/x', 'T', fetchFn), undefined);
  assert.equal(shareId('https://a.b/c+d/e'), `u!${Buffer.from('https://a.b/c+d/e').toString('base64').replace(/=+$/, '').replace(/\//g, '_').replace(/\+/g, '-')}`);
});

test('a message with files tells the core so (hasFiles) only when the adapter has tokens', () => {
  const a = load('message-personal-file');
  const n = normalizeMessage(a, TENANT, () => true, tokens);
  assert.equal(n.kind, 'message');
  if (n.kind === 'message') assert.equal(n.msg.hasFiles, true);
  const bare = normalizeMessage(a, TENANT);
  if (bare.kind === 'message') assert.equal(bare.msg.hasFiles, false);
});

test('activityShape (TEAMS_TRACE): the shape of an activity for the journal — no text, no URL', () => {
  assert.deepEqual(JSON.parse(activityShape(load('message-channel-file'))), {
    type: 'message',
    scope: 'channel',
    textLength: 'the brief'.length,
    attachmentTag: false,
    entities: ['clientInfo'],
    channelData: ['teamsChannelId', 'teamsTeamId', 'channel', 'team', 'tenant'],
    team: ['aadGroupId', 'id'],
    attachments: [
      { contentType: 'reference', name: 'brief.docx', contentUrl: 'example.sharepoint.example', urlHash: createHash('sha1').update('https://example.sharepoint.example/sites/Platform/Shared Documents/General/brief.docx').digest('hex').slice(0, 8), content: ['uniqueId', 'fileType'] },
      { contentType: 'text/html', content: 'string', html: ['p'] },
    ],
  });
  const image = JSON.parse(activityShape(load('message-channel-image')));
  assert.deepEqual({ ...image.attachments[0], urlHash: undefined }, { contentType: 'image/*', contentUrl: 'smba.trafficmanager.net', content: 'undefined', urlHash: undefined });
  assert.match(image.attachments[0].urlHash, /^[0-9a-f]{8}$/);
  assert.ok(!activityShape(load('message-personal-file')).includes('tempauth'));
  assert.equal(activityShape('x'), '"x"');
});

test('htmlTags: the markup without its text or values — a file embedded as markup is visible', () => {
  assert.deepEqual(htmlTags('<p>see <b>this</b></p><attachment id="abc-123"></attachment><img src="https://x.example/a.png" alt=\'p\' width=12/>'), ['p', 'b', 'attachment[id]', 'img[src,alt,width]']);
  assert.deepEqual(htmlTags('plain text'), []);
});

test('an emoji or sticker in the text (the client CDN) is not a file; a pasted image beside it is', () => {
  const emoji = { contentType: 'image/*', contentUrl: 'https://statics.teams.cdn.office.net/evergreen-assets/personal-expressions/v2/assets/emoticons/yes/default/20_f.png' };
  const pasted = load('message-channel-image').attachments![0]!;
  assert.deepEqual(teamsFiles([pasted, emoji]).map((f) => f.name), ['pasted-image-1.png']);
  assert.deepEqual(teamsFiles([emoji]), []);
  assert.equal(isClientAsset('not a url'), false);
});

// Graph's view of a channel message with a paperclip upload: the `reference` attachment the activity
// lacked, beside the card the bot itself posted (not a file).
const GRAPH_MESSAGE = {
  id: '1792149166061',
  attachments: [
    { id: 'e7b9', contentType: 'reference', contentUrl: 'https://example.sharepoint.example/sites/Platform/Shared Documents/General/IMG_0001.jpg', name: 'IMG_0001.jpg', content: null },
    { id: 'c0de', contentType: 'application/vnd.microsoft.card.adaptive', contentUrl: null, name: null, content: '{}' },
  ],
};
const GRAPH_ITEM = { name: 'IMG_0001.jpg', size: 4321, file: { mimeType: 'image/jpeg' }, '@microsoft.graph.downloadUrl': 'https://example.sharepoint.example/_layouts/download?tempauth=Y' };
function graphFetch(seen: string[], status = 200, emptyFirst = 0): typeof fetch {
  let reads = 0;
  return (async (url: string, init?: { headers?: Record<string, string> }) => {
    seen.push(`${url} ${init?.headers?.Authorization ?? ''}`);
    if (status !== 200) return { ok: false, status, json: async () => ({}) };
    if (url.includes('/shares/')) return { ok: true, status, json: async () => GRAPH_ITEM };
    // Teams delivers the activity before the upload is attached in Graph: the first reads see none.
    const body = reads++ < emptyFirst ? { ...GRAPH_MESSAGE, attachments: [] } : GRAPH_MESSAGE;
    return { ok: true, status, json: async () => body };
  }) as unknown as typeof fetch;
}
const noWait: Sleep = async () => {};

test('channelMessageFiles: a reply and a root message read back through Graph; only reference attachments are files', async () => {
  const seen: string[] = [];
  const reply = await channelMessageFiles({ groupId: 'g1', channelId: '19:CHANNEL1@thread.tacv2', rootId: '1792148920804', messageId: '1792149166061' }, 'GRAPH', graphFetch(seen), noWait);
  assert.deepEqual(reply, [{ kind: 'reference', name: 'IMG_0001.jpg', url: 'https://example.sharepoint.example/sites/Platform/Shared Documents/General/IMG_0001.jpg', mime: 'image/jpeg' }]);
  assert.equal(seen[0], 'https://graph.microsoft.com/v1.0/teams/g1/channels/19%3ACHANNEL1%40thread.tacv2/messages/1792148920804/replies/1792149166061?$select=id,attachments Bearer GRAPH');
  await channelMessageFiles({ groupId: 'g1', channelId: '19:CHANNEL1@thread.tacv2', rootId: '1792148920804', messageId: '1792148920804' }, 'GRAPH', graphFetch(seen), noWait);
  assert.ok(seen[1]!.startsWith('https://graph.microsoft.com/v1.0/teams/g1/channels/19%3ACHANNEL1%40thread.tacv2/messages/1792148920804?$select='));
  assert.deepEqual(await channelMessageFiles({ groupId: 'g1', channelId: 'c', rootId: '1', messageId: '2' }, 'GRAPH', graphFetch([], 403), noWait), []);
});

test('a channel message that arrived without files is read back through Graph once the core acts; a 1:1 and an activity with files are not', async () => {
  const seen: string[] = [];
  const fetchFn = graphFetch(seen);
  const reply = normalizeMessage(load('message-channel-reply'), TENANT, () => true, { ...tokens, fetch: fetchFn });
  assert.equal(reply.kind, 'message');
  if (reply.kind !== 'message') return;
  assert.equal(reply.msg.hasFiles, false);
  const got = await reply.msg.files();
  assert.deepEqual(got?.refs.map((r) => [r.name, r.url, r.mime, r.size, r.auth]), [['IMG_0001.jpg', 'https://example.sharepoint.example/_layouts/download?tempauth=Y', 'image/jpeg', 4321, 'none']]);
  assert.equal(seen.length, 2, 'the message, then its share');
  assert.ok(seen[0]!.includes('/replies/1792149166061?'));
  assert.ok(seen[1]!.includes('/shares/u!'));
  // A root mention: the message itself, not a reply.
  const mention = normalizeMessage(load('message-channel-mention'), TENANT, () => true, { ...tokens, fetch: graphFetch(seen) });
  if (mention.kind === 'mention') await mention.msg.files();
  assert.ok(seen[2]!.includes('/messages/1792148920804?$select='));
  // Nothing to read back: a 1:1 message, an activity that carried its files, no tokens at all.
  const dm = normalizeMessage(load('message-personal'), TENANT, () => true, { ...tokens, fetch: graphFetch(seen) });
  if (dm.kind === 'message') assert.equal(await dm.msg.files(), undefined);
  const withFile = normalizeMessage(load('message-channel-file'), TENANT, () => true, { ...tokens, fetch: graphFetch(seen) });
  if (withFile.kind === 'message') await withFile.msg.files();
  assert.equal(seen.filter((u) => u.includes('/messages/')).length, 2, 'no Graph read-back for the 1:1 or for the activity that carried its file');
  const noTokens = normalizeMessage(load('message-channel-reply'), TENANT);
  if (noTokens.kind === 'message') assert.equal(await noTokens.msg.files(), undefined);
});

test('read-back retries: the upload is attached in Graph after the activity — read again after the pauses, give up after the last', async () => {
  const waited: number[] = [];
  const wait: Sleep = async (ms) => {
    waited.push(ms);
  };
  const seen: string[] = [];
  const found = await channelMessageFiles({ groupId: 'g1', channelId: 'c', rootId: '1', messageId: '2' }, 'GRAPH', graphFetch(seen, 200, 2), wait);
  assert.equal(found.length, 1);
  assert.equal(seen.length, 3);
  assert.deepEqual(waited, READ_BACK_DELAYS_MS.slice(1));
  // Really no file: every attempt, then nothing.
  const none = await channelMessageFiles({ groupId: 'g1', channelId: 'c', rootId: '1', messageId: '2' }, 'GRAPH', graphFetch([], 200, 99), wait);
  assert.deepEqual(none, []);
  // Not found yet counts as "again", a refusal ends it.
  const seen404: string[] = [];
  assert.deepEqual(await channelMessageFiles({ groupId: 'g1', channelId: 'c', rootId: '1', messageId: '2' }, 'GRAPH', graphFetch(seen404, 404), wait), []);
  assert.equal(seen404.length, READ_BACK_DELAYS_MS.length);
  assert.deepEqual(READ_BACK_DELAYS_MS[0], 0);
});

test('read-back without aadGroupId in the activity: the group id comes from the Connector, once; none at all is a warning and no files', async () => {
  const a = load('message-channel-reply');
  const stripped: InboundActivity = { ...a, channelData: { team: { id: '19:TEAM1@thread.tacv2' } } };
  const asked: string[] = [];
  const seen: string[] = [];
  const tok = { ...tokens, fetch: graphFetch(seen), groupIdOf: async (id: string) => (asked.push(id), 'g-from-connector') };
  const m = normalizeMessage(stripped, TENANT, () => true, tok);
  if (m.kind !== 'message') throw new Error(m.kind);
  const got = await m.msg.files();
  assert.equal(got?.refs.length, 1);
  assert.deepEqual(asked, ['19:TEAM1@thread.tacv2']);
  assert.ok(seen[0]!.includes('/teams/g-from-connector/channels/'));
  const none = normalizeMessage(stripped, TENANT, () => true, { ...tokens, fetch: graphFetch(seen) });
  if (none.kind === 'message') assert.equal(await none.msg.files(), undefined);
  assert.equal(seen.length, 2, 'no Graph call without a group id');
});
