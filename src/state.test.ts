import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from './state.js';
import type { InTask, OutTask } from './messaging/records.js';

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

// ── agent messaging records (OpenSpec agent-messaging task 3.2) ─────────────────────────────────
const DAY_MS = 86_400_000;
const TENANT = 'T0CLIENT01';
const outTask = (over: Partial<OutTask> = {}): OutTask => ({
  id: 'a'.repeat(24),
  slug: 'owen-ops',
  key: 'thread:1700000000.000100',
  reply: { key: 'thread:1700000000.000100', driver: 'slack', channel: 'C1', thread: '1700000000.000100' },
  target: 'bluefin/caldora',
  question: 'Why did orders drop on 2026-10-16?',
  state: 'submitted',
  depth: 0,
  rounds: 0,
  replies: [],
  seen: [],
  createdAt: '2026-10-17T08:00:00.000Z',
  updatedAt: '2026-10-17T08:00:00.000Z',
  ...over,
});
const inTask = (over: Partial<InTask> = {}): InTask => ({
  id: 'a'.repeat(24),
  origin: 'home',
  from: 'home/owen-ops',
  fromDomain: 'home',
  slug: 'caldora',
  key: `a2a:home:${'a'.repeat(24)}:caldora`,
  question: 'Why did orders drop on 2026-10-16?',
  state: 'working',
  depth: 0,
  rounds: 0,
  seen: ['e'.repeat(24)],
  createdAt: '2026-10-17T08:00:00.000Z',
  updatedAt: '2026-10-17T08:00:00.000Z',
  ...over,
});

test('messaging — tasks both ways: a local task has an outgoing and an incoming record; the tenant comes from the key; they persist', () => {
  const { store, path } = freshStore();
  store.putOutTask(outTask());
  store.putInTask(inTask({ origin: 'home' }));
  store.putInTask(inTask({ origin: 'northwind', from: 'northwind/ledger', fromDomain: 'northwind' }));
  const clientIn = store.putInTask(inTask({ id: 'b'.repeat(24), key: `${TENANT}:a2a:home:${'b'.repeat(24)}:caldora`, teamId: 'T0FORGED01' }));
  assert.equal(clientIn.teamId, TENANT, 'stamped from the key, never trusted from the caller');
  assert.equal(store.getInTask('home', 'a'.repeat(24))?.from, 'home/owen-ops');
  assert.equal(store.getInTask('northwind', 'a'.repeat(24))?.from, 'northwind/ledger', 'two senders’ ids never meet');
  store.patchOutTask('a'.repeat(24), { state: 'working', last: { at: '2026-10-17T08:01:00.000Z', role: 'agent', state: 'working', text: '' } });
  const reloaded = new Store(path);
  assert.equal(reloaded.getOutTask('a'.repeat(24))?.state, 'working');
  assert.equal(reloaded.getOutTask('a'.repeat(24))?.teamId, undefined, 'home stays field-less');
  assert.equal(reloaded.messagingTasks().in.length, 3);
});

test('messaging — task outlives the hub: open tasks idle past the expiry plus a day are found on both sides; ended ones are not', () => {
  const { store } = freshStore();
  const now = Date.parse('2026-10-26T09:00:00.000Z');
  store.putOutTask(outTask({ updatedAt: '2026-10-17T08:00:00.000Z' })); // 9 days idle, open
  store.putOutTask(outTask({ id: 'c'.repeat(24), state: 'completed', updatedAt: '2026-10-17T08:00:00.000Z' }));
  store.putOutTask(outTask({ id: 'd'.repeat(24), updatedAt: '2026-10-25T08:00:00.000Z' })); // fresh
  store.putInTask(inTask({ state: 'input-required', updatedAt: '2026-10-17T08:00:00.000Z' }));
  const idle = store.idleOpenTasks(8 * DAY_MS, now);
  assert.deepEqual(idle.out.map((t) => t.id), ['a'.repeat(24)]);
  assert.deepEqual(idle.in.map((t) => t.origin), ['home']);
});

test('messaging — marks per conversation: set, read as a copy, removed when empty, and pruned only with the conversation’s record', () => {
  const { store } = freshStore();
  const key = 'thread:1700000000.000100';
  store.setMarks(key, { bluefin: ['bluefin'] });
  const m = store.getMarks(key);
  m.bluefin!.push('northwind');
  assert.deepEqual(store.getMarks(key), { bluefin: ['bluefin'] }, 'a copy');
  assert.deepEqual(store.getMarks('thread:other'), {});
  store.setChat({ threadTs: key, slug: 'owen-ops', updatedAt: '2026-08-01T00:00:00.000Z' });
  store.setChat({ threadTs: 'thread:fresh', slug: 'owen-ops', updatedAt: new Date().toISOString() });
  store.setMarks('thread:fresh', { bluefin: ['bluefin'] });
  assert.equal(store.pruneChats(45 * DAY_MS), 1);
  assert.deepEqual(store.getMarks(key), {}, 'gone with its conversation');
  assert.deepEqual(store.getMarks('thread:fresh'), { bluefin: ['bluefin'] }, 'age alone never ends marks');
  store.setMarks('thread:fresh', {});
  assert.deepEqual(store.getMarks('thread:fresh'), {});
});

test('messaging — learned domains, held messages, daily caps', () => {
  const { store } = freshStore();
  store.learnDomain('bluefin/caldora', 'bluefin~1a2b3c4d');
  assert.equal(store.peerDomain('bluefin/caldora'), 'bluefin~1a2b3c4d');
  const held = store.putHeld({ id: 'f'.repeat(24), task: 'f'.repeat(24), kind: 'task', slug: 'owen-ops', key: `${TENANT}:thread:1.2`, target: 'northwind/ledger', text: 'q', why: 'bluefin data', createdAt: '2026-10-17T08:00:00.000Z' });
  assert.equal(held.teamId, TENANT);
  store.patchHeld(held.id, { card: { channel: 'C1', ts: '1.3' } });
  assert.deepEqual(store.getHeld(held.id)?.card, { channel: 'C1', ts: '1.3' });
  assert.equal(store.listHeld().length, 1);
  assert.equal(store.deleteHeld(held.id), true);
  assert.equal(store.deleteHeld(held.id), false);
  assert.equal(store.bumpAskCount('send|owen-ops|2026-10-16', '2026-10-15'), 1);
  assert.equal(store.bumpAskCount('send|owen-ops|2026-10-17', '2026-10-16'), 1);
  assert.equal(store.bumpAskCount('accept|caldora|home/owen-ops|2026-10-17', '2026-10-17'), 1, 'yesterday’s counter dropped on the way');
  assert.equal(store.askCount('send|owen-ops|2026-10-16'), 0);
  assert.equal(store.askCount('send|owen-ops|2026-10-17'), 1);
});

test('messaging — the transports’ records live in state.json; an installation that never used messaging gets no block', () => {
  const { store, path } = freshStore();
  const hub = store.messagingRecords('hub');
  hub.save([]);
  store.getMarks('thread:x');
  store.idleOpenTasks(1);
  store.setChat({ threadTs: 'thread:x', slug: 'owen-ops', updatedAt: new Date().toISOString() });
  assert.equal('messaging' in JSON.parse(readFileSync(path, 'utf8')), false, 'reads and empty saves leave state.json as it was');
  hub.save([{ seq: 1, env: { v: 1, id: '1'.repeat(24), from: 'home/owen-ops', to: 'bluefin/caldora', method: 'ask', task: 'a'.repeat(24) }, at: '2026-10-17T08:00:00.000Z' }]);
  assert.equal(new Store(path).messagingRecords('hub').load().length, 1);
  assert.equal(new Store(path).messagingRecords('local').load().length, 0);
});

test('messaging — housekeeping drops ended tasks and held messages after 30 days, never an open task', () => {
  const { store } = freshStore();
  const now = Date.parse('2026-11-20T00:00:00.000Z');
  store.putOutTask(outTask({ state: 'completed', updatedAt: '2026-10-17T08:00:00.000Z' }));
  store.putOutTask(outTask({ id: 'c'.repeat(24), state: 'working', updatedAt: '2026-10-17T08:00:00.000Z' }));
  store.putInTask(inTask({ state: 'failed', reason: 'expired', updatedAt: '2026-10-17T08:00:00.000Z' }));
  store.putInTask(inTask({ origin: 'northwind', state: 'completed', updatedAt: '2026-11-15T08:00:00.000Z' }));
  store.putHeld({ id: 'f'.repeat(24), task: 'f'.repeat(24), kind: 'task', slug: 'owen-ops', key: 'thread:1.2', target: 'northwind/ledger', text: 'q', why: 'w', createdAt: '2026-10-17T08:00:00.000Z' });
  assert.equal(store.pruneMessaging(30 * DAY_MS, now), 3);
  const left = store.messagingTasks();
  assert.deepEqual(left.out.map((t) => t.state), ['working']);
  assert.deepEqual(left.in.map((t) => t.origin), ['northwind']);
  assert.equal(store.listHeld().length, 0);
});

test('messaging — per-tenant export and purge cover tasks, held messages and marks', () => {
  const { store } = freshStore();
  store.putOutTask(outTask({ key: `${TENANT}:thread:1.2`, reply: { key: `${TENANT}:thread:1.2`, driver: 'slack' } }));
  store.putOutTask(outTask({ id: 'c'.repeat(24) }));
  store.putInTask(inTask({ key: `${TENANT}:a2a:home:${'a'.repeat(24)}:caldora` }));
  store.putHeld({ id: 'f'.repeat(24), task: 'f'.repeat(24), kind: 'task', slug: 'owen-ops', key: `${TENANT}:thread:1.2`, target: 'northwind/ledger', text: 'q', why: 'w', createdAt: '2026-10-17T08:00:00.000Z' });
  store.setMarks(`${TENANT}:thread:1.2`, { bluefin: ['bluefin'] });
  store.setMarks('thread:home', { bluefin: ['bluefin'] });
  const exp = store.exportTenant(TENANT);
  assert.equal(exp.tasks.out.length, 1);
  assert.equal(exp.tasks.in.length, 1);
  assert.equal(exp.held.length, 1);
  assert.deepEqual(Object.keys(exp.marks), [`${TENANT}:thread:1.2`]);
  const counts = store.purgeTenant(TENANT);
  assert.equal(counts.tasks, 2);
  assert.equal(counts.held, 1);
  assert.equal(counts.marks, 1);
  assert.equal(store.messagingTasks().out.length, 1, 'home’s task stays');
  assert.deepEqual(store.getMarks('thread:home'), { bluefin: ['bluefin'] });
});

test('retired dispatch records: proposals and daily dispatch counts are dropped once, on load, and stay gone after a reload (retire-agent-dispatch D4)', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'aven-store-')), 'state.json');
  writeFileSync(path, JSON.stringify({ projects: { caldora: { createdAt: 'x' } }, proposals: { 'p-1': { id: 'p-1' }, 'p-2': { id: 'p-2' } }, dispatches: { 'owen-ops|20261018': 2 } }));
  new Store(path);
  const saved = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal('proposals' in saved, false);
  assert.equal('dispatches' in saved, false);
  assert.deepEqual(saved.projects, { caldora: { createdAt: 'x' } }, 'everything else is kept');
  const again = readFileSync(path, 'utf8');
  new Store(path);
  assert.equal(readFileSync(path, 'utf8'), again, 'a second load finds nothing to drop and writes nothing');
});
