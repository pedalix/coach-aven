import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SANDBOX_OPTIONS, assertDeletable, parseMount, privilegeWarnings, resolveSandboxOptions, sandboxDefaultFrom } from './sandboxopts.js';

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


// OpenSpec sandbox-privilege-opt-in, stage 1.
test('SANDBOX_DEFAULT: unset is dind (not chosen), dind|plain chosen, anything else stops the boot', () => {
  assert.deepEqual(sandboxDefaultFrom({}), { value: 'dind', set: false });
  assert.deepEqual(sandboxDefaultFrom({ SANDBOX_DEFAULT: 'plain' }), { value: 'plain', set: true });
  assert.deepEqual(sandboxDefaultFrom({ SANDBOX_DEFAULT: 'dind' }), { value: 'dind', set: true });
  assert.throws(() => sandboxDefaultFrom({ SANDBOX_DEFAULT: 'yes' }), /SANDBOX_DEFAULT must be 'dind' or 'plain'/);
});

test('resolveSandboxOptions with an installation default: today unchanged, plain for block-less, field by field, dind implies privileged', () => {
  assert.deepEqual(resolveSandboxOptions(undefined), { privileged: true, dind: true, mounts: [] }, 'unset: today');
  assert.deepEqual(resolveSandboxOptions(undefined, 'plain'), { privileged: false, dind: false, mounts: [] });
  assert.deepEqual(resolveSandboxOptions({ privileged: true }, 'plain'), { privileged: true, dind: false, mounts: [] });
  assert.deepEqual(resolveSandboxOptions({ dind: true }, 'plain'), { privileged: true, dind: true, mounts: [] }, 'dind needs a runtime');
  assert.deepEqual(resolveSandboxOptions({ privileged: false, dind: false }, 'dind'), { privileged: false, dind: false, mounts: [] });
  assert.throws(() => resolveSandboxOptions({ privileged: false }, 'dind'), /requires "dind": false/, 'today\'s contradiction stays an error');
});

test('privilegeWarnings: prod, staging and home as they are on 2026-10-30', () => {
  const blockless = ['harbor', 'shop', 'ops'].map((slug) => ({ slug }));
  const plain = (slug: string) => ({ slug, sandbox: { privileged: false, dind: false } });
  const base = { installationDefault: 'dind' as const, defaultSet: false, runtimeSet: false, local: false, localConfirmed: false };
  // prod: block-less projects, sysbox runtime set, a remote sandbox host → only the implicit-default line
  const prod = privilegeWarnings({ ...base, projects: blockless, defaulted: blockless.map((p) => p.slug), runtimeSet: true });
  assert.equal(prod.length, 1);
  assert.match(prod[0], /harbor, shop, ops have no "sandbox" block/);
  assert.match(prod[0], /SANDBOX_DEFAULT=dind/);
  // staging and home: every project plain, local mode → nothing
  assert.deepEqual(privilegeWarnings({ ...base, projects: [plain('platform'), plain('newsletter')], defaulted: [], local: true }), []);
  // the runtime warning follows privileged, not dind
  const priv = privilegeWarnings({ ...base, projects: [{ slug: 'x', sandbox: { privileged: true, dind: false } }], defaulted: [] });
  assert.equal(priv.length, 1);
  assert.match(priv[0], /SSHDOCKER_RUNTIME is unset/);
  // local + privileged without the confirmation; confirmed and chosen → quiet
  const local = privilegeWarnings({ ...base, projects: [{ slug: 'x', sandbox: { privileged: true, dind: true } }], defaulted: [], local: true, runtimeSet: true });
  assert.match(local.join('\n'), /root-equivalent/);
  assert.deepEqual(privilegeWarnings({ ...base, projects: [{ slug: 'x', sandbox: { privileged: true, dind: true } }], defaulted: [], local: true, runtimeSet: true, localConfirmed: true }), []);
  // a chosen plain default: block-less projects are plain → nothing
  assert.deepEqual(privilegeWarnings({ ...base, installationDefault: 'plain', defaultSet: true, projects: blockless, defaulted: blockless.map((p) => p.slug), local: true }), []);
});
