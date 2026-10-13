import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { categoryFromName, iso, scrubTask, type TaskRecord } from './task.js';
import { createHttp, retryAfterMs, TrackerHttpError } from './http.js';
import { parseNetrc } from './netrc.js';
import { CURSOR_OVERLAP_MS, readCursor, runTrackerPull, startFrom } from './writer.js';
import { parseFlags } from './auth.js';

const base: TaskRecord = {
  source: 'jira', account: 'acme.atlassian.net', id: '10001', key: 'P1-1', title: 'Rotate keys', status: 'In Progress',
  statusCategory: 'doing', assignee: 'owen@x.com', reporter: 'tobin@x.com', due: '2026-10-10', created: '2026-10-01T00:00:00.000Z',
  updated: '2026-10-05T10:00:00.000Z', project: 'P1', url: 'https://acme.atlassian.net/browse/P1-1', labels: ['security'],
  text: 'Plain description, nothing secret.', comments: [],
};

test('categoryFromName buckets common workflow names', () => {
  assert.equal(categoryFromName('In Progress'), 'doing');
  assert.equal(categoryFromName('Code Review'), 'doing');
  assert.equal(categoryFromName('Done'), 'done');
  assert.equal(categoryFromName("Won't fix"), 'done');
  assert.equal(categoryFromName('Open'), 'todo');
  assert.equal(categoryFromName('Submitted', true), 'done');
});

test('iso accepts epoch ms and ISO strings', () => {
  assert.equal(iso(Date.UTC(2026, 9, 1)), '2026-10-01T00:00:00.000Z');
  assert.equal(iso('2026-10-01T12:00:00+02:00'), '2026-10-01T10:00:00.000Z');
  assert.equal(iso(null), '');
});

test('scrubTask withholds only the carrier comment, redacts inline elsewhere', () => {
  const t: TaskRecord = {
    ...base,
    text: 'Deploy notes. password: Hunter2xyz99',
    comments: [
      { id: 'c1', author: 'a@x.com', ts: '2026-10-02T00:00:00.000Z', text: 'looks good' },
      { id: 'c2', author: 'b@x.com', ts: '2026-10-03T00:00:00.000Z', text: 'prod db: mysql://root:S3cr3tPass@db.prod.example:3306/app' },
    ],
  };
  const s = scrubTask(t);
  assert.equal(s.comments[0]!.text, 'looks good');
  assert.match(s.comments[1]!.text, /BODY WITHHELD/);
  assert.doesNotMatch(JSON.stringify(s), /S3cr3tPass|Hunter2xyz99/);
  assert.equal(s.scrub.withheld, true);
  assert.ok(s.scrub.kinds.includes('dsn'));
});

test('http: 429 then 200 reads each body once and returns JSON', async () => {
  let calls = 0;
  const slept: number[] = [];
  const fetchImpl = (async () => {
    calls++;
    if (calls === 1) return new Response('slow down', { status: 429, headers: { 'retry-after': '3' } });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as unknown as typeof fetch;
  const http = createHttp({ headers: {}, fetchImpl, sleep: async (ms) => void slept.push(ms) });
  const r = await http.get('https://x/api');
  assert.deepEqual(r.json, { ok: true });
  assert.equal(calls, 2);
  assert.deepEqual(slept, [3000]);
});

test('http: exhausted retries surface a readable error; 401 is reauth', async () => {
  const always429 = (async () => new Response('quota', { status: 429 })) as unknown as typeof fetch;
  const http = createHttp({ headers: {}, fetchImpl: always429, sleep: async () => {}, maxAttempts: 3 });
  await assert.rejects(http.get('https://x/api'), (e: unknown) => e instanceof TrackerHttpError && e.status === 429 && /quota/.test(e.message) && !e.reauth);
  const unauth = (async () => new Response('{"error":"bad token"}', { status: 401 })) as unknown as typeof fetch;
  await assert.rejects(createHttp({ headers: {}, fetchImpl: unauth }).get('https://x/api'), (e: unknown) => e instanceof TrackerHttpError && e.reauth);
});

test('http: client-side pacing spaces requests', async () => {
  let clock = 0;
  const slept: number[] = [];
  const fetchImpl = (async () => new Response('{}', { status: 200 })) as unknown as typeof fetch;
  const http = createHttp({ headers: {}, fetchImpl, minIntervalMs: 450, now: () => clock, sleep: async (ms) => { slept.push(ms); clock += ms; } });
  await http.get('https://x/1');
  await http.get('https://x/2');
  await http.get('https://x/3');
  assert.deepEqual(slept, [450, 450]);
});

test('retryAfterMs parses seconds and HTTP dates', () => {
  assert.equal(retryAfterMs('5', 0), 5000);
  assert.equal(retryAfterMs(new Date(10_000).toUTCString(), 0), 10_000);
  assert.equal(retryAfterMs(null, 0), undefined);
});

test('netrc: machine entries, multi-line tokens, default ignored', () => {
  const m = parseNetrc('machine a.example login u1 password p1\nmachine B.example\n  login u2\n  password p2\ndefault login x password y\n');
  assert.deepEqual(m.get('a.example'), { login: 'u1', password: 'p1' });
  assert.deepEqual(m.get('b.example'), { login: 'u2', password: 'p2' });
  assert.equal(m.size, 2);
});

test('startFrom: cursor minus overlap, else since, else 90 days', () => {
  const now = new Date('2026-10-07T00:00:00Z');
  assert.equal(startFrom({ updated: '2026-10-06T12:00:00.000Z' }, '2026-09-01', now).getTime(), Date.parse('2026-10-06T12:00:00.000Z') - CURSOR_OVERLAP_MS);
  assert.equal(startFrom({}, '2026-09-01', now).toISOString(), '2026-09-01T00:00:00.000Z');
  assert.equal(startFrom({ updated: '2026-10-06T12:00:00.000Z' }, '2026-09-01', now, true).toISOString(), '2026-09-01T00:00:00.000Z');
  assert.equal(startFrom({}, undefined, now).toISOString(), '2026-07-09T00:00:00.000Z');
});

test('runTrackerPull writes scrubbed JSONL and advances the cursor only on success', async () => {
  const out = mkdtempSync(join(tmpdir(), 'trk-'));
  const lines: string[] = [];
  const ctx = { slug: 't', outDir: out, tokenPath: '/nope', log: (l: string) => void lines.push(l) };
  async function* two() {
    yield base;
    yield { ...base, id: '10002', key: 'P1-2', updated: '2026-10-06T09:00:00.000Z' };
  }
  const s = await runTrackerPull(ctx, { kind: 'jira', account: 'acme.atlassian.net', since: '2026-09-15', fetchUpdated: () => two() });
  assert.equal(s.ok, true);
  assert.equal(s.counts['acme.atlassian.net/tasks'], 2);
  const dir = join(out, 'jira', 'acme.atlassian.net');
  assert.equal(readFileSync(join(dir, 'tasks.jsonl'), 'utf8').trim().split('\n').length, 2);
  assert.equal(readCursor(dir).updated, '2026-10-06T09:00:00.000Z');
  async function* boom(): AsyncIterable<TaskRecord> {
    yield { ...base, id: '10003', updated: '2026-10-07T00:00:00.000Z' };
    throw new TrackerHttpError(401, 'https://x', 'nope');
  }
  const f = await runTrackerPull(ctx, { kind: 'jira', account: 'acme.atlassian.net', fetchUpdated: () => boom() });
  assert.equal(f.ok, false);
  assert.equal(f.reauth, true);
  assert.equal(readCursor(dir).updated, '2026-10-06T09:00:00.000Z');
});

test('runTrackerPull: rows unchanged since the last pass are not re-appended; a change is; a failed pass leaves the cursor + map alone', async () => {
  const out = mkdtempSync(join(tmpdir(), 'trk-'));
  const ctx = { slug: 't', outDir: out, tokenPath: '/nope', log: () => undefined };
  const dir = join(out, 'jira', 'acme.atlassian.net');
  const linesOf = () => readFileSync(join(dir, 'tasks.jsonl'), 'utf8').trim().split('\n');
  const second: TaskRecord = { ...base, id: '10002', key: 'P1-2', updated: '2026-10-06T09:00:00.000Z' };
  async function* pass(rows: TaskRecord[]): AsyncIterable<TaskRecord> {
    for (const r of rows) yield r;
  }
  const pull = (rows: TaskRecord[]) => runTrackerPull(ctx, { kind: 'jira', account: 'acme.atlassian.net', since: '2026-09-15', fetchUpdated: () => pass(rows) });
  // Pass 1: everything is new.
  assert.equal((await pull([base, second])).counts['acme.atlassian.net/tasks'], 2);
  assert.deepEqual(Object.keys(readCursor(dir).hashes ?? {}).sort(), ['10001', '10002']);
  // Pass 2: the inclusive cursor hands back the same two rows — nothing is appended; the pass still succeeds.
  const s2 = await pull([base, second]);
  assert.equal(s2.ok, true);
  assert.equal(s2.counts['acme.atlassian.net/tasks'], 0);
  assert.equal(linesOf().length, 2);
  assert.equal(readCursor(dir).updated, '2026-10-06T09:00:00.000Z');
  // Pass 3: a new comment on one of them → one line; the other stays deduped; the cursor moves.
  const commented: TaskRecord = { ...base, updated: '2026-10-07T08:00:00.000Z', comments: [{ id: 'c1', author: 'a@x.com', ts: '2026-10-07T08:00:00.000Z', text: 'ping' }] };
  assert.equal((await pull([commented, second])).counts['acme.atlassian.net/tasks'], 1);
  assert.equal(linesOf().length, 3);
  assert.equal(readCursor(dir).updated, '2026-10-07T08:00:00.000Z');
  // Pass 4: only the ids of the last pass stay in the map (bounded), so a row that leaves the window and comes back is appended once more.
  assert.equal((await pull([commented])).counts['acme.atlassian.net/tasks'], 0);
  assert.deepEqual(Object.keys(readCursor(dir).hashes ?? {}), ['10001']);
  assert.equal((await pull([commented, second])).counts['acme.atlassian.net/tasks'], 1);
  // Pass 5: a failure after a changed row — the row is on disk (the store dedupes the re-append), cursor and map untouched.
  const before = readFileSync(join(dir, 'cursor.json'), 'utf8');
  async function* boom(): AsyncIterable<TaskRecord> {
    yield { ...commented, title: 'Rotate keys NOW', updated: '2026-10-08T00:00:00.000Z' };
    throw new TrackerHttpError(500, 'https://x', 'boom');
  }
  const f = await runTrackerPull(ctx, { kind: 'jira', account: 'acme.atlassian.net', fetchUpdated: () => boom() });
  assert.equal(f.ok, false);
  assert.equal(readFileSync(join(dir, 'cursor.json'), 'utf8'), before);
  assert.equal(linesOf().length, 5);
});

test('parseFlags: positionals and --k v pairs', () => {
  assert.deepEqual(parseFlags(['add', '--token-env', 'X', '--email', 'a@b.c']), { pos: ['add'], flags: { 'token-env': 'X', email: 'a@b.c' } });
  assert.deepEqual(parseFlags(['check', '--verbose']), { pos: ['check'], flags: { verbose: 'true' } });
});
