import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  REFRESH_BEFORE_MS,
  auth0Mint,
  avenSessionValue,
  createGatewayTokens,
  createTokenCache,
  m2mEnvNames,
} from './gwtoken.js';

const H = 3600_000;

test('createTokenCache: reuses a token until less than an hour is left, then mints again', async () => {
  let t = 0;
  let mints = 0;
  const cache = createTokenCache(async () => {
    mints++;
    return { accessToken: `tok${mints}`, expiresAt: t + 24 * H };
  }, () => t);
  assert.equal(await cache.get(), 'tok1');
  t = 22 * H;
  assert.equal(await cache.get(), 'tok1', 'still 2 h left → cached');
  t = 24 * H - REFRESH_BEFORE_MS + 1;
  assert.equal(await cache.get(), 'tok2', 'under 1 h left → refreshed');
  assert.equal(mints, 2);
});

test('createTokenCache: concurrent callers share one mint (single-flight)', async () => {
  let mints = 0;
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const cache = createTokenCache(async () => {
    mints++;
    await gate;
    return { accessToken: 'tok', expiresAt: Date.now() + 24 * H };
  });
  const all = Promise.all([cache.get(), cache.get(), cache.get()]);
  release();
  assert.deepEqual(await all, ['tok', 'tok', 'tok']);
  assert.equal(mints, 1);
});

test('createTokenCache: a failed mint is not cached — the next call retries', async () => {
  let n = 0;
  const cache = createTokenCache(async () => {
    n++;
    if (n === 1) throw new Error('boom');
    return { accessToken: 'ok', expiresAt: Date.now() + 24 * H };
  });
  await assert.rejects(cache.get(), /boom/);
  assert.equal(await cache.get(), 'ok');
});

test('m2mEnvNames: upper-cases the slug and maps dashes to underscores', () => {
  assert.deepEqual(m2mEnvNames('caldora'), { id: 'AUTH0_M2M_CALDORA_ID', secret: 'AUTH0_M2M_CALDORA_SECRET' });
  assert.deepEqual(m2mEnvNames('holidayshop-hsx'), {
    id: 'AUTH0_M2M_HOLIDAYSHOP_HSX_ID',
    secret: 'AUTH0_M2M_HOLIDAYSHOP_HSX_SECRET',
  });
});

function fakeFetch(status: number, body: unknown, seen?: { url?: string; body?: string }) {
  return (async (url: string, init?: RequestInit) => {
    if (seen) {
      seen.url = url;
      seen.body = String(init?.body);
    }
    return new Response(JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
}

test('auth0Mint: client_credentials with the audience; expiry from expires_in', async () => {
  const seen: { url?: string; body?: string } = {};
  const mint = auth0Mint(
    { tokenUrl: 'https://t/oauth/token', clientId: 'cid', clientSecret: 'sec', audience: 'https://gw/x' },
    fakeFetch(200, { access_token: 'AT', expires_in: 86400 }, seen),
    () => 1000,
  );
  const t = await mint();
  assert.equal(t.accessToken, 'AT');
  assert.equal(t.expiresAt, 1000 + 86400_000);
  assert.equal(seen.url, 'https://t/oauth/token');
  const sent = JSON.parse(seen.body!);
  assert.equal(sent.grant_type, 'client_credentials');
  assert.equal(sent.audience, 'https://gw/x');
});

test('auth0Mint: an error response names the Auth0 code, never echoes the body', async () => {
  const mint = auth0Mint(
    { tokenUrl: 'https://t', clientId: 'cid', clientSecret: 'sec', audience: 'https://gw/x' },
    fakeFetch(401, { error: 'access_denied', error_description: 'client cid is bad' }),
  );
  await assert.rejects(mint(), (e: Error) => /401 access_denied/.test(e.message) && !e.message.includes('cid is bad'));
});

test('createGatewayTokens: missing credentials fail for that project with the env names', async () => {
  const tokens = createGatewayTokens({ AUTH0_M2M_TOKEN_URL: 'https://t' }, fakeFetch(200, {}));
  await assert.rejects(tokens.get('caldora', 'https://gw/caldora'), /AUTH0_M2M_CALDORA_ID/);
});

test('createGatewayTokens: one cache per (slug, audience)', async () => {
  let calls = 0;
  const f = (async () => {
    calls++;
    return new Response(JSON.stringify({ access_token: `t${calls}`, expires_in: 86400 }), { status: 200 });
  }) as unknown as typeof fetch;
  const env = {
    AUTH0_M2M_TOKEN_URL: 'https://t',
    AUTH0_M2M_CALDORA_ID: 'a',
    AUTH0_M2M_CALDORA_SECRET: 'b',
  };
  const tokens = createGatewayTokens(env, f);
  assert.equal(await tokens.get('caldora', 'https://gw/caldora'), 't1');
  assert.equal(await tokens.get('caldora', 'https://gw/caldora'), 't1');
  assert.equal(calls, 1);
});

test('avenSessionValue: header- and shell-safe, bounded', () => {
  assert.equal(avenSessionValue('C09ABC:1727000000.123'), 'C09ABC:1727000000.123');
  assert.equal(avenSessionValue("dm:U1:caldora'; rm -rf /"), 'dm:U1:caldora___rm_-rf__');
  assert.equal(avenSessionValue('x'.repeat(500)).length, 120);
});
