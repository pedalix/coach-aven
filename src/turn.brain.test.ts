// Company brain at the end of a turn (OpenSpec company-brain, tasks 2.2): the hook the turn engine calls under
// BRAIN=1 — mirror, then the index and the lint in brain/<slug>/ — over the real mirror and a fake sandbox. That
// the engine calls it only with the flag is pinned where the engine is driven (src/chat/slack/turn.record.test.ts).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { memoryRepoDir, mirrorMemory, type MirrorExec } from './memjournal.js';
import { brainAfterTurn, brainProjectDir, readIndex, readLint } from './brain/store.js';

const DIR = mkdtempSync(join(tmpdir(), 'aven-brain-'));
const prev = process.env.AVEN_DIR;
before(() => void (process.env.AVEN_DIR = DIR));
after(() => {
  if (prev === undefined) delete process.env.AVEN_DIR;
  else process.env.AVEN_DIR = prev;
  rmSync(DIR, { recursive: true, force: true });
});

const sha = (s: string): string => createHash('sha256').update(s).digest('hex');
function session(slug: string, files: Record<string, string>, fail = false) {
  const exec: MirrorExec = async (command) => {
    if (fail) return { exitCode: 1, result: '' };
    if (command.startsWith('base64 ')) return { exitCode: 0, result: Buffer.from(files[/\/([^/']+)'$/.exec(command)![1]]).toString('base64') };
    return { exitCode: 0, result: Object.entries(files).map(([n, c]) => `${sha(c)}  ${n}`).join('\n') };
  };
  return { mirrorMemory: (message: string) => mirrorMemory(exec, memoryRepoDir(slug), '/mem', message) };
}

test('a turn that changed records: the journal has them, the index lists them, the lint reports what is wrong', async () => {
  const files: Record<string, string> = {
    'MEMORY.md': '- [GLACIER-12](glacier-12.md)\n',
    'glacier-12.md': '---\nname: Voucher counted twice\nkind: investigation\nticket: GLACIER-12\n---\nMarch export.\n',
  };
  const m = await brainAfterTurn(session('skishop', files), 'skishop', 't1', new Date('2026-05-01T08:00:00.000Z'));
  assert.deepEqual(m?.changed, ['MEMORY.md', 'glacier-12.md']);
  const index = await readIndex('skishop');
  assert.deepEqual(index?.records.map((r) => [r.name, r.kind, r.ticket]), [['glacier-12.md', 'investigation', 'GLACIER-12']]);
  assert.deepEqual((await readLint('skishop'))?.map((f) => f.code), ['no-status']);

  // The next turn fixes it: the lint is clean, and the record keeps the day the host first saw it.
  files['glacier-12.md'] = files['glacier-12.md'].replace('kind: investigation', 'kind: investigation\nstatus: open');
  await brainAfterTurn(session('skishop', files), 'skishop', 't2', new Date('2026-05-03T08:00:00.000Z'));
  const next = await readIndex('skishop');
  assert.deepEqual([next?.records[0].status, next?.records[0].firstSeen, next?.records[0].lastChange], ['open', '2026-05-01T08:00:00.000Z', '2026-05-03T08:00:00.000Z']);
  assert.deepEqual(await readLint('skishop'), []);
});

test('the mirror fails: nothing is thrown, nothing is written for that project', async () => {
  assert.equal(await brainAfterTurn(session('nomirror', { 'a.md': 'A\n' }, true), 'nomirror', 't1'), undefined);
  assert.equal(existsSync(brainProjectDir('nomirror')), false);
});

test('a project with no memory yet, and a session that cannot mirror: no brain directory', async () => {
  await brainAfterTurn(session('empty', {}), 'empty', 't1');
  assert.equal(await brainAfterTurn({}, 'empty', 't2'), undefined);
  assert.equal(existsSync(brainProjectDir('empty')), false);
});

test('the index file is plain JSON a person can read, and holds no record text', () => {
  const raw = readFileSync(join(brainProjectDir('skishop'), 'index.json'), 'utf8');
  assert.ok(raw.endsWith('\n'));
  assert.ok(!raw.includes('March export'));
});
