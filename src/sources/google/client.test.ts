// fetchWithRetry / gfetch must hand every Response to the caller with its body UNREAD — the
// first real Gmail backfill died with "Body is unusable: Body has already been read" because the
// final 429 of an exhausted retry loop was returned after its body had been cancelled.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchWithRetry, gfetch, type Tokens } from './client.js';

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
