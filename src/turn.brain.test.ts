// Company brain at the end of a turn (OpenSpec company-brain, tasks 2.2): the hook the turn engine calls after
// every answer — mirror, then the index and the lint in brain/<slug>/ — over the real mirror and a fake sandbox.
// That the engine calls it is pinned where the engine is driven (src/chat/slack/turn.record.test.ts).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { memoryRepoDir, mirrorMemory, type MirrorExec } from './memjournal.js';
import { brainAfterTurn, brainProjectDir, readAnswers, readIndex, readLint, readUses, type BrainTurn } from './brain/store.js';

const DIR = mkdtempSync(join(tmpdir(), 'aven-brain-'));
const prev = process.env.AVEN_DIR;
before(() => void (process.env.AVEN_DIR = DIR));
after(() => {
  if (prev === undefined) delete process.env.AVEN_DIR;
  else process.env.AVEN_DIR = prev;
  rmSync(DIR, { recursive: true, force: true });
});

const turn = (turnId: string, over: Partial<BrainTurn> = {}): BrainTurn => ({ turnId, key: 'thread:1', by: 'person', question: 'q', answer: 'a', logAnswer: true, ...over });
const sha = (s: string): string => createHash('sha256').update(s).digest('hex');
function session(slug: string, files: Record<string, string>, fail = false, reads: string[] = []) {
  const exec: MirrorExec = async (command) => {
    if (fail) return { exitCode: 1, result: '' };
    if (command.includes('base64 -w0')) {
      const names = [.../'([^']+)'/g[Symbol.matchAll](/for f in (.*?); do/.exec(command)![1])].map((m) => m[1]);
      return { exitCode: 0, result: names.map((n) => `${n} ${Buffer.from(files[n]).toString('base64')}\n`).join('') };
    }
    return { exitCode: 0, result: Object.entries(files).map(([n, c]) => `${sha(c)}  ${n}`).join('\n') };
  };
  return { mirrorMemory: (message: string) => mirrorMemory(exec, memoryRepoDir(slug), '/mem', message), memoryReads: () => reads };
}

test('a turn that changed records: the journal has them, the index lists them, the lint reports what is wrong', async () => {
  const files: Record<string, string> = {
    'MEMORY.md': '- [GLACIER-12](glacier-12.md)\n',
    'glacier-12.md': '---\nname: Voucher counted twice\nkind: investigation\nticket: GLACIER-12\n---\nMarch export.\n',
  };
  const m = await brainAfterTurn(session('skishop', files), 'skishop', turn('t1'), new Date('2026-05-01T08:00:00.000Z'));
  assert.deepEqual(m?.changed, ['MEMORY.md', 'glacier-12.md']);
  const index = await readIndex('skishop');
  assert.deepEqual(index?.records.map((r) => [r.name, r.kind, r.ticket]), [['glacier-12.md', 'investigation', 'GLACIER-12']]);
  assert.deepEqual((await readLint('skishop'))?.map((f) => f.code), ['no-status']);

  // The next turn fixes it: the lint is clean, and the record keeps the day the host first saw it.
  files['glacier-12.md'] = files['glacier-12.md'].replace('kind: investigation', 'kind: investigation\nstatus: open');
  await brainAfterTurn(session('skishop', files), 'skishop', turn('t2'), new Date('2026-05-03T08:00:00.000Z'));
  const next = await readIndex('skishop');
  assert.deepEqual([next?.records[0].status, next?.records[0].firstSeen, next?.records[0].lastChange], ['open', '2026-05-01T08:00:00.000Z', '2026-05-03T08:00:00.000Z']);
  assert.deepEqual(await readLint('skishop'), []);
});

test('the mirror fails: nothing is thrown, nothing is written for that project', async () => {
  assert.equal(await brainAfterTurn(session('nomirror', { 'a.md': 'A\n' }, true), 'nomirror', turn('t1')), undefined);
  assert.equal(existsSync(brainProjectDir('nomirror')), false);
});

test('a project with no memory yet, and a session that cannot mirror: no brain directory', async () => {
  await brainAfterTurn(session('empty', {}), 'empty', turn('t1'));
  assert.equal(await brainAfterTurn({}, 'empty', turn('t2')), undefined);
  assert.equal(existsSync(brainProjectDir('empty')), false);
});

test('the index file is plain JSON a person can read, and holds no record text', () => {
  const raw = readFileSync(join(brainProjectDir('skishop'), 'index.json'), 'utf8');
  assert.ok(raw.endsWith('\n'));
  assert.ok(!raw.includes('March export'));
});

// ── the use log, provenance and the answer log (tasks 3.2, 4.2) ─────────────────────────────────────────────────
const SHOP: Record<string, string> = {
  'MEMORY.md': '- [a](glacier-12.md)\n- [b](counting.md)\n',
  'glacier-12.md': '---\nkind: investigation\nstatus: open\nticket: GLACIER-12\n---\nMarch export.\n',
  'counting.md': '---\nkind: method\n---\nCount paid lines.\n',
};

test('a person\'s turn about a ticket: a use entry with names only, an answer entry with the text, the asker and the link', async () => {
  const files = { ...SHOP };
  await brainAfterTurn(session('logs', files, false, ['counting.md', 'glacier-12.md']), 'logs', turn('t0', { by: 'routine', key: 'routine:r1' }), new Date('2026-05-01T08:00:00.000Z'));
  await brainAfterTurn(
    session('logs', files, false, ['glacier-12.md', 'counting.md']),
    'logs',
    turn('t1', { asker: 'U1', question: 'Why twice?', answer: 'The export joins twice.', link: 'https://chat.example/t/1' }),
    new Date('2026-05-02T08:00:00.000Z'),
  );
  const uses = await readUses('logs');
  assert.deepEqual(uses.map((u) => [u.turnId, u.by, u.read, u.changed]), [
    ['t0', 'routine', [], ['counting.md', 'glacier-12.md']],
    ['t1', 'person', ['counting.md', 'glacier-12.md'], []],
  ]);
  assert.ok(!JSON.stringify(uses).includes('export'), 'the use log holds no text');
  // The routine's report that wrote the record is an answer too (the nightly tidy's own answer is never logged: pollers.ts).
  assert.deepEqual((await readAnswers('logs')).slice(1), [
    { at: '2026-05-02T08:00:00.000Z', key: 'thread:1', turnId: 't1', asker: 'U1', question: 'Why twice?', answer: 'The export joins twice.', records: ['glacier-12.md'], tickets: ['GLACIER-12'], link: 'https://chat.example/t/1' },
  ]);
});

test('the person replies and the method record changes: the index says revised after a reply; the routine\'s write did not count', async () => {
  const files = { ...SHOP, 'counting.md': '---\nkind: method\n---\nCount paid lines, without annual passes.\n' };
  await brainAfterTurn(session('logs', files, false, ['counting.md']), 'logs', turn('t2', { asker: 'U1' }), new Date('2026-05-03T08:00:00.000Z'));
  const by = Object.fromEntries((await readIndex('logs'))!.records.map((r) => [r.name, r.provenance]));
  assert.deepEqual(by['counting.md'], { uses: 2, lastUsed: '2026-05-03T08:00:00.000Z', revisedAfterReply: '2026-05-03T08:00:00.000Z' });
  assert.deepEqual(by['glacier-12.md'], { uses: 1, lastUsed: '2026-05-02T08:00:00.000Z' });
  // That turn touched only a method record: the answer log did not grow.
  assert.equal((await readAnswers('logs')).length, 2);
});

test('a marked or shadow conversation: the use is logged (names only), the answer is not', async () => {
  await brainAfterTurn(session('marked', { ...SHOP }, false, ['glacier-12.md']), 'marked', turn('t1', { logAnswer: false }));
  assert.equal((await readUses('marked')).length, 1);
  assert.deepEqual(await readAnswers('marked'), []);
});

test('a turn that named no record: nothing is logged — not even at the first mirror, which holds every record', async () => {
  await brainAfterTurn(session('quiet', { ...SHOP }), 'quiet', turn('t1'));
  await brainAfterTurn(session('quiet', { ...SHOP }), 'quiet', turn('t2'));
  assert.deepEqual(await readUses('quiet'), []);
  assert.equal((await readIndex('quiet'))!.records.length, 2, 'the index is built all the same');
});

test('another conversation changed a record meanwhile: the turn that ends first is not credited with it', async () => {
  const files = { ...SHOP };
  await brainAfterTurn(session('race', files), 'race', turn('t0'));
  // Thread 2 rewrote the method record; thread 1's turn, which only read the ticket's record, ends first.
  files['counting.md'] = '---\nkind: method\n---\nCount paid lines only.\n';
  const m = await brainAfterTurn(session('race', files, false, ['glacier-12.md']), 'race', turn('t1'));
  assert.deepEqual(m!.changed, ['counting.md'], 'the mirror took the change');
  assert.deepEqual((await readUses('race')).map((u) => [u.turnId, u.read, u.changed]), [['t1', ['glacier-12.md'], []]]);
});
