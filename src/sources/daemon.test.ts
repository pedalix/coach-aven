// The sources daemon (OpenSpec sources-daemon): one writer per data directory, the HTTP face routed by
// slug, the status the bot reads instead of files, and the bot side — forwarding and cached views.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { FactStore } from '../facts.js';
import type { ProjectConfig } from '../projects.js';
import { acquireLock, heldByOther, lockPath, otherWriter, readLock, releaseLock } from './lock.js';
import { handleDaemonHttp, runDaemon, type DaemonStatus } from './daemon.js';
import { fetchDaemonStatus, forwardToDaemon, SourcesViews, STATUS_FRESH_MS, UNREACHABLE_ALERT_MS, type FetchFn } from './daemonclient.js';
import { openStore } from './store.js';
import { emptySyncState } from './sync.js';
import type { PullSummary } from './types.js';

function withDataDir<T>(fn: (root: string) => T | Promise<T>): Promise<T> {
  const prev = process.env.AVEN_DATA_DIR;
  const root = mkdtempSync(join(tmpdir(), 'daemon-data-'));
  process.env.AVEN_DATA_DIR = root;
  return Promise.resolve(fn(root)).finally(() => {
    if (prev === undefined) delete process.env.AVEN_DATA_DIR;
    else process.env.AVEN_DATA_DIR = prev;
  });
}

test('lock: a live other pid on this host holds; our own, a dead one or another host\'s does not; release only our own', () =>
  withDataDir(() => {
    const self = { pid: 100, host: 'h' };
    assert.equal(heldByOther(undefined, self), false);
    assert.equal(heldByOther({ pid: 200, host: 'h', startedAt: '', by: 'bot' }, self, () => true), true);
    assert.equal(heldByOther({ pid: 200, host: 'h', startedAt: '', by: 'bot' }, self, () => false), false, 'a dead pid is stale');
    assert.equal(heldByOther({ pid: 100, host: 'h', startedAt: '', by: 'bot' }, self, () => true), false, 'our own');
    assert.equal(heldByOther({ pid: 200, host: 'other', startedAt: '', by: 'bot' }, self, () => true), false, 'another machine cannot share our disk');
    // the real thing: our parent process is alive and is not us — its lock refuses us
    mkdirSync(join(process.env.AVEN_DATA_DIR!, 'acme'), { recursive: true });
    writeFileSync(lockPath('acme'), JSON.stringify({ pid: process.ppid, host: hostname(), startedAt: 't', by: 'bot' }));
    assert.equal(acquireLock('acme', 'sources daemon')?.by, 'bot');
    assert.equal(otherWriter('acme')?.pid, process.ppid);
    releaseLock('acme');
    assert.equal(readLock('acme')?.pid, process.ppid, 'never someone else\'s');
    writeFileSync(lockPath('acme'), '{torn');
    assert.equal(acquireLock('acme', 'sources daemon'), undefined, 'a torn lock is stale');
    assert.equal(readLock('acme')?.pid, process.pid);
    assert.equal(otherWriter('acme'), undefined);
    releaseLock('acme');
    assert.equal(readLock('acme'), undefined);
  }));

const statusOf = (slug: string): DaemonStatus => ({ slug, sync: emptySyncState(), rawRecords: 7, due: { escalationsOpen: 1, commitmentsDue: 0 }, pulling: false, alerts: [], daemon: { pid: 1, host: 'h', startedAt: 't' } });

test('daemon HTTP: health is open and says nothing; /mcp/<slug> and /status/<slug> need the bearer; an unserved slug is 404', () => {
  const dir = mkdtempSync(join(tmpdir(), 'daemon-replica-'));
  const db = openStore(join(dir, 'store.sqlite'));
  db.close();
  const d = { token: 'tok', served: () => new Set(['acme']), replicaPath: () => join(dir, 'store.sqlite'), status: statusOf };
  const auth = { authorization: 'Bearer tok' };
  assert.deepEqual(JSON.parse(handleDaemonHttp('GET', '/health', {}, '', d).body), { ok: true });
  assert.equal(handleDaemonHttp('GET', '/status/acme', {}, '', d).status, 401);
  assert.equal(handleDaemonHttp('GET', '/status/other', auth, '', d).status, 404);
  assert.equal(handleDaemonHttp('GET', '/mcp', auth, '', d).status, 404, 'the bare path of `serve` is not routed here');
  assert.equal(handleDaemonHttp('POST', '/status/acme', auth, '', d).status, 405);
  const st = handleDaemonHttp('GET', '/status/acme', auth, '', d);
  assert.deepEqual([st.status, JSON.parse(st.body).rawRecords, JSON.parse(st.body).due.escalationsOpen], [200, 7, 1]);
  const list = handleDaemonHttp('POST', '/mcp/acme', auth, JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }), d);
  assert.equal(list.status, 200);
  assert.ok((JSON.parse(list.body).result.tools as { name: string }[]).some((t) => t.name === 'attribution'));
  const call = handleDaemonHttp('POST', '/mcp/acme', auth, JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'stats', arguments: {} } }), d);
  assert.equal(JSON.parse(call.body).result.isError, false);
  assert.equal(handleDaemonHttp('POST', '/mcp/acme', auth, JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }), d).status, 202);
  const gone = { ...d, replicaPath: () => join(dir, 'missing.sqlite') };
  assert.equal(handleDaemonHttp('POST', '/mcp/acme', auth, JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'stats', arguments: {} } }), gone).status, 503);
});

test('runDaemon: takes the locks, refuses a project another live process ingests, ticks the fake pull into the sync state and serves its status', () =>
  withDataDir(async (root) => {
    const p: ProjectConfig = { slug: 'acme', repos: ['Org/acme'], sources: { youtrack: { url: 'https://yt.example', projects: ['AC'] } } };
    const facts = new FactStore(mkdtempSync(join(tmpdir(), 'daemon-facts-')));
    const now = () => new Date('2026-10-15T18:00:00.000Z');
    const pulled: string[] = [];
    const pull = async (_p: ProjectConfig, kinds: string[]): Promise<PullSummary[]> => {
      pulled.push(kinds.join(','));
      return [{ kind: 'youtrack', ok: true, reauth: false, counts: { issues: 3 }, errors: [], finishedAt: now().toISOString() } as unknown as PullSummary];
    };
    mkdirSync(join(root, 'acme'), { recursive: true });
    writeFileSync(lockPath('acme'), JSON.stringify({ pid: process.ppid, host: hostname(), startedAt: 't', by: 'bot' }));
    await assert.rejects(runDaemon({ projects: [p], listen: '127.0.0.1:0', token: 'tok', log: () => undefined, pull, facts, now, tickMs: 3_600_000 }), /acme is ingested by bot/);
    releaseLock('acme'); // not ours: still there
    writeFileSync(lockPath('acme'), JSON.stringify({ pid: 999_999_999, host: hostname(), startedAt: 't', by: 'bot' })); // a dead bot's
    const d = await runDaemon({ projects: [p], listen: '127.0.0.1:0', token: 'tok', log: () => undefined, pull, facts, now, tickMs: 3_600_000 });
    try {
      assert.equal(readLock('acme')?.by, 'sources daemon');
      await d.tick();
      assert.deepEqual(pulled, ['youtrack']);
      const s = d.status('acme');
      assert.equal(s.sync.lastSummary.youtrack?.records, 3);
      assert.equal(s.sync.lastOkAt, now().toISOString());
      assert.deepEqual([s.rawRecords, s.due], [undefined, { escalationsOpen: 0, commitmentsDue: 0 }], 'no replica yet; no tenant → nothing due');
      await d.tick();
      assert.equal(pulled.length, 1, 'the interval decides, as in the bot');
    } finally {
      await d.stop();
    }
    assert.equal(readLock('acme'), undefined, 'released on stop');
  }));

test('daemon client: forwards verbatim, passes JSON-RPC answers (even on 503) and refuses the rest; status is checked; no token, no call', async () => {
  const cfg = { url: 'http://127.0.0.1:3416', tokenEnv: 'TEST_DAEMON_TOKEN' };
  const env = { TEST_DAEMON_TOKEN: 'tok' };
  const seen: { url: string; auth?: string; body?: string }[] = [];
  const answer = (status: number, body: string): FetchFn => async (url, init) => {
    seen.push({ url, auth: init.headers.authorization, body: init.body });
    return { status, text: async () => body };
  };
  const msg = { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'stats', arguments: {} } };
  const ok = await forwardToDaemon(cfg, 'acme', msg, { env, fetchFn: answer(200, JSON.stringify({ jsonrpc: '2.0', id: 4, result: { isError: false } })) });
  assert.deepEqual(ok, { jsonrpc: '2.0', id: 4, result: { isError: false } });
  assert.deepEqual(seen[0], { url: 'http://127.0.0.1:3416/mcp/acme', auth: 'Bearer tok', body: JSON.stringify(msg) });
  assert.equal(await forwardToDaemon(cfg, 'acme', { jsonrpc: '2.0', method: 'notifications/initialized' }, { env, fetchFn: answer(202, '') }), undefined);
  const unavailable = await forwardToDaemon(cfg, 'acme', msg, { env, fetchFn: answer(503, JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32000, message: 'replica not available for acme' } })) });
  assert.match(JSON.stringify(unavailable), /replica not available/);
  await assert.rejects(forwardToDaemon(cfg, 'acme', msg, { env, fetchFn: answer(401, '') }), /HTTP 401/);
  await assert.rejects(forwardToDaemon(cfg, 'acme', msg, { env: {}, fetchFn: answer(200, '{}') }), /TEST_DAEMON_TOKEN is not set/);
  assert.equal((await fetchDaemonStatus(cfg, 'acme', { env, fetchFn: answer(200, JSON.stringify(statusOf('acme'))) })).rawRecords, 7);
  await assert.rejects(fetchDaemonStatus(cfg, 'acme', { env, fetchFn: answer(200, JSON.stringify(statusOf('other'))) }), /not a daemon status/);
});

test('views: a daemon project reads its last fresh status, unreachable when stale; refresh passes on new daemon alerts once, silence after ten minutes, recovery', async () => {
  let t = Date.parse('2026-10-15T18:00:00.000Z');
  const p: ProjectConfig = { slug: 'acme', repos: ['Org/acme'], sources: { youtrack: { url: 'https://yt.example', projects: ['AC'] }, daemon: { url: 'http://d:1', tokenEnv: 'TEST_DAEMON_TOKEN' } } };
  let reply: { status: number; body: string } = { status: 200, body: JSON.stringify({ ...statusOf('acme'), alerts: [{ at: '2026-10-15T17:00:00.000Z', text: 'old, before the bot started' }, { at: '2026-10-15T18:00:00.000Z', text: 'sources *acme*: re-auth needed for youtrack' }] }) };
  const views = new SourcesViews(new FactStore(mkdtempSync(join(tmpdir(), 'views-facts-'))), {
    env: { TEST_DAEMON_TOKEN: 'tok' },
    fetchFn: async () => ({ status: reply.status, text: async () => reply.body }),
    now: () => new Date(t),
    startedAt: '2026-10-15T17:30:00.000Z',
  });
  assert.equal(views.view(p, '2026-10-15').reachable, false, 'nothing fetched yet');
  assert.deepEqual((await views.refresh(p)).map((n) => n.text), ['sources *acme*: re-auth needed for youtrack'], 'only alerts raised since the bot started');
  assert.deepEqual(await views.refresh(p), [], 'each alert once');
  const v = views.view(p, '2026-10-15');
  assert.deepEqual([v.reachable, v.rawRecords, v.due], [true, 7, { escalationsOpen: 1, commitmentsDue: 0 }]);
  t += STATUS_FRESH_MS + 1;
  assert.deepEqual([views.view(p, '2026-10-15').reachable, views.view(p, '2026-10-15').rawRecords], [false, undefined], 'a stale status is not trusted: the empty-slot skip fires');
  reply = { status: 502, body: '' };
  assert.deepEqual(await views.refresh(p), []);
  t += UNREACHABLE_ALERT_MS;
  const down = await views.refresh(p);
  assert.equal(down.length, 1);
  assert.match(down[0]!.text, /has not answered since/);
  assert.deepEqual(await views.refresh(p), [], 'silence is reported once');
  assert.match(String(views.view(p, '2026-10-15').unreachableSince), /^2026-10-15T18:03/);
  reply = { status: 200, body: JSON.stringify(statusOf('acme')) };
  assert.deepEqual((await views.refresh(p)).map((n) => n.level), ['info']);
  assert.equal(views.view(p, '2026-10-15').reachable, true);
});
