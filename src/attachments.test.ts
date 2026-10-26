import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  sanitizeName,
  isSupported,
  isImage,
  needsResize,
  inboxPath,
  planIngest,
  attachmentPreamble,
  skippedNotice,
  downloadHeaders,
  MAX_BYTES,
  MAX_FILES,
  MAX_IMAGE_DIM,
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

test('planIngest: url-less ref (failed Connect hydration) skipped with an access reason', () => {
  const { accept, skipped } = planIngest([ref({ name: 'F1.json', url: '', mime: '' })]);
  assert.equal(accept.length, 0);
  assert.deepEqual(skipped, [{ name: 'F1.json', reason: 'file access not granted' }]);
});

test('planIngest: size 0 (unreported) is allowed through', () => {
  const { accept } = planIngest([ref({ size: 0 })]);
  assert.equal(accept.length, 1);
});

test('isImage: raster images yes; svg/pdf/text no; octet-stream by extension', () => {
  assert.equal(isImage('image/png', 'a.png'), true);
  assert.equal(isImage('image/jpeg', 'a.jpg'), true);
  assert.equal(isImage('image/heic', 'a.heic'), true);
  assert.equal(isImage('image/svg+xml', 'a.svg'), false); // svg is text, read as-is
  assert.equal(isImage('application/pdf', 'a.pdf'), false);
  assert.equal(isImage('text/plain', 'a.txt'), false);
  assert.equal(isImage('application/octet-stream', 'shot.PNG'), true);
  assert.equal(isImage('application/octet-stream', 'a.pdf'), false);
});

test('needsResize: only when a dimension exceeds the cap', () => {
  assert.equal(needsResize(2905, 1549), true); // the art screenshot
  assert.equal(needsResize(MAX_IMAGE_DIM, MAX_IMAGE_DIM), false); // exactly at cap
  assert.equal(needsResize(MAX_IMAGE_DIM + 1, 10), true);
  assert.equal(needsResize(10, MAX_IMAGE_DIM + 1), true);
  assert.equal(needsResize(800, 600), false);
  assert.equal(needsResize(4000, 3000, 2000), true); // custom cap
});

test('attachmentPreamble: empty when nothing kept or skipped', () => {
  assert.equal(attachmentPreamble([], []), '');
});

test('attachmentPreamble: surfaces pre-scale warnings', () => {
  const out = attachmentPreamble(
    [{ path: '/root/inbox/t1/1-a.heic', name: 'a.heic' }],
    [],
    ["a.heic couldn't be pre-scaled"],
  );
  assert.ok(out.includes('/root/inbox/t1/1-a.heic'));
  assert.ok(out.includes("Note: a.heic couldn't be pre-scaled"));
});

test('skippedNotice: empty when nothing skipped', () => {
  assert.equal(skippedNotice([]), '');
});

test('skippedNotice: expands known reasons to actionable text, passes unknown ones through', () => {
  const out = skippedNotice([
    { name: 'clip.mov', reason: 'unsupported type' },
    { name: 'big.pdf', reason: 'too large' },
    { name: 'F1.json', reason: 'file access not granted' },
    { name: 'x.png', reason: `over the ${MAX_FILES}-file limit` },
  ]);
  assert.ok(out.includes('`clip.mov`') && out.includes('unsupported file type'));
  assert.ok(out.includes('`big.pdf`') && out.includes('25 MB'));
  assert.ok(out.includes('`F1.json`') && out.includes('Slack Connect'));
  assert.ok(out.includes('`x.png`') && out.includes(`${MAX_FILES}-file limit`));
  assert.ok(out.startsWith('📎'));
});

test('skippedNotice: singular phrasing for one file', () => {
  assert.ok(skippedNotice([{ name: 'a.mov', reason: 'unsupported type' }]).includes('this file'));
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

test('downloadHeaders: the bearer goes with every ref except a pre-authorized one', () => {
  const ref = { name: 'a.pdf', url: 'https://files.example/a', mime: 'application/pdf', size: 1 };
  assert.deepEqual(downloadHeaders(ref, 'tok'), { Authorization: 'Bearer tok' });
  assert.deepEqual(downloadHeaders({ ...ref, auth: 'bearer' }, 'tok'), { Authorization: 'Bearer tok' });
  assert.deepEqual(downloadHeaders({ ...ref, auth: 'none' }, 'tok'), {});
});

test('a file: reference is read from disk under the size cap (the web chat\'s uploads); a missing file is a skipped download', async () => {
  const { downloadAttachment, MAX_BYTES } = await import('./attachments.js');
  const { mkdtempSync, writeFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const { pathToFileURL } = await import('node:url');
  const dir = mkdtempSync(join(tmpdir(), 'aven-att-'));
  const small = join(dir, 'notes.md');
  writeFileSync(small, '# hi');
  const buf = await downloadAttachment({ name: 'notes.md', url: pathToFileURL(small).href, mime: 'text/markdown', size: 4, auth: 'none' }, '');
  assert.equal(buf?.toString(), '# hi');
  const gone = await downloadAttachment({ name: 'gone.md', url: pathToFileURL(join(dir, 'gone.md')).href, mime: 'text/markdown', size: 0, auth: 'none' }, '');
  assert.equal(gone, null);
  assert.ok(MAX_BYTES > 0);
});
