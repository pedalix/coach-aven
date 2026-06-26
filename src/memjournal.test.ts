import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { commitSnapshot, readSnapshotFile, snapshotLog, safeSlug } from './memjournal.js';

test('safeSlug accepts conventional slugs, rejects path-y ones', () => {
  assert.equal(safeSlug('caldora'), 'caldora');
  assert.equal(safeSlug('dorfberg-nuxt'), 'dorfberg-nuxt');
  for (const bad of ['../x', 'a/b', 'a b', '.', '']) assert.throws(() => safeSlug(bad), `should reject: ${bad}`);
});

test('commitSnapshot commits, dedups no-ops, mirrors deletions; readback + log work', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'memj-'));
  try {
    assert.equal(await commitSnapshot(repo, { 'MEMORY.md': '# idx\n', 'a.md': 'A' }, 'first'), true);
    assert.equal(await readSnapshotFile(repo, 'MEMORY.md'), '# idx\n');
    assert.equal(await readSnapshotFile(repo, 'a.md'), 'A');

    // identical content → no commit
    assert.equal(await commitSnapshot(repo, { 'MEMORY.md': '# idx\n', 'a.md': 'A' }, 'noop'), false);

    // change MEMORY.md and drop a.md → commit, and a.md is gone (mirror)
    assert.equal(await commitSnapshot(repo, { 'MEMORY.md': '# idx2\n' }, 'second'), true);
    assert.equal(await readSnapshotFile(repo, 'a.md'), null);
    assert.equal(await readSnapshotFile(repo, 'MEMORY.md'), '# idx2\n');

    const lines = await snapshotLog(repo);
    assert.equal(lines.length, 2);
    assert.match(lines[0], /second/); // newest first
    assert.match(lines[1], /first/);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('readSnapshotFile rejects unsafe names and missing files', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'memj-'));
  try {
    await commitSnapshot(repo, { 'MEMORY.md': 'x' }, 'init');
    assert.equal(await readSnapshotFile(repo, '../etc/passwd'), null);
    assert.equal(await readSnapshotFile(repo, 'nope.md'), null);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('snapshotLog is empty for a non-repo dir', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'memj-'));
  try {
    assert.deepEqual(await snapshotLog(dir), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
