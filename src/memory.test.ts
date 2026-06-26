import { test } from 'node:test';
import assert from 'node:assert/strict';
import { memoryDir, memoryFilePath } from './memory.js';

test('memoryDir maps a session cwd to its auto-memory path', () => {
  assert.equal(memoryDir('/root/work/caldora'), '/root/.claude/projects/-root-work-caldora/memory');
  assert.equal(
    memoryDir('/root/work/caldora/caldora-admin'),
    '/root/.claude/projects/-root-work-caldora-caldora-admin/memory',
  );
});

test('memoryFilePath defaults to the MEMORY.md index', () => {
  assert.equal(
    memoryFilePath('/root/work/caldora'),
    '/root/.claude/projects/-root-work-caldora/memory/MEMORY.md',
  );
});

test('memoryFilePath resolves a safe topic, with or without a .md suffix', () => {
  const dir = '/root/.claude/projects/-root-work-caldora/memory';
  assert.equal(memoryFilePath('/root/work/caldora', 'project_caldora_overview'), `${dir}/project_caldora_overview.md`);
  assert.equal(memoryFilePath('/root/work/caldora', 'project_caldora_overview.md'), `${dir}/project_caldora_overview.md`);
  assert.equal(memoryFilePath('/root/work/caldora', 'notes-1'), `${dir}/notes-1.md`);
});

test('memoryFilePath rejects unsafe topics (traversal / separators / metacharacters)', () => {
  for (const bad of ['../secrets', 'a/b', '..', 'foo/../bar', 'foo bar', 'foo;rm -rf', '.ssh/id_rsa', '$(whoami)']) {
    assert.equal(memoryFilePath('/root/work/caldora', bad), null, `should reject: ${bad}`);
  }
});
