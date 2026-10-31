import { test } from 'node:test';
import assert from 'node:assert/strict';
import { apiHeaders, getGitHubToken, isAuthFailure, intersectPermissions } from './github.js';
import type { Config } from './config.js';

// Minimal stand-in for the bits of a fetch Response that isAuthFailure reads.
const res = (status: number, rateRemaining?: string) => ({
  status,
  headers: { get: (n: string) => (n === 'x-ratelimit-remaining' ? rateRemaining ?? null : null) },
});

test('401 is a credential failure', () => {
  assert.equal(isAuthFailure(res(401)), true);
});

test('403 without an exhausted rate-limit is a credential failure (scope / not-installed)', () => {
  assert.equal(isAuthFailure(res(403)), true);
  assert.equal(isAuthFailure(res(403, '57')), true);
});

test('403 with rate-limit exhausted is NOT reported (self-heals)', () => {
  assert.equal(isAuthFailure(res(403, '0')), false);
});

test('transient / not-found statuses are NOT credential failures', () => {
  for (const s of [404, 422, 500, 502, 503]) assert.equal(isAuthFailure(res(s)), false);
});

const DESIRED = { contents: 'write', pull_requests: 'write', checks: 'read', metadata: 'read' };

test('intersect: install granting everything (at >= desired) yields the desired least-privilege set', () => {
  const granted = { contents: 'write', pull_requests: 'write', checks: 'write', issues: 'write', metadata: 'read' };
  const { permissions, missing } = intersectPermissions(DESIRED, granted);
  // checks downscoped to read (we only want read) even though write is granted; issues not requested.
  assert.deepEqual(permissions, { contents: 'write', pull_requests: 'write', checks: 'read', metadata: 'read' });
  assert.deepEqual(missing, []);
});

test('intersect: a permission granted BELOW desired is capped at the granted level', () => {
  const granted = { contents: 'read', pull_requests: 'write', checks: 'read', metadata: 'read' };
  const { permissions, missing } = intersectPermissions(DESIRED, granted);
  assert.equal(permissions.contents, 'read'); // desired write, but only read granted → read
  assert.deepEqual(missing, []);
});

test('intersect: an un-granted permission is dropped (never requested) and reported missing', () => {
  const granted = { contents: 'write', pull_requests: 'write', metadata: 'read' }; // no checks
  const { permissions, missing } = intersectPermissions(DESIRED, granted);
  assert.equal('checks' in permissions, false);
  assert.deepEqual(missing, ['checks']);
});

test('intersect: no granted permissions → everything missing, nothing requested', () => {
  const { permissions, missing } = intersectPermissions(DESIRED, undefined);
  assert.deepEqual(permissions, {});
  assert.deepEqual(missing.sort(), ['checks', 'contents', 'metadata', 'pull_requests']);
});

test('GITHUB_AUTH=none: no token to mint, and the API is asked without an Authorization header', async () => {
  assert.equal(await getGitHubToken({ github: { kind: 'none' } } as Config, ['acme/shop']), '');
  assert.deepEqual(apiHeaders(''), { Accept: 'application/vnd.github+json' });
  assert.deepEqual(apiHeaders('ghs_x'), { Authorization: 'Bearer ghs_x', Accept: 'application/vnd.github+json' });
});
