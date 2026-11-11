// Outbound files on the web (outbound-files): the agent's files are stored like a person's uploads in the
// conversation's folder, posted as one bot message carrying them, rendered as downloads — images inline.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { History } from './history.js';
import { webDriver, WEB_CAPABILITIES } from './driver.js';
import { findUpload } from './files.js';
import { messageBody } from './pages.js';

test('postFiles — stored beside the conversation, one post in the thread, an image inline and a CSV as a download', async () => {
  const root = mkdtempSync(join(tmpdir(), 'aven-web-outbox-'));
  const history = new History(root);
  let n = 0;
  const d = webDriver({ history, baseUrl: 'http://x', nameOf: () => undefined, ids: () => `m${++n}`, filesRoot: root });
  assert.equal(WEB_CAPABILITIES.outboundFiles, true);
  await d.postFiles({ conv: 'room:alpha', thread: 'm0' }, [
    { name: 'chart.png', mime: 'image/png', data: Buffer.from('png') },
    { name: 'orders.csv', mime: 'text/csv', data: Buffer.from('a,b\n') },
  ]);
  const m = history.conversation('room:alpha').message('m1');
  assert.ok(m, 'one message');
  assert.equal(m.thread, 'm0');
  assert.equal(m.by, undefined, 'the bot\'s');
  assert.deepEqual(m.files?.map((f) => [f.name, f.size]), [['chart.png', 3], ['orders.csv', 4]]);
  for (const f of m.files ?? []) assert.ok(findUpload(root, 'alpha', f.id, 'anyone'), `${f.name} is served by the download route's lookup`);
  const body = messageBody(m, () => undefined, 'alpha');
  const html = String(body.html);
  assert.match(html, /<li class="file-image"><a href="\/files\/alpha\/f[0-9a-z]+"><img src="\/files\/alpha\/f[0-9a-z]+" alt="chart.png" loading="lazy"><\/a> <span class="meta">chart\.png · 3 B<\/span><\/li>/);
  assert.match(html, /<li><a href="\/files\/alpha\/f[0-9a-z]+">📎 orders\.csv<\/a> <span class="meta">4 B<\/span><\/li>/);
  assert.equal(body.text, '📎 chart.png, orders.csv');
});

test('postFiles — a private conversation keeps the file private; no files root is a loud error', async () => {
  const root = mkdtempSync(join(tmpdir(), 'aven-web-outbox-'));
  const history = new History(root);
  const d = webDriver({ history, baseUrl: 'http://x', nameOf: () => undefined, ids: () => 'm1', filesRoot: root });
  await d.postFiles({ conv: 'pc:u1:alpha' }, [{ name: 'notes.md', mime: 'text/markdown', data: Buffer.from('# hi') }]);
  const m = history.conversation('pc:u1:alpha').message('m1');
  const id = m!.files![0].id;
  assert.ok(findUpload(root, 'alpha', id, 'u1'));
  assert.equal(findUpload(root, 'alpha', id, 'u2'), undefined);
  const bare = webDriver({ history, baseUrl: 'http://x', nameOf: () => undefined });
  await assert.rejects(bare.postFiles({ conv: 'room:alpha' }, [{ name: 'a.txt', mime: 'text/plain', data: Buffer.from('a') }]), /no files root/);
});
