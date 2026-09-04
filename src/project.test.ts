import { test } from 'node:test';
import assert from 'node:assert/strict';
import { composerAuthScript } from './project.js';

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
