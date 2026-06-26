import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from './state.js';

// A Store backed by a throwaway temp file (path injection keeps the real state.json safe).
function freshStore(): { store: Store; path: string } {
  const path = join(mkdtempSync(join(tmpdir(), 'aven-store-')), 'state.json');
  return { store: new Store(path), path };
}
const routine = (over: Record<string, unknown> = {}) => ({
  slug: 'caldora',
  channel: 'C1',
  cron: '0 9 * * *',
  tz: 'UTC',
  spec: 'daily 9:00',
  prompt: 'one-line status',
  enabled: true,
  createdBy: 'U1',
  ...over,
});

test('routines — incrementing ids, channel filter, persistence across reload', () => {
  const { store, path } = freshStore();
  const r1 = store.addRoutine(routine());
  const r2 = store.addRoutine(routine({ channel: 'C2' }));
  assert.equal(r1.id, 'r1');
  assert.equal(r2.id, 'r2');
  assert.ok(r1.createdAt);
  assert.equal(store.listRoutines().length, 2);
  assert.deepEqual(store.listRoutines({ channel: 'C2' }).map((r) => r.id), ['r2']);

  // A fresh Store on the same file sees the persisted routines.
  const reloaded = new Store(path);
  assert.equal(reloaded.listRoutines().length, 2);
  assert.equal(reloaded.getRoutine('r1')?.slug, 'caldora');
});

test('routines — patch toggles fields, delete removes', () => {
  const { store } = freshStore();
  const r = store.addRoutine(routine());
  store.patchRoutine(r.id, { enabled: false, lastRunAt: '2026-06-26T09:00:00Z' });
  assert.equal(store.getRoutine(r.id)?.enabled, false);
  assert.equal(store.getRoutine(r.id)?.lastRunAt, '2026-06-26T09:00:00Z');
  assert.equal(store.patchRoutine('nope', { enabled: true }), undefined);
  assert.equal(store.deleteRoutine(r.id), true);
  assert.equal(store.getRoutine(r.id), undefined);
  assert.equal(store.deleteRoutine(r.id), false);
});

test('routines — id is max(existing)+1 (can reuse a freed number)', () => {
  const { store } = freshStore();
  store.addRoutine(routine()); // r1
  store.addRoutine(routine()); // r2
  store.deleteRoutine('r2');
  assert.equal(store.addRoutine(routine()).id, 'r2'); // max is r1 → next r2
});

test('patchChat — merges fields without clobbering, deletes on undefined', () => {
  const { store } = freshStore();
  store.patchChat('thread:1', 'caldora', { sessionId: 'sess1' });
  store.patchChat('thread:1', 'caldora', { sessionKey: 'k', cmdId: 'c' });
  const rec = store.getChat('thread:1');
  assert.equal(rec?.sessionId, 'sess1'); // preserved by the merge
  assert.equal(rec?.sessionKey, 'k');
  store.patchChat('thread:1', 'caldora', { sessionId: undefined });
  assert.equal(store.getChat('thread:1')?.sessionId, undefined); // undefined deletes
});
