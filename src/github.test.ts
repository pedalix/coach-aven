import { test } from 'node:test';
import assert from 'node:assert/strict';
import { apiHeaders, EXCLUDED_PERMISSIONS, getGitHubToken, isAuthFailure, intersectPermissions, requestedPermissions } from './github.js';
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

// OpenSpec project-grants: the sandbox mint's request, with and without a grant's extras.
// An installation as they stood before agent-github-read-superset was approved…
const INSTALL_BEFORE = { contents: 'write', pull_requests: 'write', checks: 'write', actions: 'read', metadata: 'read', workflows: 'write', issues: 'write', deployments: 'read' };
// …and after: the reads, Actions write for the grant, and the two reads the token must never take even though
// an App may hold them.
const INSTALL = {
  ...INSTALL_BEFORE,
  actions: 'write',
  environments: 'read',
  administration: 'read',
  vulnerability_alerts: 'read',
  security_events: 'read',
  secret_scanning_alerts: 'read',
  repository_hooks: 'read',
};
const STANDING = {
  contents: 'write',
  pull_requests: 'write',
  checks: 'read',
  actions: 'read',
  metadata: 'read',
  deployments: 'read',
  environments: 'read',
  administration: 'read',
  vulnerability_alerts: 'read',
  security_events: 'read',
};

test('requested permissions without a grant are exactly the standing set', () => {
  assert.deepEqual(requestedPermissions(INSTALL), { permissions: STANDING, missing: [] });
  assert.deepEqual(requestedPermissions(INSTALL, {}), requestedPermissions(INSTALL));
});

test('requested permissions with a workflows grant add workflows write and nothing else', () => {
  assert.deepEqual(requestedPermissions(INSTALL, { workflows: 'write' }).permissions, { ...STANDING, workflows: 'write' });
});

// OpenSpec agent-github-read-superset: the reads light up per installation as its owner approves them.
test('an installation that has not approved the newer reads mints exactly what it approved', () => {
  const r = requestedPermissions(INSTALL_BEFORE);
  assert.deepEqual(r.permissions, { contents: 'write', pull_requests: 'write', checks: 'read', actions: 'read', metadata: 'read', deployments: 'read' });
  assert.deepEqual(r.missing.sort(), ['administration', 'environments', 'security_events', 'vulnerability_alerts']);
});

test('secret scanning alerts and webhooks are never requested, not even through a grant', () => {
  const r = requestedPermissions(INSTALL, { workflows: 'write', actions: 'write', secret_scanning_alerts: 'read', repository_hooks: 'read' });
  for (const p of EXCLUDED_PERMISSIONS) assert.equal(r.permissions[p], undefined, p);
});

test('an actions grant raises actions to write where the installation approved it, and only to read where not', () => {
  assert.equal(requestedPermissions(INSTALL, { actions: 'write' }).permissions.actions, 'write');
  assert.equal(requestedPermissions(INSTALL_BEFORE, { actions: 'write' }).permissions.actions, 'read');
});

// OpenSpec agent-actions-read: an installation granting Actions write still yields a read-only token, and one that
// has not approved Actions mints without it.
test('actions is requested read-only, even when the installation grants write', () => {
  assert.equal(requestedPermissions({ ...INSTALL, actions: 'write' }).permissions.actions, 'read');
});

test('an installation that has not approved actions drops it; the mint request still succeeds', () => {
  const { actions: _, ...without } = INSTALL;
  const r = requestedPermissions(without);
  assert.equal(r.permissions.actions, undefined);
  assert.deepEqual(r.missing, ['actions']);
  assert.equal(r.permissions.contents, 'write');
});

test('an extra never lowers an agent permission', () => {
  assert.equal(requestedPermissions(INSTALL, { contents: 'read' }).permissions.contents, 'write');
});

test('an installation that has not approved workflows drops it; the mint request still succeeds', () => {
  const { workflows: _, ...without } = INSTALL;
  const r = requestedPermissions(without, { workflows: 'write' });
  assert.equal(r.permissions.workflows, undefined);
  assert.deepEqual(r.missing, ['workflows']);
  assert.equal(r.permissions.contents, 'write');
});
