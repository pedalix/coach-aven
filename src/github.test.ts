import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isAuthFailure } from './github.js';

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
