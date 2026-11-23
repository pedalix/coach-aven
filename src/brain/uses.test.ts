import { test } from 'node:test';
import assert from 'node:assert/strict';
import { memoryNames, parseJsonl, provenance, useEntry, type UseEntry } from './uses.js';

const MEM = '/root/.claude/projects/-root-work-skishop/memory';

test('memoryNames — record files a tool input names: a Read path, a shell command; never MEMORY.md', () => {
  assert.deepEqual(memoryNames({ file_path: `${MEM}/glacier-12.md` }), ['glacier-12.md']);
  assert.deepEqual(memoryNames({ command: `cat ${MEM}/MEMORY.md ${MEM}/pricing.md && grep -n voucher ${MEM}/glacier-12.md` }), ['glacier-12.md', 'pricing.md']);
  assert.deepEqual(memoryNames({ file_path: '/root/work/skishop/docs/memory-model.md' }), []);
  assert.deepEqual(memoryNames({ command: `ls ${MEM}/` }), []);
  assert.deepEqual(memoryNames(undefined), []);
});

const base = { at: '2026-05-01T08:00:00.000Z', key: 'thread:1', turnId: 't1', by: 'person' as const };

test('useEntry — names only; a name the host does not hold is not a use; a changed record is not also "read"', () => {
  assert.deepEqual(useEntry({ ...base, read: ['pricing.md', 'typo.md', 'MEMORY.md', 'glacier-12.md'], changed: ['glacier-12.md', 'MEMORY.md'], known: ['MEMORY.md', 'pricing.md'] }), {
    ...base,
    read: ['pricing.md'],
    changed: ['glacier-12.md'],
  });
});

test('useEntry — a turn that touched no record logs nothing', () => {
  assert.equal(useEntry({ ...base, read: [], changed: ['MEMORY.md'], known: ['MEMORY.md', 'pricing.md'] }), undefined);
});

const e = (at: string, key: string, by: UseEntry['by'], read: string[], changed: string[] = []): UseEntry => ({ at: `2026-05-${at}T08:00:00.000Z`, key, turnId: `t-${at}`, by, read, changed });

test('provenance — revised after a reply: a person\'s turn changes a record an earlier turn of that conversation used', () => {
  const p = provenance([e('01', 'thread:1', 'person', ['counting.md']), e('02', 'thread:1', 'person', [], ['counting.md'])]);
  assert.deepEqual(p.get('counting.md'), { uses: 2, lastUsed: '2026-05-02T08:00:00.000Z', revisedAfterReply: '2026-05-02T08:00:00.000Z' });
});

test('provenance — used twelve times without a reply that changed it: twelve uses, and not checked', () => {
  const p = provenance(Array.from({ length: 12 }, (_, i) => e(String(i + 1).padStart(2, '0'), `thread:${i}`, 'person', ['counting.md'])));
  assert.deepEqual(p.get('counting.md'), { uses: 12, lastUsed: '2026-05-12T08:00:00.000Z' });
});

test('provenance — a record written in the first turn of a conversation is not "revised"; another conversation\'s edit is not either', () => {
  const p = provenance([e('01', 'thread:1', 'person', [], ['glacier-12.md']), e('02', 'thread:2', 'person', [], ['glacier-12.md'])]);
  assert.equal(p.get('glacier-12.md')?.revisedAfterReply, undefined);
  assert.equal(p.get('glacier-12.md')?.uses, 2);
});

test('provenance — a routine\'s or a poller\'s turn changes neither the count nor the revision date', () => {
  const p = provenance([e('01', 'thread:1', 'person', ['counting.md']), e('02', 'thread:1', 'routine', [], ['counting.md']), e('03', 'dream', 'poller', ['counting.md'])]);
  assert.deepEqual(p.get('counting.md'), { uses: 1, lastUsed: '2026-05-01T08:00:00.000Z' });
});

test('provenance — the order of the log does not matter, the times do', () => {
  const a = e('01', 'thread:1', 'person', ['counting.md']);
  const b = e('02', 'thread:1', 'person', [], ['counting.md']);
  assert.deepEqual(provenance([b, a]), provenance([a, b]));
});

test('parseJsonl — a torn last line is skipped', () => {
  assert.deepEqual(parseJsonl<{ a: number }>('{"a":1}\n\n{"a":2}\n{"a":'), [{ a: 1 }, { a: 2 }]);
});
