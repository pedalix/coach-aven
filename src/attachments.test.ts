import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  sanitizeName,
  isSupported,
  inboxPath,
  planIngest,
  attachmentPreamble,
  MAX_BYTES,
  MAX_FILES,
  type AttachmentRef,
} from './attachments.js';

const ref = (over: Partial<AttachmentRef> = {}): AttachmentRef => ({
  name: 'a.png',
  url: 'https://x/a',
  mime: 'image/png',
  size: 1000,
  ...over,
});

test('sanitizeName: strips path components (traversal defense)', () => {
  assert.equal(sanitizeName('../../etc/passwd'), 'passwd');
  assert.equal(sanitizeName('/root/.gh-token'), 'gh-token'); // leading dot trimmed
  assert.equal(sanitizeName('a/b/c/shot.png'), 'shot.png');
  assert.equal(sanitizeName('..\\..\\windows\\evil.exe'), 'evil.exe');
});

test('sanitizeName: normalizes unsafe chars, dedupes, and has a fallback', () => {
  assert.equal(sanitizeName('my report (final).pdf'), 'my_report_final_.pdf');
  assert.equal(sanitizeName(''), 'file');
  assert.equal(sanitizeName('..'), 'file');
  assert.equal(sanitizeName('   '), 'file');
});

test('sanitizeName: caps length but keeps the extension', () => {
  const out = sanitizeName('x'.repeat(200) + '.png');
  assert.ok(out.length <= 120);
  assert.ok(out.endsWith('.png'));
});

test('isSupported: images, pdfs, text, and docs in; av/archives out', () => {
  assert.equal(isSupported('image/png', 'a.png'), true);
  assert.equal(isSupported('application/pdf', 'a.pdf'), true);
  assert.equal(isSupported('text/plain', 'a.txt'), true);
  assert.equal(isSupported('application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'a.docx'), true);
  assert.equal(isSupported('video/quicktime', 'clip.mov'), false);
  assert.equal(isSupported('audio/mpeg', 'v.mp3'), false);
  assert.equal(isSupported('application/zip', 'a.zip'), false);
  // octet-stream → fall back to extension
  assert.equal(isSupported('application/octet-stream', 'shot.jpeg'), true);
  assert.equal(isSupported('application/octet-stream', 'a.pdf'), true);
  assert.equal(isSupported('application/octet-stream', 'a.bin'), false);
});

test('inboxPath: per-turn dir, indexed, sanitized', () => {
  assert.equal(inboxPath('t7', 2, '../evil.png'), '/root/inbox/t7/2-evil.png');
});

test('planIngest: filters by type and size, records reasons', () => {
  const { accept, skipped } = planIngest([
    ref({ name: 'ok.png' }),
    ref({ name: 'big.pdf', mime: 'application/pdf', size: MAX_BYTES + 1 }),
    ref({ name: 'clip.mov', mime: 'video/quicktime' }),
  ]);
  assert.deepEqual(accept.map((r) => r.name), ['ok.png']);
  assert.deepEqual(
    skipped.map((s) => s.name),
    ['big.pdf', 'clip.mov'],
  );
  assert.ok(skipped[0].reason.includes('large'));
  assert.ok(skipped[1].reason.includes('unsupported'));
});

test('planIngest: enforces the per-turn count cap', () => {
  const many = Array.from({ length: MAX_FILES + 3 }, (_, i) => ref({ name: `f${i}.png` }));
  const { accept, skipped } = planIngest(many);
  assert.equal(accept.length, MAX_FILES);
  assert.equal(skipped.length, 3);
  assert.ok(skipped.every((s) => s.reason.includes('limit')));
});

test('planIngest: size 0 (unreported) is allowed through', () => {
  const { accept } = planIngest([ref({ size: 0 })]);
  assert.equal(accept.length, 1);
});

test('attachmentPreamble: empty when nothing kept or skipped', () => {
  assert.equal(attachmentPreamble([], []), '');
});

test('attachmentPreamble: lists kept paths and skipped reasons', () => {
  const out = attachmentPreamble(
    [{ path: '/root/inbox/t1/1-a.png', name: 'a.png' }],
    [{ name: 'b.mov', reason: 'unsupported type' }],
  );
  assert.ok(out.includes('/root/inbox/t1/1-a.png'));
  assert.ok(out.includes('Read them'));
  assert.ok(out.includes('b.mov — unsupported type'));
});
