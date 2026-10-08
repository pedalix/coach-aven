// fetchWithRetry / gfetch must hand every Response to the caller with its body UNREAD — the
// first real Gmail backfill died with "Body is unusable: Body has already been read" because the
// final 429 of an exhausted retry loop was returned after its body had been cancelled.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QuotaBucket, fetchWithRetry, gfetch, isRateLimitBody, rateLimitBackoffMs, retryClock, type Tokens } from './client.js';

function fakeFetch(statuses: number[]): { calls: number } & typeof fetch {
  const fn = (async (_url: string | URL | Request, _init?: RequestInit) => {
    const status = statuses[Math.min(fn.calls, statuses.length - 1)]!;
    fn.calls++;
    // retry-after: 0 keeps the backoff instant; the status decides the branch under test.
    return new Response(JSON.stringify({ status }), { status, headers: { 'retry-after': '0', 'content-type': 'application/json' } });
  }) as { calls: number } & typeof fetch;
  fn.calls = 0;
  return fn;
}

async function withFetch<T>(f: typeof fetch, run: () => Promise<T>): Promise<T> {
  const orig = globalThis.fetch;
  globalThis.fetch = f;
  try {
    return await run();
  } finally {
    globalThis.fetch = orig;
  }
}

test('fetchWithRetry: 429 then 200 → the 200 is returned with a readable body', async () => {
  const f = fakeFetch([429, 200]);
  const res = await withFetch(f, () => fetchWithRetry('https://x/api', {}));
  assert.equal(res.status, 200);
  assert.deepEqual(JSON.parse(await res.text()), { status: 200 });
  assert.equal(f.calls, 2);
});

test('fetchWithRetry: attempts exhausted on 429 → the LAST response is returned unread, not cancelled', async () => {
  const f = fakeFetch([429]);
  const res = await withFetch(f, () => fetchWithRetry('https://x/api', {}));
  assert.equal(res.status, 429);
  // This is the regression: a cancelled body throws "Body is unusable" here.
  assert.deepEqual(JSON.parse(await res.text()), { status: 429 });
  assert.equal(f.calls, 8);
});

test('fetchWithRetry: 403 without a rate-limit reason fails fast with a readable body', async () => {
  const f = fakeFetch([403, 200]);
  const res = await withFetch(f, () => fetchWithRetry('https://x/api', {}));
  assert.equal(res.status, 403);
  assert.deepEqual(JSON.parse(await res.text()), { status: 403 });
  assert.equal(f.calls, 1);
});

test('gfetch: 401 then 200 → token refreshed once, final body readable', async () => {
  const f = fakeFetch([401, 200]);
  const forced: boolean[] = [];
  const tokens = { access: async (_a: string, force = false) => { forced.push(force); return `tok${forced.length}`; } } as unknown as Tokens;
  const res = await withFetch(f, () => gfetch(tokens, 'me@x', 'https://x/api'));
  assert.equal(res.status, 200);
  assert.deepEqual(JSON.parse(await res.text()), { status: 200 });
  assert.deepEqual(forced, [false, true]);
});

// ── quota: the second live backfill died on "Quota exceeded … Units per minute per user" (403) ──

const QUOTA_403 = JSON.stringify({
  error: {
    code: 403,
    message: "Quota exceeded for quota metric 'Total Query Cost' and limit 'Units per minute per user' of service 'gmail.googleapis.com' for consumer 'project_number:1'.",
    errors: [{ message: 'Quota exceeded', domain: 'usageLimits', reason: 'rateLimitExceeded' }],
    status: 'PERMISSION_DENIED',
  },
});

test('isRateLimitBody: parses the envelope — quota/rate reasons yes, missing scope no, garbage no', () => {
  assert.equal(isRateLimitBody(QUOTA_403), true);
  assert.equal(isRateLimitBody(JSON.stringify({ error: { status: 'RESOURCE_EXHAUSTED', message: 'x' } })), true);
  assert.equal(isRateLimitBody(JSON.stringify({ error: { message: 'Quota exceeded for quota metric' } })), true);
  assert.equal(isRateLimitBody(JSON.stringify({ error: { code: 403, status: 'PERMISSION_DENIED', message: 'Request had insufficient authentication scopes.', errors: [{ reason: 'insufficientPermissions' }] } })), false);
  assert.equal(isRateLimitBody('<html>rateLimitExceeded</html>'), false);
});

test('rateLimitBackoffMs: ≥15 s first, doubles, capped at 60 s (+ ≤5 s jitter)', () => {
  const zero = () => 0;
  assert.deepEqual([0, 1, 2, 3, 7].map((a) => rateLimitBackoffMs(a, zero)), [15_000, 30_000, 60_000, 60_000, 60_000]);
  assert.ok(rateLimitBackoffMs(0, () => 0.999) < 20_000);
});

test('fetchWithRetry: quota 403 → waits on the minute schedule → 200', async () => {
  const waits: number[] = [];
  const orig = retryClock.sleep;
  retryClock.sleep = async (ms) => { waits.push(ms); };
  let calls = 0;
  const f = (async () => {
    calls++;
    return calls === 1
      ? new Response(QUOTA_403, { status: 403, headers: { 'content-type': 'application/json' } })
      : new Response('{"ok":true}', { status: 200 });
  }) as unknown as typeof fetch;
  try {
    const res = await withFetch(f, () => fetchWithRetry('https://x/api', {}));
    assert.equal(res.status, 200);
    assert.equal(calls, 2);
    assert.equal(waits.length, 1);
    assert.ok(waits[0]! >= 15_000, `first quota wait ${waits[0]} ms`);
  } finally {
    retryClock.sleep = orig;
  }
});

test('QuotaBucket: burst up to capacity, then paced at the configured rate (fake clock)', async () => {
  let t = 0;
  const slept: number[] = [];
  const b = new QuotaBucket(3_600, 600, () => t, async (ms) => { slept.push(ms); t += ms; });
  // 600 units of burst = 30 gets at 20 units, no waiting.
  for (let i = 0; i < 30; i++) await b.take(20);
  assert.deepEqual(slept, []);
  // Empty: the next get needs 20 units at 60 units/s → 334 ms (ceil).
  assert.equal(b.waitFor(20), 334);
  await b.take(20);
  assert.equal(slept.length, 1);
  // Over a simulated minute the bucket admits ≈ rate + capacity, never more.
  t = 0;
  const b2 = new QuotaBucket(3_600, 600, () => t, async (ms) => { t += ms; });
  let got = 0;
  while (t < 60_000) { await b2.take(20); got++; }
  assert.ok(got <= (3_600 + 600) / 20 + 1, `admitted ${got} gets in 60 s`);
  assert.ok(got >= 3_600 / 20, `admitted only ${got}`);
});

test('QuotaBucket: concurrent takers are serialised (no thundering herd)', async () => {
  let t = 0;
  const b = new QuotaBucket(60, 20, () => t, async (ms) => { t += ms; });
  await Promise.all([b.take(20), b.take(20), b.take(20)]);
  // 20 units of burst, then 20 more each at 1 unit/s → 40 s total.
  assert.equal(t, 40_000);
});
