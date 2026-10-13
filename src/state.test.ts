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

test('routines — a key patched to undefined is deleted (the delivery guard clears outcome fields at fire)', () => {
  const { store } = freshStore();
  const r = store.addRoutine(routine());
  store.patchRoutine(r.id, { lastOutcome: 'error', lastReason: 'boom', retry: { at: '2026-10-13T05:45:00.000Z', slot: '2026-10-13T05:30:00.000Z' } });
  assert.equal(store.getRoutine(r.id)?.retry?.at, '2026-10-13T05:45:00.000Z');
  store.patchRoutine(r.id, { lastOutcome: undefined, retry: undefined });
  const rec = store.getRoutine(r.id)!;
  assert.equal('lastOutcome' in rec, false);
  assert.equal('retry' in rec, false);
  assert.equal(rec.lastReason, 'boom'); // untouched keys stay
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

test('youtrack investigations — record, link, finish, and legacy dedup union', () => {
  const { store, path } = freshStore();
  store.recordInvestigation('ESET-9', { slug: 'holidayshop-hsx', channel: 'C9', rootTs: '111.222', startedAt: '2026-07-01T10:00:00Z' });
  const rec = store.getInvestigation('ESET-9');
  assert.equal(rec?.rootTs, '111.222'); // ticket → thread link persisted
  assert.equal(rec?.finishedAt, undefined);
  store.finishInvestigation('ESET-9');
  assert.ok(store.getInvestigation('ESET-9')?.finishedAt); // stamped on settle
  store.finishInvestigation('nope'); // no-op, doesn't throw

  // Dedup set is the union of new records + the legacy seen-set (back-compat after upgrade).
  const legacy = new Store(path);
  // simulate a state.json written by an older build that only had seenYouTrackTickets
  (legacy as unknown as { data: { seenYouTrackTickets: Record<string, string> } }).data.seenYouTrackTickets = { 'ART-1': '2026-06-30T00:00:00Z' };
  const ids = legacy.investigatedTicketIds();
  assert.ok(ids.has('ESET-9')); // from records
  assert.ok(ids.has('ART-1')); // from legacy seen-set
});

test('pruneChats — drops idle records, keeps fresh ones and anything in flight', () => {
  const { store, path } = freshStore();
  const DAY = 24 * 60 * 60_000;
  const now = Date.parse('2026-07-10T00:00:00Z');
  store.patchChat('thread:old', 'caldora', { sessionId: 'a' });
  store.patchChat('thread:busy', 'caldora', {
    inflight: { channel: 'C1', statusTs: '1.2', startedAt: '2026-05-01T00:00:00Z' },
  });
  store.patchChat('thread:fresh', 'caldora', { sessionId: 'b' });
  // Backdate the first two past the horizon (patchChat stamps updatedAt = now).
  for (const key of ['thread:old', 'thread:busy']) {
    (store as unknown as { data: { chats: Record<string, { updatedAt: string }> } }).data.chats[key].updatedAt =
      '2026-05-01T00:00:00Z';
  }

  assert.equal(store.pruneChats(45 * DAY, now), 1);
  assert.equal(store.getChat('thread:old'), undefined); // idle past horizon → gone
  assert.ok(store.getChat('thread:busy')); // in flight → kept for recovery
  assert.ok(store.getChat('thread:fresh')); // fresh → kept
  assert.equal(new Store(path).getChat('thread:old'), undefined); // pruning persisted
  assert.equal(store.pruneChats(45 * DAY, now), 0); // idempotent
});

test('pruneReviewedPrs — drops old dedup entries, keeps recent', () => {
  const { store } = freshStore();
  const DAY = 24 * 60 * 60_000;
  const now = Date.parse('2026-07-10T00:00:00Z');
  store.markPrReviewed('Org/repo#1');
  (store as unknown as { data: { reviewedPrs: Record<string, string> } }).data.reviewedPrs['Org/repo#1'] =
    '2026-01-01T00:00:00Z';
  store.markPrReviewed('Org/repo#2'); // stamped now-ish → kept
  assert.equal(store.pruneReviewedPrs(90 * DAY, now), 1);
  assert.deepEqual([...store.reviewedPrKeys()], ['Org/repo#2']);
});

test('youtrack investigations — reverse thread lookup + reported stamp (the 📝 flow)', () => {
  const { store } = freshStore();
  store.recordInvestigation('CG-50', { slug: 'caldora', channel: 'C1', rootTs: '222.333', startedAt: '2026-07-08T10:00:00Z' });
  store.recordInvestigation('CB-7', { slug: 'caldora', channel: 'C1', startedAt: '2026-07-08T10:01:00Z' }); // headerless: no rootTs

  const hit = store.investigationByRoot('222.333');
  assert.equal(hit?.id, 'CG-50');
  assert.equal(store.investigationByRoot('999.999'), undefined); // unknown thread → no button

  assert.equal(store.getInvestigation('CG-50')?.reportedAt, undefined);
  store.markReported('CG-50');
  assert.ok(store.getInvestigation('CG-50')?.reportedAt);
  store.markReported('nope'); // no-op, doesn't throw
});

// ── slice 2: tenant stamping + export/purge ───────────────────────────────────
const T = 'T0CLIENT77';

test('patchChat/setChat stamp teamId from the key; home keys stay field-less', () => {
  const { store } = freshStore();
  store.patchChat('thread:1.1', 'caldora', {});
  store.patchChat(`${T}:thread:2.2`, 'caldora', {});
  assert.equal(store.getChat('thread:1.1')?.teamId, undefined);
  assert.equal(store.getChat(`${T}:thread:2.2`)?.teamId, T);
  // a caller-supplied teamId in the patch is overridden by the key's truth
  store.patchChat(`${T}:thread:2.2`, 'caldora', { teamId: 'T0EVIL999' } as never);
  assert.equal(store.getChat(`${T}:thread:2.2`)?.teamId, T);
  store.setChat({ threadTs: `${T}:dm:C1:caldora`, slug: 'caldora', updatedAt: 'x', teamId: 'T0EVIL999' });
  assert.equal(store.getChat(`${T}:dm:C1:caldora`)?.teamId, T);
});

test('exportTenant/purgeTenant slice records by the explicit field', () => {
  const { store } = freshStore();
  store.patchChat('thread:1.1', 'alpha', {});
  store.patchChat(`${T}:thread:2.2`, 'beta', {});
  store.addRoutine(routine()); // home (no teamId)
  store.addRoutine({ ...routine(), teamId: T } as never);
  store.setPrWatch(`${T}:O/r#1`, { repo: 'O/r', number: 1, slug: 'beta', teamId: T, channel: 'C9', createdBy: 'U1', createdAt: 'x' });
  store.setInstallation(T, { bot: { token: 'xoxb-t' } });
  store.recordInvestigation('CG-1', { slug: 'beta', teamId: T, channel: 'C9', startedAt: 'x' });

  const exp = store.exportTenant(T);
  assert.equal(exp.chats.length, 1);
  assert.equal(exp.routines.length, 1);
  assert.equal(exp.prWatches.length, 1);
  assert.deepEqual(Object.keys(exp.investigations), ['CG-1']);
  assert.ok(exp.installation);
  assert.equal(store.exportTenant(undefined).chats.length, 1); // home slice

  const counts = store.purgeTenant(T);
  assert.deepEqual(counts, { chats: 1, routines: 1, prWatches: 1, investigations: 1, installations: 1 });
  assert.equal(store.getChat(`${T}:thread:2.2`), undefined);
  assert.equal(store.getChat('thread:1.1')?.slug, 'alpha'); // home untouched
  assert.equal(store.listRoutines().length, 1);
});
