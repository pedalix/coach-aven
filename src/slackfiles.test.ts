import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toSlackFile, extractSlackFiles, hydrateSlackFiles, type SlackFile } from './slackfiles.js';

// A full same-workspace file object, as Slack sends it in non-Connect channels.
const full = {
  id: 'F1',
  name: 'shot.png',
  mimetype: 'image/png',
  size: 1234,
  url_private: 'https://files.slack.com/priv/shot.png',
  url_private_download: 'https://files.slack.com/dl/shot.png',
};

// The Slack Connect tombstone, verbatim shape from the prod event log (2026-07-14).
const tombstone = { id: 'F0BGSK9KX55', file_access: 'check_file_info', created: 0, timestamp: 0, user: '', filetype: 'json' };

test('toSlackFile: prefers url_private_download, keeps name/mime/size', () => {
  const s = toSlackFile(full)!;
  assert.equal(s.url, full.url_private_download);
  assert.equal(s.name, 'shot.png');
  assert.equal(s.mime, 'image/png');
  assert.equal(s.size, 1234);
});

test('toSlackFile: falls back to url_private, then title for the name', () => {
  const s = toSlackFile({ url_private: 'https://x/p', title: 'titled' })!;
  assert.equal(s.url, 'https://x/p');
  assert.equal(s.name, 'titled');
});

test('toSlackFile: Connect tombstone kept with empty url and an id-derived name', () => {
  const s = toSlackFile(tombstone)!;
  assert.equal(s.url, '');
  assert.equal(s.id, 'F0BGSK9KX55');
  assert.equal(s.name, 'F0BGSK9KX55.json');
});

test('extractSlackFiles: drops true junk (no url, no id) but keeps tombstones', () => {
  const out = extractSlackFiles([full, tombstone, { name: 'external-link-only' }, null]);
  assert.deepEqual(out.map((f) => f.id), ['F1', 'F0BGSK9KX55']);
});

test('hydrateSlackFiles: url-bearing refs pass through without calling files.info', async () => {
  let calls = 0;
  const out = await hydrateSlackFiles(extractSlackFiles([full]), async () => {
    calls++;
    return null;
  });
  assert.equal(calls, 0);
  assert.equal(out[0].url, full.url_private_download);
});

test('hydrateSlackFiles: resolves tombstones via files.info', async () => {
  const out = await hydrateSlackFiles(extractSlackFiles([tombstone]), async (id) => ({
    id,
    name: 'trip-response.json',
    mimetype: 'application/json',
    size: 42,
    url_private_download: `https://files.slack.com/dl/${id}`,
  }));
  assert.equal(out.length, 1);
  assert.equal(out[0].name, 'trip-response.json');
  assert.equal(out[0].mime, 'application/json');
  assert.equal(out[0].url, 'https://files.slack.com/dl/F0BGSK9KX55');
});

test('hydrateSlackFiles: lookup failure keeps the url-less ref (skipped downstream, not vanished)', async () => {
  const denied = { id: 'F2', file_access: 'access_denied', filetype: 'json' }; // still no url
  const cases: [SlackFile[], Parameters<typeof hydrateSlackFiles>[1]][] = [
    [extractSlackFiles([tombstone]), async () => null], // info returned nothing
    [extractSlackFiles([tombstone]), async () => Promise.reject(new Error('boom'))], // info threw
    [extractSlackFiles([tombstone]), async () => denied], // access denied → still url-less
  ];
  for (const [files, info] of cases) {
    const out = await hydrateSlackFiles(files, info);
    assert.equal(out.length, 1);
    assert.equal(out[0].url, '');
    assert.equal(out[0].name, 'F0BGSK9KX55.json');
  }
});
