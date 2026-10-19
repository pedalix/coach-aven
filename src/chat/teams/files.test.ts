// Inbound files: the three Teams shapes over the recorded fixtures → refs for the ingest
// pipeline, with the right auth per source; Graph answered by a fake fetch.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { activityShape, htmlTags, hydrateTeamsFiles, isClientAsset, resolveShare, shareId, teamsFiles } from './files.js';
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
