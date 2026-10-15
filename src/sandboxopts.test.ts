import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SANDBOX_OPTIONS, isDefaultSandbox, parseMount, resolveSandboxOptions } from './sandboxopts.js';

test('resolveSandboxOptions — absent/empty → fleet defaults (privileged dind, no mounts)', () => {
  assert.deepEqual(resolveSandboxOptions(undefined), DEFAULT_SANDBOX_OPTIONS);
  assert.deepEqual(resolveSandboxOptions({}), DEFAULT_SANDBOX_OPTIONS);
  assert.equal(isDefaultSandbox(resolveSandboxOptions({})), true);
});

test('resolveSandboxOptions — unprivileged plain project with a read-only data mount', () => {
  const o = resolveSandboxOptions({ privileged: false, dind: false, mounts: ['/srv/owen-ops/sources:/data/sources'] });
  assert.equal(o.privileged, false);
  assert.equal(o.dind, false);
  assert.deepEqual(o.mounts, [{ source: '/srv/owen-ops/sources', target: '/data/sources', mode: 'ro' }]);
  assert.equal(isDefaultSandbox(o), false);
});

test('resolveSandboxOptions — privileged:false without dind:false is a contradiction', () => {
  assert.throws(() => resolveSandboxOptions({ privileged: false }), /requires "dind": false/);
  assert.throws(() => resolveSandboxOptions({ privileged: false, dind: true }), /requires "dind": false/);
});

test('parseMount — mode defaults to ro, rw allowed, everything else rejected', () => {
  assert.deepEqual(parseMount('/a/b:/c'), { source: '/a/b', target: '/c', mode: 'ro' });
  assert.deepEqual(parseMount('/a/b:/c:rw'), { source: '/a/b', target: '/c', mode: 'rw' });
  assert.throws(() => parseMount('/a/b:/c:z'), /mode/);
  assert.throws(() => parseMount('/a/b'), /expected/);
  assert.throws(() => parseMount('/a/b:/c:ro:x'), /expected/);
});

test('parseMount — relative paths, "..", spaces, shell chars and "/" itself are rejected', () => {
  for (const bad of ['srv/x:/data', '/srv/x:data', '/srv/../etc:/data', '/srv/x y:/data', "/srv/x';rm:/data", '/:/data', '/srv/x:/']) {
    assert.throws(() => parseMount(bad), new RegExp('mount'), bad);
  }
});

test('resolveSandboxOptions — duplicate container targets are rejected', () => {
  assert.throws(() => resolveSandboxOptions({ mounts: ['/a:/data', '/b:/data'] }), /duplicate mount target/);
});

