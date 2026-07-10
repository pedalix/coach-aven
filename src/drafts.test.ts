import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DraftStore, isDraftId } from './drafts.js';

const freshStore = (): { store: DraftStore; base: string } => {
  const base = mkdtempSync(join(tmpdir(), 'aven-drafts-'));
  return { store: new DraftStore(base), base };
};

test('put/get — round-trips across projects; get needs no slug', () => {
  const { store } = freshStore();
  store.put('caldora', 'tabc-1', '## Findings\nslow query in checkout');
  store.put('holidayshop-hsx', 'tabc-2', 'other project draft');
  assert.equal(store.get('tabc-1'), '## Findings\nslow query in checkout');
  assert.equal(store.get('tabc-2'), 'other project draft');
  assert.equal(store.get('tabc-9'), undefined); // unknown id → button shows "expired"
});

test('get on an empty base (no drafts yet) is undefined, not an error', () => {
  const { store } = freshStore();
  assert.equal(store.get('tabc-1'), undefined);
});

test('draft ids are validated before becoming path segments', () => {
  assert.ok(isDraftId('tly2k3-42'));
  assert.ok(!isDraftId('../../etc/passwd'));
  assert.ok(!isDraftId('t1')); // old pre-restart-unique format — no boot suffix
  assert.ok(!isDraftId(''));
  const { store } = freshStore();
  store.put('caldora', '../escape', 'nope'); // silently refused
  assert.equal(store.get('../escape' as string), undefined);
});

test('per-project cap — oldest drafts pruned past 100', () => {
  const { store, base } = freshStore();
  for (let i = 1; i <= 103; i++) {
    store.put('caldora', `tboot-${i}`, `draft ${i}`);
    // writeFileSync within one test tick can share an mtime; spread them so "oldest" is deterministic.
    utimesSync(join(base, 'caldora', `tboot-${i}.md`), new Date(i * 1000), new Date(i * 1000));
  }
  assert.equal(readdirSync(join(base, 'caldora')).length, 100);
  assert.equal(store.get('tboot-1'), undefined); // oldest gone
  assert.equal(store.get('tboot-103'), 'draft 103'); // newest kept
});
