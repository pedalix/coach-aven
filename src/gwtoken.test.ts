import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  REFRESH_BEFORE_MS,
  auth0Mint,
  avenSessionValue,
  createGatewayTokens,
  createTokenCache,
  m2mEnvNames,
  oauthEnvNames,
  oauthMint,
  validateGatewayOAuth,
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
  await assert.rejects(tokens.get('caldora', { url: 'https://gw/caldora' }), /AUTH0_M2M_CALDORA_ID/);
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
  assert.equal(await tokens.get('caldora', { url: 'https://gw/caldora' }), 't1');
  assert.equal(await tokens.get('caldora', { url: 'https://gw/caldora' }), 't1');
  assert.equal(calls, 1);
});

// The bucket-2 pin (OpenSpec gateway-oauth-client-credentials, task 1.1): an entry without
// `oauth` must keep sending exactly today's Auth0 request — same URL, headers, JSON body, the
// same three env names and the `${slug}|${url}` cache key. Written against the code before the
// change; the request it asserts must never move.
test('createGatewayTokens: an entry without oauth sends today\'s Auth0 request, byte for byte', async () => {
  const read = new Set<string>();
  const env = new Proxy(
    {
      AUTH0_M2M_TOKEN_URL: 'https://tenant.example/oauth/token',
      AUTH0_M2M_CALDORA_ID: 'cid-1',
      AUTH0_M2M_CALDORA_SECRET: 'sec-1',
    } as Record<string, string | undefined>,
    { get: (t, k: string) => (read.add(k), t[k]) },
  );
  const sent: { url: string; method?: string; headers: unknown; body: string }[] = [];
  const f = (async (url: string, init?: RequestInit) => {
    sent.push({ url, method: init?.method, headers: init?.headers, body: String(init?.body) });
    return new Response(JSON.stringify({ access_token: 'AT', expires_in: 86400 }), { status: 200 });
  }) as unknown as typeof fetch;
  const tokens = createGatewayTokens(env, f);
  const url = 'https://engine.example.com/gw/caldora/mcp';
  assert.equal(await tokens.get('caldora', { url }), 'AT');
  assert.equal(await tokens.get('caldora', { url }), 'AT', 'same slug + url → the cached token');
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0], {
    url: 'https://tenant.example/oauth/token',
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{"grant_type":"client_credentials","client_id":"cid-1","client_secret":"sec-1","audience":"https://engine.example.com/gw/caldora/mcp"}',
  });
  assert.deepEqual([...read].sort(), ['AUTH0_M2M_CALDORA_ID', 'AUTH0_M2M_CALDORA_SECRET', 'AUTH0_M2M_TOKEN_URL']);
});

// ── the provider-neutral path (an `oauth` object) ────────────────────────────────────────

test('createTokenCache: a one-hour token is reused at 40 min left and replaced under 30 min', async () => {
  let t = 0;
  let mints = 0;
  const cache = createTokenCache(async () => {
    mints++;
    return { accessToken: `tok${mints}`, expiresAt: t + H };
  }, () => t);
  assert.equal(await cache.get(), 'tok1');
  t = 20 * 60_000;
  assert.equal(await cache.get(), 'tok1', '40 min left of a 1 h token → cached (today\'s rule would mint again)');
  t = 30 * 60_000 + 1;
  assert.equal(await cache.get(), 'tok2', 'under half the lifetime left → refreshed');
  assert.equal(mints, 2);
});

test('oauthEnvNames: GATEWAY_OAUTH_<SLUG>_ID / _SECRET, the m2mEnvNames mapping', () => {
  assert.deepEqual(oauthEnvNames('caldora'), { id: 'GATEWAY_OAUTH_CALDORA_ID', secret: 'GATEWAY_OAUTH_CALDORA_SECRET' });
  assert.deepEqual(oauthEnvNames('holidayshop-hsx'), {
    id: 'GATEWAY_OAUTH_HOLIDAYSHOP_HSX_ID',
    secret: 'GATEWAY_OAUTH_HOLIDAYSHOP_HSX_SECRET',
  });
});

type Seen = { url: string; headers: Record<string, string>; body: string };
function recordingFetch(status: number, body: unknown, seen: Seen[]) {
  return (async (url: string, init?: RequestInit) => {
    seen.push({ url, headers: init?.headers as Record<string, string>, body: String(init?.body) });
    return new Response(JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
}

test('oauthMint: HTTP Basic with a scope — a form body that carries no secret', async () => {
  const seen: Seen[] = [];
  const mint = oauthMint(
    {
      slug: 'caldora',
      tokenUrl: 'https://idp.example/oauth2/token',
      scope: 'gw-caldora/bot',
      clientId: 'id:1%',
      clientSecret: 's e:c%r',
    },
    recordingFetch(200, { access_token: 'AT', token_type: 'Bearer', expires_in: 86400 }, seen),
    () => 5,
  );
  assert.deepEqual(await mint(), { accessToken: 'AT', expiresAt: 5 + 86400_000 });
  assert.equal(seen[0].url, 'https://idp.example/oauth2/token');
  assert.equal(seen[0].headers['content-type'], 'application/x-www-form-urlencoded');
  assert.equal(seen[0].body, 'grant_type=client_credentials&scope=gw-caldora%2Fbot');
  // RFC 6749 §2.3.1: form-encode id and secret, THEN base64 — a ':' or '%' must not break the pair.
  const basic = Buffer.from(seen[0].headers.authorization.replace(/^Basic /, ''), 'base64').toString();
  assert.equal(basic, 'id%3A1%25:s+e%3Ac%25r');
  assert.ok(!seen[0].body.includes('client_secret') && !seen[0].body.includes('client_id'));
});

test('oauthMint: clientAuth "post" puts id and secret in the body and sends no Authorization', async () => {
  const seen: Seen[] = [];
  const mint = oauthMint(
    { slug: 'caldora', tokenUrl: 'https://idp.example/token', clientAuth: 'post', audience: 'https://gw.example/caldora', clientId: 'cid', clientSecret: 'sec' },
    recordingFetch(200, { access_token: 'AT' }, seen),
  );
  await mint();
  assert.equal(seen[0].headers.authorization, undefined);
  assert.equal(seen[0].body, 'grant_type=client_credentials&audience=https%3A%2F%2Fgw.example%2Fcaldora&client_id=cid&client_secret=sec');
});

test('oauthMint: a token without aud is fine — the bot never reads the token', async () => {
  const payload = Buffer.from(JSON.stringify({ client_id: 'cid', scope: 'gw-caldora/bot', token_use: 'access' })).toString('base64url');
  const jwt = `eyJhbGciOiJSUzI1NiJ9.${payload}.sig`;
  const mint = oauthMint(
    { slug: 'caldora', tokenUrl: 'https://idp.example/token', clientId: 'cid', clientSecret: 'sec' },
    recordingFetch(200, { access_token: jwt, token_type: 'Bearer', expires_in: 3600 }, []),
  );
  assert.equal((await mint()).accessToken, jwt);
});

test('oauthMint: a token that is not a bearer token is refused', async () => {
  const mint = oauthMint(
    { slug: 'caldora', tokenUrl: 'https://idp.example/token', clientId: 'cid', clientSecret: 'sec' },
    recordingFetch(200, { access_token: 'AT', token_type: 'DPoP' }, []),
  );
  await assert.rejects(mint(), /not a bearer token/);
});

test('oauthMint: an error names the status, the §5.2 code, the project and the origin — never the description or the id', async () => {
  const mint = oauthMint(
    { slug: 'caldora', tokenUrl: 'https://idp.example/oauth2/token', clientId: 'cid-77', clientSecret: 'sec' },
    recordingFetch(401, { error: 'invalid_client', error_description: 'client cid-77 is unknown' }, []),
  );
  await assert.rejects(mint(), (e: Error) =>
    /401 invalid_client/.test(e.message) &&
    e.message.includes('caldora') &&
    e.message.includes('https://idp.example') &&
    !e.message.includes('oauth2/token') &&
    !e.message.includes('cid-77'),
  );
});

const OAUTH = { tokenUrl: 'https://idp.example/oauth2/token', scope: 'gw-caldora/bot' };

test('createGatewayTokens: an oauth entry reads GATEWAY_OAUTH_<SLUG>_* and fails for that project only when they are missing', async () => {
  const tokens = createGatewayTokens({ GATEWAY_OAUTH_CALDORA_ID: 'cid' }, recordingFetch(200, {}, []));
  await assert.rejects(
    tokens.get('caldora', { url: 'http://gw.internal.example:4600/gw/caldora/mcp', oauth: OAUTH }),
    (e: Error) => e.message.includes('GATEWAY_OAUTH_CALDORA_ID') && e.message.includes('GATEWAY_OAUTH_CALDORA_SECRET') && !e.message.includes('AUTH0'),
  );
});

test('createGatewayTokens: an oauth entry is keyed by its token request, not its url', async () => {
  const seen: Seen[] = [];
  let n = 0;
  const f = (async (url: string, init?: RequestInit) => {
    seen.push({ url, headers: init?.headers as Record<string, string>, body: String(init?.body) });
    return new Response(JSON.stringify({ access_token: `t${++n}`, expires_in: 86400 }), { status: 200 });
  }) as unknown as typeof fetch;
  const tokens = createGatewayTokens({ GATEWAY_OAUTH_CALDORA_ID: 'cid', GATEWAY_OAUTH_CALDORA_SECRET: 'sec' }, f);
  const a = await tokens.get('caldora', { url: 'http://one.example/mcp', oauth: OAUTH });
  const b = await tokens.get('caldora', { url: 'http://two.example/mcp', oauth: { ...OAUTH, clientAuth: 'basic' } });
  const c = await tokens.get('caldora', { url: 'http://one.example/mcp', oauth: { ...OAUTH, scope: 'gw-caldora/other' } });
  assert.deepEqual([a, b, c], ['t1', 't1', 't2'], 'same request (default basic = basic) → one token; another scope → its own');
  assert.equal(seen.length, 2);
  assert.match(seen[1].body, /scope=gw-caldora%2Fother/);
});

test('validateGatewayOAuth: accepts the documented shape, refuses the rest naming the field', () => {
  assert.deepEqual(validateGatewayOAuth({ ...OAUTH, clientAuth: 'post' }, 'x.oauth'), { ...OAUTH, clientAuth: 'post' });
  const bad: [unknown, RegExp][] = [
    ['https://idp.example', /x\.oauth must be an object/],
    [{}, /tokenUrl must be an https URL/],
    [{ tokenUrl: 'http://idp.example/token' }, /tokenUrl must be an https URL/],
    [{ tokenUrl: 'not a url' }, /tokenUrl must be an https URL/],
    [{ ...OAUTH, scope: 3 }, /scope must be a non-empty string/],
    [{ ...OAUTH, audience: '' }, /audience must be a non-empty string/],
    [{ ...OAUTH, resource: ['r'] }, /resource must be a non-empty string/],
    [{ ...OAUTH, clientAuth: 'mtls' }, /clientAuth must be "basic" or "post"/],
    [{ ...OAUTH, clientSecret: 's' }, /clientSecret: client credentials go in the env/],
    [{ ...OAUTH, client_id: 'c' }, /client_id: client credentials go in the env/],
    [{ ...OAUTH, extra: 1 }, /extra is not a known field/],
  ];
  for (const [raw, re] of bad) assert.throws(() => validateGatewayOAuth(raw, 'x.oauth'), re, JSON.stringify(raw));
});

test('avenSessionValue: header- and shell-safe, bounded', () => {
  assert.equal(avenSessionValue('C09ABC:1727000000.123'), 'C09ABC:1727000000.123');
  assert.equal(avenSessionValue("dm:U1:caldora'; rm -rf /"), 'dm:U1:caldora___rm_-rf__');
  assert.equal(avenSessionValue('x'.repeat(500)).length, 120);
});
