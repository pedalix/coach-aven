import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { attachmentDisposition, filesDir, findUpload, fmtSize, mimeOf, storeUpload, toRef } from './files.js';

test('an upload is stored beside its conversation under a sanitized name and found by id — a private upload only by its owner', () => {
  const root = mkdtempSync(join(tmpdir(), 'aven-web-files-'));
  const f = storeUpload(root, 'room:alpha', '../../etc/passwd shot (1).png', Buffer.from('png'));
  assert.equal(f.name, 'passwd_shot_1_.png'); // the last path segment, sanitized (attachments.ts)
  assert.match(f.id, /^f[0-9a-z]+$/);
  assert.ok(f.path.startsWith(join(root, 'alpha', 'files', 'room')));
  assert.equal(readFileSync(f.path, 'utf8'), 'png');
  assert.deepEqual(findUpload(root, 'alpha', f.id, 'anyone'), f);
  const p = storeUpload(root, 'pc:u1:alpha', 'notes.md', Buffer.from('# hi'));
  assert.equal(findUpload(root, 'alpha', p.id, 'u1')?.name, 'notes.md');
  assert.equal(findUpload(root, 'alpha', p.id, 'u2'), undefined);
  assert.equal(findUpload(root, 'alpha', '../room', 'u1'), undefined);
  assert.equal(findUpload(root, 'alpha', 'fnope', 'u1'), undefined);
  assert.equal(filesDir(root, 'C123'), undefined);
  assert.throws(() => storeUpload(root, 'C123', 'x', Buffer.alloc(0)), /not a web conversation/);
});

test('the turn gets a file: reference without a bearer; media types come from the extension', () => {
  const root = mkdtempSync(join(tmpdir(), 'aven-web-files-'));
  const f = storeUpload(root, 'room:alpha', 'Report.PDF', Buffer.from('%PDF'));
  const ref = toRef(f);
  assert.equal(ref.auth, 'none');
  assert.ok(ref.url.startsWith('file:///'));
  assert.deepEqual([ref.name, ref.mime, ref.size], ['Report.PDF', 'application/pdf', 4]);
  assert.equal(mimeOf('x.unknownext'), 'application/octet-stream');
  assert.equal(mimeOf('a.JPG'), 'image/jpeg');
});

test('download headers and sizes', () => {
  assert.equal(attachmentDisposition('résumé "v2".pdf'), 'attachment; filename="r_sum_ _v2_.pdf"; filename*=UTF-8\'\'r%C3%A9sum%C3%A9%20%22v2%22.pdf');
  assert.equal(fmtSize(900), '900 B');
  assert.equal(fmtSize(12 * 1024), '12 KB');
  assert.equal(fmtSize(3.4 * 1024 * 1024), '3.4 MB');
});
