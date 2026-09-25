import { test } from 'node:test';
import assert from 'node:assert/strict';
import { composerAuthScript, seedGatewayAuth } from './project.js';
import type { SandboxHandle } from './driver.js';

test('composerAuthScript — http-basic + x-access-token (the only form GitHub accepts for ghs_ tokens), token read from file, per-checkout guard', () => {
  const s = composerAuthScript(['/w/p/admin', '/w/p/frontend']);
  assert.ok(s.includes('"http-basic"'));
  assert.ok(s.includes('"username":"x-access-token"'));
  assert.ok(!s.includes('github-oauth'));
  assert.ok(s.includes('$(cat /root/.gh-token)')); // never inlined by the orchestrator
  assert.ok(s.includes('if [ -f /w/p/admin/composer.json ]'));
  assert.ok(s.includes('if [ -f /w/p/frontend/composer.json ]'));
  assert.ok(s.includes('else rm -f /w/p/frontend/auth.json')); // stale file from the PAT era goes away
  assert.ok(s.includes('/w/p/admin-wt/*/')); // existing worktree copies are refreshed
  assert.ok(s.includes('.git/info/exclude'));
  assert.ok(s.endsWith('; true'));
});

test('seedGatewayAuth: writes the helper + a 600 token file per gateway entry; skips others', async () => {
  const uploads: Record<string, string> = {};
  const execs: string[] = [];
  const sandbox = {
    uploadFile: async (b: Buffer, p: string) => void (uploads[p] = b.toString()),
    exec: async (c: string) => (execs.push(c), { exitCode: 0, result: '' }),
  } as unknown as SandboxHandle;
  const asked: string[] = [];
  await seedGatewayAuth(
    sandbox,
    'caldora',
    [
      { name: 'gw', url: 'https://<gateway-host>/gw/caldora/mcp', auth: 'gateway-m2m' },
      { name: 'grafana', url: 'https://<grafana-host>/mcp' },
    ],
    { get: async (slug, aud) => (asked.push(`${slug}|${aud}`), 'TOKEN') },
  );
  assert.deepEqual(asked, ['caldora|https://<gateway-host>/gw/caldora/mcp']);
  assert.equal(uploads['/root/.aven/gw-token-gw'], 'TOKEN');
  assert.ok(uploads['/root/.aven/gw-headers.sh'].startsWith('#!/bin/sh'));
  assert.ok(execs.some((c) => c === 'chmod 600 /root/.aven/gw-token-gw'));
  assert.ok(!Object.keys(uploads).some((p) => p.includes('grafana')));
});

test('seedGatewayAuth: a mint failure does not throw (the turn goes on without gateway tools)', async () => {
  const sandbox = {
    uploadFile: async () => {},
    exec: async () => ({ exitCode: 0, result: '' }),
  } as unknown as SandboxHandle;
  await seedGatewayAuth(sandbox, 'caldora', [{ name: 'gw', url: 'https://x', auth: 'gateway-m2m' }], {
    get: async () => {
      throw new Error('auth0 down');
    },
  });
});

test('seedGatewayAuth: no gateway entry → touches nothing', async () => {
  let touched = false;
  const sandbox = {
    uploadFile: async () => void (touched = true),
    exec: async () => ((touched = true), { exitCode: 0, result: '' }),
  } as unknown as SandboxHandle;
  await seedGatewayAuth(sandbox, 'lumora', [{ name: 'grafana', url: 'https://<grafana-host>/mcp' }]);
  assert.equal(touched, false);
});
