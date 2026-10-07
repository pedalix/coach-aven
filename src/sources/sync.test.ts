import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FactStore, projectSubject } from '../facts.js';
import type { ProjectConfig } from '../projects.js';
import {
  BACKOFF_CAP_MS,
  SOURCES_SYNC,
  applyRun,
  authCheckDue,
  backoffMs,
  createSourcesTicker,
  emptySyncState,
  fromFact,
  nextDueAt,
  planPull,
  readSyncState,
  statusLine,
  toFact,
  writeSyncState,
} from './sync.js';
import type { PullSummary, SourceKind } from './types.js';

const T0 = new Date('2026-10-07T10:00:00Z');
const at = (min: number): Date => new Date(T0.getTime() + min * 60_000);
const summary = (kind: SourceKind, o: Partial<PullSummary> = {}): PullSummary => ({
  kind,
  ok: true,
  reauth: false,
  counts: { 'a/mail': 3 },
  errors: [],
  startedAt: T0.toISOString(),
  finishedAt: T0.toISOString(),
  ...o,
});
const project = (slug: string, kinds: SourceKind[] = ['google', 'slack']): ProjectConfig =>
  ({
    slug,
    repos: [],
    sources: {
      ...(kinds.includes('google') ? { google: { accounts: ['a@x'] } } : {}),
      ...(kinds.includes('slack') ? { slack: { workspaces: [] } } : {}),
      ...(kinds.includes('msgraph') ? { msgraph: { tenant: 't', accounts: ['u'] } } : {}),
    },
  }) as unknown as ProjectConfig;

describe('sources sync: due + backoff', () => {
  it('never ran → due now; after a run → interval; failures double it up to the 2h cap', () => {
    assert.equal(nextDueAt(emptySyncState(), 15), 0);
    const s = applyRun(emptySyncState(), ['google'], [summary('google')], T0);
    assert.equal(nextDueAt(s, 15), at(15).getTime());
    assert.equal(backoffMs(15, 1), 30 * 60_000);
    assert.equal(backoffMs(15, 2), 60 * 60_000);
    assert.equal(backoffMs(15, 10), BACKOFF_CAP_MS);
  });

  it('planPull returns nothing before due, every configured kind when due', () => {
    const s = applyRun(emptySyncState(), ['google'], [summary('google')], T0);
    assert.deepEqual(planPull(s, ['google', 'slack'], 15, at(14)), []);
    assert.deepEqual(planPull(s, ['google', 'slack'], 15, at(15)), ['google', 'slack']);
  });

  it('a failing pass increments the streak, a clean pass resets it and records lastOkAt', () => {
    let s = applyRun(emptySyncState(), ['google'], [summary('google', { ok: false, errors: ['boom', 'x', 'y', 'z'] })], T0);
    assert.equal(s.consecutiveFailures, 1);
    assert.equal(s.lastOkAt, undefined);
    assert.deepEqual(s.lastSummary.google?.errors, ['boom', 'x', 'y']); // capped at 3
    s = applyRun(s, ['google'], [summary('google', { ok: false })], at(30));
    assert.equal(s.consecutiveFailures, 2);
    s = applyRun(s, ['google'], [summary('google')], at(90));
    assert.equal(s.consecutiveFailures, 0);
    assert.equal(s.lastOkAt, at(90).toISOString());
  });

  it('an exception escaping the pass counts as a failure and is kept as lastError', () => {
    const s = applyRun(emptySyncState(), ['google'], [], T0, 'ENOENT token file');
    assert.equal(s.consecutiveFailures, 1);
    assert.equal(s.lastError, 'ENOENT token file');
    const s2 = applyRun(s, ['google'], [summary('google')], at(30));
    assert.equal(s2.lastError, undefined);
  });
});

describe('sources sync: re-auth handling', () => {
  it('a reauth kind is parked, probed every 2h, and released when it reports ok again', () => {
    let s = applyRun(emptySyncState(), ['google', 'slack'], [summary('google', { ok: false, reauth: true }), summary('slack')], T0);
    assert.deepEqual(s.needsReauth, ['google']);
    // Next pass (15 min): slack only — google is parked, probe not due.
    assert.deepEqual(planPull(s, ['google', 'slack'], 15, at(15)), ['slack']);
    // Parked kinds don't drive backoff: slack keeps its 15-minute cadence.
    s = applyRun(s, ['slack'], [summary('slack')], at(15));
    assert.equal(s.consecutiveFailures, 0);
    assert.deepEqual(planPull(s, ['google', 'slack'], 15, at(30)), ['slack']);
    // Two hours after the reauth was first seen the probe is due again.
    assert.deepEqual(planPull(s, ['google', 'slack'], 15, at(121)), ['google', 'slack']);
    s = applyRun(s, ['google', 'slack'], [summary('google', { ok: false, reauth: true }), summary('slack')], at(121));
    assert.equal(s.reauthProbeAt, at(121).toISOString());
    assert.equal(s.consecutiveFailures, 0, 'a still-dead grant is not a new transient failure');
    // Operator fixed it → the next probe reports ok → released.
    s = applyRun(s, ['google', 'slack'], [summary('google'), summary('slack')], at(245));
    assert.deepEqual(s.needsReauth, []);
  });
});

describe('sources sync: facts round-trip + status line', () => {
  it('writes one sources_sync fact with provenance and reads it back; garbage reads as empty', () => {
    const facts = new FactStore(mkdtempSync(join(tmpdir(), 'aven-facts-')));
    const s = applyRun(emptySyncState(), ['google'], [summary('google', { counts: { 'a/mail': 5, 'a/drive': 2 } })], T0);
    writeSyncState(facts, 'ops', s, at(1));
    const f = facts.get('ops', projectSubject('ops'), SOURCES_SYNC);
    assert.ok(f);
    assert.deepEqual(f.sources, ['data/ops/raw', 'projects.config.json#sources']);
    assert.equal(f.observedAt, at(1).toISOString());
    assert.deepEqual(readSyncState(facts, 'ops'), s);
    assert.deepEqual(fromFact({ ...toFact('ops', s, T0), value: 'nonsense' }), emptySyncState());
    assert.deepEqual(readSyncState(facts, 'never'), emptySyncState());
  });

  it('status line: never pulled / last pull + records + next in / reauth suffix', () => {
    assert.equal(statusLine(emptySyncState(), 15, T0, 'UTC'), 'sources: never pulled, due now');
    let s = applyRun(emptySyncState(), ['google', 'slack'], [summary('google', { counts: { m: 300 } }), summary('slack', { counts: { c: 27 } })], T0);
    assert.equal(statusLine(s, 15, at(8), 'UTC'), 'sources: last pull 10:00, 327 records, next in 7m');
    assert.equal(statusLine(s, 15, at(8), 'Europe/Moscow'), 'sources: last pull 13:00, 327 records, next in 7m');
    s = applyRun(s, ['google', 'slack'], [summary('google', { ok: false, reauth: true }), summary('slack', { counts: { c: 1 } })], at(15));
    assert.equal(statusLine(s, 15, at(16), 'UTC'), 'sources: last pull 10:15, 4 records, next in 14m | reauth needed: google');
  });

  it('authCheckDue fires once per day inside the 06:xx hour of the tz', () => {
    const six = new Date('2026-10-07T03:00:30Z'); // 06:00:30 Europe/Moscow
    const key = authCheckDue(six, 'Europe/Moscow', undefined);
    assert.equal(key, '10-7');
    assert.equal(authCheckDue(new Date('2026-10-07T03:40:00Z'), 'Europe/Moscow', key), undefined, 'same day → once');
    assert.equal(authCheckDue(new Date('2026-10-07T04:00:00Z'), 'Europe/Moscow', undefined), undefined, '07:00 → not due');
    assert.equal(authCheckDue(new Date('2026-10-08T03:05:00Z'), 'Europe/Moscow', key), '10-8');
  });
});

describe('sources sync: ticker', () => {
  it('pulls due projects, persists state, single-flights, alerts once per reauth situation', async () => {
    const facts = new FactStore(mkdtempSync(join(tmpdir(), 'aven-facts-')));
    let now = T0;
    const calls: Array<{ slug: string; kinds: SourceKind[] }> = [];
    const alerts: string[] = [];
    let gate: Promise<void> | undefined; // when set, the fake puller waits on it
    let googleDead = false;
    const ticker = createSourcesTicker({
      projects: () => [project('ops'), project('nosrc', []), { slug: 'plain', repos: [] } as unknown as ProjectConfig],
      facts,
      now: () => now,
      alert: (t) => alerts.push(t),
      pull: async (p, kinds) => {
        calls.push({ slug: p.slug, kinds });
        if (gate) await gate;
        return kinds.map((k) => summary(k, k === 'google' && googleDead ? { ok: false, reauth: true } : {}));
      },
    });
    await ticker.tick();
    assert.deepEqual(calls, [{ slug: 'ops', kinds: ['google', 'slack'] }], 'projects without sources are skipped');
    assert.equal(readSyncState(facts, 'ops').lastRunAt, T0.toISOString());
    now = at(5);
    await ticker.tick();
    assert.equal(calls.length, 1, 'not due yet');
    // Single-flight: a tick during an in-flight pass does not start a second one.
    now = at(15);
    let open!: () => void;
    gate = new Promise<void>((r) => (open = r));
    const first = ticker.tick();
    await new Promise((r) => setImmediate(r)); // let the first tick reach the puller
    assert.ok(ticker.pulling.has('ops'));
    await ticker.tick();
    assert.equal(calls.length, 2, 'second tick skipped the in-flight project');
    gate = undefined;
    open();
    await first;
    assert.ok(!ticker.pulling.has('ops'));
    // Re-auth: alert once, not again on the next (parked) pass; cleared when recovered.
    googleDead = true;
    now = at(30);
    await ticker.tick();
    assert.equal(alerts.length, 1);
    assert.match(alerts[0]!, /re-auth needed for google/);
    now = at(45);
    await ticker.tick();
    assert.deepEqual(calls.at(-1)?.kinds, ['slack'], 'google parked');
    assert.equal(alerts.length, 1, 'no nag');
    googleDead = false;
    now = at(30 + 121);
    await ticker.tick();
    assert.deepEqual(readSyncState(facts, 'ops').needsReauth, []);
    googleDead = true;
    now = at(30 + 121 + 15);
    await ticker.tick();
    assert.equal(alerts.length, 2, 'a NEW reauth situation alerts again');
  });

  it('an exception in the puller is recorded, not thrown out of tick()', async () => {
    const facts = new FactStore(mkdtempSync(join(tmpdir(), 'aven-facts-')));
    const ticker = createSourcesTicker({
      projects: () => [project('ops')],
      facts,
      now: () => T0,
      alert: () => undefined,
      pull: async () => {
        throw new Error('token file missing');
      },
    });
    await ticker.tick();
    const s = readSyncState(facts, 'ops');
    assert.equal(s.lastError, 'token file missing');
    assert.equal(s.consecutiveFailures, 1);
  });
});
