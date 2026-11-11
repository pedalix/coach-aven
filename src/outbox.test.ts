import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  OVER_COUNT,
  collectOutbox,
  isTextFile,
  listScript,
  outboxDir,
  outboxFailedNotice,
  outboxMarkedNotice,
  outboxPreamble,
  outboxSkippedNotice,
  parseListing,
  planOutbox,
  readScript,
  removeScript,
} from './outbox.js';
import { MAX_BYTES, MAX_FILES } from './attachments.js';

test('scripts — byte-exact, quoted, a missing directory lists nothing and exits 0', () => {
  assert.equal(outboxDir('t0-1'), '/root/outbox/t0-1');
  assert.equal(
    listScript('/root/outbox/t0-1'),
    `test -d '/root/outbox/t0-1' && cd '/root/outbox/t0-1' && for f in * .*; do [ -f "$f" ] && printf '%s\\t%s\\n' "$(wc -c < "$f")" "$f"; done; true`,
  );
  assert.equal(readScript("/root/outbox/t0-1/it's.png"), `base64 -w0 '/root/outbox/t0-1/it'\\''s.png'`);
  assert.equal(removeScript('/root/outbox/t0-1'), `rm -rf '/root/outbox/t0-1'`);
});

test('parseListing — size TAB name per line; a tab in the name survives, junk lines are dropped', () => {
  assert.deepEqual(parseListing('1000\tchart.png\n5\ta\tb.txt\n\nfind: oops\nx\tno-size\n0\tempty.csv\n'), [
    { name: 'chart.png', size: 1000 },
    { name: 'a\tb.txt', size: 5 },
    { name: 'empty.csv', size: 0 },
  ]);
  assert.deepEqual(parseListing(''), []);
});

test('planOutbox — the inbound allowlist and caps, name order, empty files ignored, paths kept as listed', () => {
  const dir = '/root/outbox/t0-1';
  const { accept, skipped } = planOutbox(dir, [
    { name: 'clip.mov', size: 5 },
    { name: 'chart.png', size: 1000 },
    { name: 'empty.txt', size: 0 },
    { name: 'report.pdf', size: MAX_BYTES + 1 },
    { name: 'Weird name (1).CSV', size: 12 },
    { name: 'page.html', size: 40 },
  ]);
  assert.deepEqual(
    accept.map((f) => [f.name, f.path, f.mime]),
    [
      ['Weird_name_1_.CSV', `${dir}/Weird name (1).CSV`, 'text/csv'],
      ['chart.png', `${dir}/chart.png`, 'image/png'],
      ['page.html', `${dir}/page.html`, 'text/html'],
    ],
  );
  assert.deepEqual(skipped, [
    { name: 'clip.mov', reason: 'unsupported type' },
    { name: 'report.pdf', reason: 'too large' },
  ]);
});

test('planOutbox — eleven files: ten go, the eleventh is named as over the limit', () => {
  const entries = Array.from({ length: MAX_FILES + 1 }, (_, i) => ({ name: `f${String(i).padStart(2, '0')}.txt`, size: 1 }));
  const { accept, skipped } = planOutbox('/d', entries);
  assert.equal(accept.length, MAX_FILES);
  assert.deepEqual(skipped, [{ name: `f${MAX_FILES}.txt`, reason: OVER_COUNT }]);
});

test('isTextFile — text, json and yaml are scrubbed; images, pdf and office documents are not', () => {
  for (const m of ['text/plain', 'text/csv', 'text/markdown', 'application/json', 'application/yaml']) assert.equal(isTextFile(m), true, m);
  for (const m of ['image/png', 'application/pdf', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet']) assert.equal(isTextFile(m), false, m);
});

// A scripted sandbox: the listing, one base64 answer per path, and every command recorded.
function fakeExec(listing: string, bytes: Record<string, Buffer | 'fail'>) {
  const calls: string[] = [];
  const exec = async (cmd: string) => {
    calls.push(cmd);
    if (cmd.startsWith('test -d')) return { exitCode: 0, result: listing };
    if (cmd.startsWith('base64 -w0 ')) {
      const path = cmd.slice('base64 -w0 '.length).replace(/^'|'$/g, '').replace(/'\\''/g, "'");
      const b = bytes[path];
      if (!b || b === 'fail') return { exitCode: 1, result: 'base64: No such file' };
      return { exitCode: 0, result: b.toString('base64') + '\n' };
    }
    return { exitCode: 0, result: '' };
  };
  return { exec, calls };
}

test('collectOutbox — reads the accepted files, scrubs a token in a log, names the refused, removes the directory', async () => {
  const token = `ghp_${'A'.repeat(36)}`;
  const { exec, calls } = fakeExec('1000\tchart.png\n5\tclip.mov\n60\tdebug.log\n', {
    '/root/outbox/t0-1/chart.png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2]),
    '/root/outbox/t0-1/debug.log': Buffer.from(`token=${token}\nok\n`),
  });
  const { files, skipped } = await collectOutbox(exec, 't0-1', { scrub: true });
  assert.deepEqual(
    files.map((f) => [f.name, f.mime]),
    [
      ['chart.png', 'image/png'],
      ['debug.log', 'text/plain'],
    ],
  );
  assert.deepEqual([...files[0].data], [0x89, 0x50, 0x4e, 0x47, 0, 1, 2], 'binary bytes round-trip untouched');
  const log = files[1].data.toString('utf8');
  assert.ok(!log.includes(token), 'the token is gone');
  assert.ok(log.endsWith('ok\n'), 'the rest of the file stands');
  assert.deepEqual(skipped, [{ name: 'clip.mov', reason: 'unsupported type' }]);
  assert.equal(calls.at(-1), `rm -rf '/root/outbox/t0-1'`, 'drained after the read');
});

test('collectOutbox — the project opted out of the scrub: the file is posted as written', async () => {
  const token = `ghp_${'B'.repeat(36)}`;
  const { exec } = fakeExec('50\tnotes.md\n', { '/root/outbox/t0-2/notes.md': Buffer.from(`# ${token}\n`) });
  const { files } = await collectOutbox(exec, 't0-2', { scrub: false });
  assert.equal(files[0].data.toString('utf8'), `# ${token}\n`);
});

test('collectOutbox — nothing saved: one listing, no removal, nothing to say', async () => {
  const { exec, calls } = fakeExec('', {});
  assert.deepEqual(await collectOutbox(exec, 't0-3', { scrub: true }), { files: [], skipped: [] });
  assert.equal(calls.length, 1);
});

test('collectOutbox — a file that cannot be read back is named; a sandbox that throws is one skipped entry, never a throw', async () => {
  const { exec } = fakeExec('10\ta.txt\n10\tb.txt\n', { '/root/outbox/t0-4/a.txt': Buffer.from('hello'), '/root/outbox/t0-4/b.txt': 'fail' });
  const r = await collectOutbox(exec, 't0-4', { scrub: true });
  assert.deepEqual(r.files.map((f) => f.name), ['a.txt']);
  assert.deepEqual(r.skipped, [{ name: 'b.txt', reason: 'read failed' }]);
  const boom = await collectOutbox(async () => Promise.reject(new Error('sandbox gone')), 't0-5', { scrub: true });
  assert.deepEqual(boom, { files: [], skipped: [{ name: 'outbox', reason: 'read failed' }] });
});

test('texts — the per-turn line names the directory; the notices are deterministic and friendly', () => {
  assert.equal(outboxPreamble('t0-1'), 'Outbox for this turn: /root/outbox/t0-1/ — a file you save there is posted into this conversation right after your answer.');
  assert.equal(outboxSkippedNotice([]), '');
  const n = outboxSkippedNotice([
    { name: 'clip.mov', reason: 'unsupported type' },
    { name: 'big.pdf', reason: 'too large' },
    { name: 'k.txt', reason: OVER_COUNT },
    { name: 'x.txt', reason: 'read failed' },
  ]);
  assert.match(n, /^📎 Sorry — I couldn't post these files:\n/);
  assert.match(n, /`clip\.mov` — not a file type I can post/);
  assert.match(n, /`big\.pdf` — over my 25 MB per-file limit/);
  assert.match(n, /`k\.txt` — more than 10 files in one turn/);
  assert.match(n, /`x\.txt` — I could not read it back from the sandbox/);
  assert.equal(outboxSkippedNotice([{ name: 'a', reason: 'odd' }]), "📎 Sorry — I couldn't post this file:\n• `a` — odd");
  assert.equal(outboxFailedNotice(['a.png', 'b.csv'], 'not_in_channel'), '⚠️ Couldn\'t post `a.png`, `b.csv` — not_in_channel');
  assert.match(outboxMarkedNotice(['chart.png']), /^📎 I produced `chart\.png` but can't attach files in this thread — it carries another domain's data/);
});
