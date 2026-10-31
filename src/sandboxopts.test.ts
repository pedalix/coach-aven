import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SANDBOX_OPTIONS, assertDeletable, parseMount, privilegeWarnings, resolveSandboxOptions } from './sandboxopts.js';

test('resolveSandboxOptions — absent/empty → fleet defaults (privileged dind, no mounts)', () => {
  assert.deepEqual(resolveSandboxOptions(undefined), DEFAULT_SANDBOX_OPTIONS);
  assert.deepEqual(resolveSandboxOptions({}), DEFAULT_SANDBOX_OPTIONS);
});

test('resolveSandboxOptions — unprivileged plain project with a read-only data mount', () => {
  const o = resolveSandboxOptions({ privileged: false, dind: false, mounts: ['/srv/owen-ops/sources:/data/sources'] });
  assert.equal(o.privileged, false);
  assert.equal(o.dind, false);
  assert.deepEqual(o.mounts, [{ source: '/srv/owen-ops/sources', target: '/data/sources', mode: 'ro' }]);
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

test('assertDeletable — only throwaway sandboxes; a project sandbox is refused whatever the prefix', () => {
  assert.doesNotThrow(() => assertDeletable('cli-probe-20261017-a1b2', 'proj-'));
  assert.doesNotThrow(() => assertDeletable('cli-probe-x', ''));
  for (const name of ['proj-caldora', 'dev-proj-caldora', 'caldora', '', 'cli-probe', 'cli-probe-X', 'cli-probe-a;rm']) {
    assert.throws(() => assertDeletable(name, 'proj-'), /refusing to delete sandbox/, name);
  }
  // A deployment whose project prefix is itself a throwaway-looking name deletes nothing at all.
  assert.throws(() => assertDeletable('cli-probe-1', 'cli-probe-'), /refusing/);
});


// OpenSpec sandbox-privilege-opt-in.
test('resolveSandboxOptions: a block-less project is today\'s, { dind: true } alone is privileged, an image is the project\'s', () => {
  assert.deepEqual(resolveSandboxOptions(undefined), { privileged: true, dind: true, mounts: [] }, 'block-less: today');
  assert.deepEqual(resolveSandboxOptions({ dind: true }), { privileged: true, dind: true, mounts: [] });
  assert.deepEqual(resolveSandboxOptions({ privileged: false, dind: false }), { privileged: false, dind: false, mounts: [] });
  assert.deepEqual(resolveSandboxOptions({ dind: true, image: 'registry.example/acme/laravel:1.2' }), {
    privileged: true,
    dind: true,
    mounts: [],
    image: 'registry.example/acme/laravel:1.2',
  });
  assert.equal(resolveSandboxOptions({ privileged: false, dind: false, image: 'ghcr.io/acme/plain@sha256:abc' }).image, 'ghcr.io/acme/plain@sha256:abc');
  for (const ok of ['localhost:5000/acme/x:tag', 'acme/x:1@sha256:abc', 'plain']) assert.equal(resolveSandboxOptions({ image: ok }).image, ok);
  for (const bad of ['', 'img; rm -rf /', 'has space', '-x', -1]) {
    assert.throws(() => resolveSandboxOptions({ image: bad as string }), /"image" must be an image reference/);
  }
  assert.throws(() => resolveSandboxOptions({ privileged: false }), /requires "dind": false/, 'today\'s contradiction stays an error');
});

test('privilegeWarnings: prod, staging and home as they are on 2026-10-31', () => {
  const blockless = ['harbor', 'shop', 'ops'].map((slug) => ({ slug }));
  const plain = (slug: string) => ({ slug, sandbox: { privileged: false, dind: false } });
  // prod: block-less projects on a remote host → the one line naming them and the opt-in
  const prod = privilegeWarnings({ projects: blockless, local: false, localConfirmed: false });
  assert.equal(prod.length, 1);
  assert.match(prod[0], /harbor, shop, ops have no "sandbox" block/);
  assert.match(prod[0], /"dind": true/);
  // prod after it writes the opt-in → quiet
  assert.deepEqual(privilegeWarnings({ projects: blockless.map((p) => ({ ...p, sandbox: { dind: true } })), local: false, localConfirmed: false }), []);
  // staging and home: every project plain, local mode → nothing
  assert.deepEqual(privilegeWarnings({ projects: [plain('platform'), plain('newsletter')], local: true, localConfirmed: false }), []);
  // local + privileged without the confirmation; confirmed → quiet
  const local = privilegeWarnings({ projects: [{ slug: 'x', sandbox: { dind: true } }], local: true, localConfirmed: false });
  assert.equal(local.length, 1);
  assert.match(local[0], /root-equivalent/);
  assert.deepEqual(privilegeWarnings({ projects: [{ slug: 'x', sandbox: { dind: true } }], local: true, localConfirmed: true }), []);
});
