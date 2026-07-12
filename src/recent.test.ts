import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RecentSet } from './recent.js';

test('claim — first wins, duplicates lose within the TTL, expiry frees the key', () => {
  const s = new RecentSet(1000);
  assert.equal(s.claim('a', 0), true);
  assert.equal(s.claim('a', 500), false); // within TTL — duplicate
  assert.equal(s.claim('a', 1500), true); // expired — claimable again
});

test('sweep — expired entries are evicted, live ones survive (no wholesale clear)', () => {
  const s = new RecentSet(1000);
  s.claim('old', 0);
  s.claim('live', 900);
  s.claim('new', 1200); // sweep runs here: 'old' (age 1200) out, 'live' (age 300) stays
  assert.equal(s.size, 2);
  assert.equal(s.claim('live', 1300), false); // its cooldown was NOT reset by the sweep
});

test('a losing claim does not refresh the original timestamp', () => {
  const s = new RecentSet(1000);
  s.claim('k', 0);
  s.claim('k', 900); // lost — must not extend the window
  assert.equal(s.claim('k', 1100), true); // 1100 > 0 + ttl → free, despite the 900 attempt
});
