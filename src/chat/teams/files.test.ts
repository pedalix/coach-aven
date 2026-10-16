// Inbound files: the three Teams shapes over the recorded fixtures → refs for the ingest
// pipeline, with the right auth per source; Graph answered by a fake fetch.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { hydrateTeamsFiles, resolveShare, shareId, teamsFiles } from './files.js';
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
