import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { hashListScript, mirrorMemory, parseHashListing, parseInstructionDigests, parseReadBack, readBackScript, readSnapshotFile, snapshotLog, safeSlug, safeName, type MirrorExec } from './memjournal.js';

test('safeSlug accepts conventional slugs, rejects path-y ones', () => {
  assert.equal(safeSlug('caldora'), 'caldora');
  assert.equal(safeSlug('dorfberg-nuxt'), 'dorfberg-nuxt');
  for (const bad of ['../x', 'a/b', 'a b', '.', '']) assert.throws(() => safeSlug(bad), `should reject: ${bad}`);
});

test('safeName accepts memory filenames, rejects path-y / shell-y ones', () => {
  for (const ok of ['MEMORY.md', 'project_caldora_overview.md', 'notes-1.md']) {
    assert.equal(safeName(ok), true, `should accept: ${ok}`);
  }
  for (const bad of ['../etc/passwd', 'a/b', 'a b.md', 'foo;rm', '$(x)', '']) {
    assert.equal(safeName(bad), false, `should reject: ${bad}`);
  }
});

// ── the mirror after a turn (company-brain) ─────────────────────────────────────────────────────────────────────
// A fake sandbox: a directory of files answered through the two scripts the mirror sends.
function fakeSandbox(files: Record<string, string>, o: { failList?: boolean; failRead?: string } = {}) {
  const calls: string[] = [];
  const sha = (s: string): string => createHash('sha256').update(s).digest('hex');
  const exec: MirrorExec = async (command) => {
    calls.push(command);
    if (command.includes('base64 -w0')) {
      const names = [.../'([^']+)'/g[Symbol.matchAll](/for f in (.*?); do/.exec(command)![1])].map((m) => m[1]);
      if (o.failRead && names.includes(o.failRead)) return { exitCode: 1, result: '' };
      return { exitCode: 0, result: names.filter((n) => n in files).map((n) => `${n} ${Buffer.from(files[n]).toString('base64')}\n`).join('') };
    }
    if (o.failList) return { exitCode: 1, result: '' };
    return { exitCode: 0, result: Object.entries(files).map(([n, c]) => `${sha(c)}  ${n}`).join('\n') };
  };
  return { exec, calls, reads: () => calls.filter((c) => c.includes('base64 -w0')) };
}

test('the journal keeps an empty file (an emptied topic is real state, not a drop)', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'memj-'));
  try {
    await mirrorMemory(fakeSandbox({ 'MEMORY.md': '# idx\n', 'empty.md': '' }).exec, repo, '/mem', 'init');
    assert.equal(await readSnapshotFile(repo, 'empty.md'), ''); // present, empty — not missing
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('the journal commits, skips a no-op, mirrors deletions; readback + log work', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'memj-'));
  try {
    await mirrorMemory(fakeSandbox({ 'MEMORY.md': '# idx\n', 'a.md': 'A' }).exec, repo, '/mem', 'first');
    assert.equal(await readSnapshotFile(repo, 'MEMORY.md'), '# idx\n');
    assert.equal(await readSnapshotFile(repo, 'a.md'), 'A');

    // identical content → no commit
    await mirrorMemory(fakeSandbox({ 'MEMORY.md': '# idx\n', 'a.md': 'A' }).exec, repo, '/mem', 'noop');

    // change MEMORY.md and drop a.md → commit, and a.md is gone
    await mirrorMemory(fakeSandbox({ 'MEMORY.md': '# idx2\n' }).exec, repo, '/mem', 'second');
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
    await mirrorMemory(fakeSandbox({ 'MEMORY.md': 'x' }).exec, repo, '/mem', 'init');
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

test('hashListScript / parseHashListing — one line per file; unsafe names and noise are dropped', () => {
  assert.match(hashListScript("/root/.claude/projects/-root-work-x/memory"), /^\[ -d '\/root\/.claude\/projects\/-root-work-x\/memory' \] \|\| exit 0; cd /);
  const h = 'a'.repeat(64);
  assert.deepEqual(parseHashListing(`${h}  MEMORY.md\n${h} *glacier-12.md\n${h}  a b.md\n${h}  ../x\nsha256sum: x: Is a directory\n`), {
    'MEMORY.md': h,
    'glacier-12.md': h,
  });
});

test('readBackScript / parseReadBack — the changed files in one exec; an empty file, an unsafe name', () => {
  assert.equal(readBackScript('/mem', ['a.md', "it's.md"]), `cd '/mem' || exit 1; for f in 'a.md' 'it'\\''s.md'; do [ -f "$f" ] || continue; printf '%s ' "$f"; base64 -w0 -- "$f" || exit 1; echo; done`);
  const got = parseReadBack(`a.md ${Buffer.from('A\n').toString('base64')}\nempty.md \n../x QQ==\n`);
  assert.deepEqual(Object.keys(got), ['a.md', 'empty.md']);
  assert.equal(got['a.md'].toString(), 'A\n');
  assert.equal(got['empty.md'].length, 0);
});

test('mirrorMemory — a hundred new records are read back in three execs, not a hundred', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'memj-'));
  try {
    const files = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`r${i}.md`, `record ${i}\n`]));
    const sb = fakeSandbox(files);
    const m = await mirrorMemory(sb.exec, repo, '/mem', 'turn t1');
    assert.equal(m.changed.length, 100);
    assert.equal(sb.calls.length, 4, 'the listing and three batches');
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('two mirrors share the journal: a tidy ending with a turn does not collide', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'memj-'));
  try {
    const files = { 'a.md': 'A\n', 'b.md': 'B\n' };
    const [first, m] = await Promise.all([mirrorMemory(fakeSandbox(files).exec, repo, '/mem', 'tidy'), mirrorMemory(fakeSandbox(files).exec, repo, '/mem', 'turn t1')]);
    assert.equal(first.changed.length, 2);
    assert.deepEqual([m.changed, m.removed], [[], []], 'the second mirror saw the finished first one');
    assert.equal((await snapshotLog(repo)).length, 1);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('the listing also carries the CLAUDE.md digests it was asked for; a file the sandbox lacks is absent', async () => {
  const script = hashListScript('/mem', ['/work/shop/CLAUDE.md', '/work/api/CLAUDE.md']);
  assert.match(script, /^if \[ -d '\/mem' \]; then cd '\/mem' \|\| exit 1; for f in \*/);
  assert.match(script, /for p in '\/work\/shop\/CLAUDE.md' '\/work\/api\/CLAUDE.md'; do \[ -f "\$p" \] \|\| continue; printf 'instructions '; sha256sum -- "\$p" \|\| exit 1; done$/);
  const h = 'b'.repeat(64);
  assert.deepEqual(parseInstructionDigests(`${'a'.repeat(64)}  MEMORY.md\ninstructions ${h}  /work/shop/CLAUDE.md\n`), { '/work/shop/CLAUDE.md': h });
  assert.deepEqual(parseHashListing(`instructions ${h}  /work/shop/CLAUDE.md\n`), {}, 'never read as a memory file');

  const repo = await mkdtemp(join(tmpdir(), 'memj-'));
  try {
    const exec: MirrorExec = async () => ({ exitCode: 0, result: `instructions ${h}  /work/shop/CLAUDE.md\n` });
    const m = await mirrorMemory(exec, repo, '/mem', 'turn t1', { 'shop/CLAUDE.md': '/work/shop/CLAUDE.md', 'api/CLAUDE.md': '/work/api/CLAUDE.md' });
    assert.deepEqual(m.instructions, { 'shop/CLAUDE.md': h });
    assert.equal((await mirrorMemory(exec, repo, '/mem', 'turn t2')).instructions, undefined, 'not asked, not reported');
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('mirrorMemory — a changed record is read back and committed; the earlier version stays in the history', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'memj-'));
  try {
    const files: Record<string, string> = { 'MEMORY.md': '- [a](glacier-12.md)\n', 'glacier-12.md': 'status: open\n', 'pricing.md': 'Day pass.\n' };
    const first = fakeSandbox(files);
    const m1 = await mirrorMemory(first.exec, repo, '/mem', 'turn t1');
    assert.deepEqual(m1.changed, ['MEMORY.md', 'glacier-12.md', 'pricing.md']);
    assert.deepEqual(m1.files, files);

    files['glacier-12.md'] = 'status: fixed\n';
    delete files['pricing.md'];
    const second = fakeSandbox(files);
    const m2 = await mirrorMemory(second.exec, repo, '/mem', 'turn t2');
    assert.deepEqual([m2.changed, m2.removed], [['glacier-12.md'], ['pricing.md']]);
    assert.equal(first.reads().length, 1, 'three new files, ONE read-back exec');
    assert.deepEqual(second.reads().map((c) => /for f in (.*?); do/.exec(c)![1]), ["'glacier-12.md'"], 'only the changed file is read back');
    assert.equal(await readSnapshotFile(repo, 'glacier-12.md'), 'status: fixed\n');
    assert.equal(await readSnapshotFile(repo, 'pricing.md'), null);
    assert.deepEqual((await snapshotLog(repo)).map((l) => l.replace(/^\S+ \S+ /, '')), ['turn t2', 'turn t1']);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('mirrorMemory — nothing changed: the listing is the only exec and no commit is made', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'memj-'));
  try {
    const files = { 'MEMORY.md': '# idx\n', 'a.md': 'A\n' };
    await mirrorMemory(fakeSandbox(files).exec, repo, '/mem', 'turn t1');
    const again = fakeSandbox(files);
    const m = await mirrorMemory(again.exec, repo, '/mem', 'turn t2');
    assert.deepEqual([m.changed, m.removed, again.calls.length], [[], [], 1]);
    assert.equal((await snapshotLog(repo)).length, 1);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('mirrorMemory — a failed listing or read-back throws and leaves the journal as it was', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'memj-'));
  try {
    await mirrorMemory(fakeSandbox({ 'a.md': 'A\n' }).exec, repo, '/mem', 'turn t1');
    await assert.rejects(mirrorMemory(fakeSandbox({ 'a.md': 'B\n' }, { failList: true }).exec, repo, '/mem', 'turn t2'), /listing failed/);
    await assert.rejects(mirrorMemory(fakeSandbox({ 'a.md': 'B\n' }, { failRead: 'a.md' }).exec, repo, '/mem', 'turn t3'), /read-back failed/);
    assert.equal(await readSnapshotFile(repo, 'a.md'), 'A\n');
    assert.equal((await snapshotLog(repo)).length, 1);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('mirrorMemory — an empty listing (a rebuilt sandbox, not re-seeded yet) removes nothing from the journal', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'memj-'));
  try {
    await mirrorMemory(fakeSandbox({ 'a.md': 'A\n' }).exec, repo, '/mem', 'turn t1');
    const m = await mirrorMemory(fakeSandbox({}).exec, repo, '/mem', 'turn t2');
    assert.deepEqual([m.files, m.changed, m.removed], [{ 'a.md': 'A\n' }, [], []]);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('mirrorMemory — two turns ending together do not collide in one journal', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'memj-'));
  try {
    const files = { 'a.md': 'A\n', 'b.md': 'B\n' };
    const [x, y] = await Promise.all([mirrorMemory(fakeSandbox(files).exec, repo, '/mem', 'turn t1'), mirrorMemory(fakeSandbox(files).exec, repo, '/mem', 'turn t2')]);
    assert.deepEqual([x.changed, y.changed], [['a.md', 'b.md'], []]);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});
