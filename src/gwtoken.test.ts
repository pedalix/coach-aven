import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  REFRESH_BEFORE_MS,
  avenSessionValue,
  createGatewayTokens,
  createTokenCache,
  describeTokenRequest,
  legacyGatewayProjects,
  oauthEnvNames,
  oauthMint,
  resolveOAuthCredentials,
  sharedTokenRequests,
  validateGatewayOAuth,
  type GatewayOAuth,
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

// ── the `oauth` request ────────────────────────────────────────

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

test('oauthEnvNames: GATEWAY_OAUTH_<SLUG>_ID / _SECRET, the slug upper-cased, other characters to underscores', () => {
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

// ── one client pair per installation (OpenSpec gateway-installation-client) ─────────────

const basicUser = (h: Record<string, string>) => Buffer.from(h.authorization!.replace(/^Basic /, ''), 'base64').toString();

// The bucket-2 pin (task 1.1 a), written against the code before the change: a project with its
// own complete pair keeps authenticating with it, whatever installation pair sits beside it.
test('createGatewayTokens: an oauth entry with its own complete pair uses it, even beside the installation pair', async () => {
  const seen: Seen[] = [];
  const env = {
    GATEWAY_OAUTH_CALDORA_ID: 'cid-own',
    GATEWAY_OAUTH_CALDORA_SECRET: 'sec-own',
    GATEWAY_OAUTH_ID: 'cid-inst',
    GATEWAY_OAUTH_SECRET: 'sec-inst',
  };
  const tokens = createGatewayTokens(env, recordingFetch(200, { access_token: 'AT', expires_in: 86400 }, seen));
  assert.equal(await tokens.get('caldora', { url: 'https://gw.example/gw/caldora/mcp', oauth: OAUTH }), 'AT');
  assert.equal(basicUser(seen[0]!.headers), 'cid-own:sec-own');
});

const INST = { GATEWAY_OAUTH_ID: 'cid-inst', GATEWAY_OAUTH_SECRET: 'sec-inst' };
const OWN = { GATEWAY_OAUTH_CALDORA_ID: 'cid-own', GATEWAY_OAUTH_CALDORA_SECRET: 'sec-own' };

test('resolveOAuthCredentials: the own pair, else the installation pair; a half pair or nothing is an error naming env vars only', () => {
  assert.deepEqual(resolveOAuthCredentials(INST, 'caldora'), { clientId: 'cid-inst', clientSecret: 'sec-inst', source: 'installation' });
  assert.deepEqual(resolveOAuthCredentials({ ...INST, ...OWN }, 'caldora'), { clientId: 'cid-own', clientSecret: 'sec-own', source: 'project' });
  const errorOf = (env: Record<string, string | undefined>) => {
    const r = resolveOAuthCredentials(env, 'caldora');
    assert.ok('error' in r, JSON.stringify(Object.keys(env)));
    assert.ok(!/cid-|sec-/.test(r.error), 'no value in the message');
    return r.error;
  };
  // a half project pair never falls back, whichever half is set
  for (const half of [{ GATEWAY_OAUTH_CALDORA_ID: 'cid-own' }, { GATEWAY_OAUTH_CALDORA_SECRET: 'sec-own' }]) {
    const e = errorOf({ ...INST, ...half });
    assert.match(e, /GATEWAY_OAUTH_CALDORA_ID and GATEWAY_OAUTH_CALDORA_SECRET must both be set/);
  }
  // nothing, or a half installation pair: all four names
  for (const env of [{}, { GATEWAY_OAUTH_ID: 'cid-inst' }]) {
    const e = errorOf(env);
    for (const n of ['GATEWAY_OAUTH_CALDORA_ID', 'GATEWAY_OAUTH_CALDORA_SECRET', 'GATEWAY_OAUTH_ID', 'GATEWAY_OAUTH_SECRET']) assert.ok(e.includes(n), n);
  }
});

test('createGatewayTokens: an oauth entry without its own pair authenticates with the installation pair', async () => {
  const seen: Seen[] = [];
  const tokens = createGatewayTokens(INST, recordingFetch(200, { access_token: 'AT', expires_in: 86400 }, seen));
  assert.equal(await tokens.get('caldora', { url: 'https://gw.example/gw/caldora/mcp', oauth: OAUTH }), 'AT');
  assert.equal(basicUser(seen[0]!.headers), 'cid-inst:sec-inst');
  assert.ok(!seen[0]!.body.includes('sec-inst'), 'Basic: no secret in the body');
});

test('createGatewayTokens: a half project pair rejects for that project and sends nothing', async () => {
  const seen: Seen[] = [];
  const tokens = createGatewayTokens({ ...INST, GATEWAY_OAUTH_CALDORA_ID: 'cid-own' }, recordingFetch(200, { access_token: 'AT' }, seen));
  await assert.rejects(tokens.get('caldora', { url: 'https://gw.example/gw/caldora/mcp', oauth: OAUTH }), /GATEWAY_OAUTH_CALDORA_SECRET/);
  assert.equal(seen.length, 0);
});

// Leftover AUTH0_M2M_* lines (an installation that moved its entries but not its .env) change
// nothing: the request is the oauth one, from the GATEWAY_OAUTH_* credentials (OpenSpec
// retire-auth0-gateway-path).
test('createGatewayTokens: leftover AUTH0_M2M_* variables are never read', async () => {
  const read = new Set<string>();
  const env = new Proxy(
    { ...INST, AUTH0_M2M_TOKEN_URL: 'https://old.example/oauth/token', AUTH0_M2M_CALDORA_ID: 'cid-old', AUTH0_M2M_CALDORA_SECRET: 'sec-old' } as Record<string, string | undefined>,
    { get: (t, k: string) => (read.add(k), t[k]) },
  );
  const seen: Seen[] = [];
  const tokens = createGatewayTokens(env, recordingFetch(200, { access_token: 'AT', expires_in: 86400 }, seen));
  assert.equal(await tokens.get('caldora', { url: 'https://gw.example/gw/caldora/mcp', oauth: OAUTH }), 'AT');
  assert.equal(seen[0]!.url, OAUTH.tokenUrl);
  assert.equal(basicUser(seen[0]!.headers), 'cid-inst:sec-inst');
  assert.deepEqual([...read].filter((k) => k.startsWith('AUTH0')), []);
});

// ── the checks at config load ───────────────────────────────────────────────────────────

const AUTH0 = (slug: string): GatewayOAuth => ({ tokenUrl: 'https://tenant.example/oauth/token', audience: `https://gw.example/gw/${slug}/mcp` });
const gwProject = (slug: string, oauth?: GatewayOAuth) => ({ slug, mcp: [{ name: 'gw', auth: 'gateway-m2m', ...(oauth ? { oauth } : {}) }] });

test('sharedTokenRequests: two projects on the installation pair asking for one token form a group; distinct tokens, own clients or no installation pair do not', () => {
  const copied = [gwProject('caldora', AUTH0('caldora')), gwProject('verdant', AUTH0('caldora'))];
  assert.deepEqual(sharedTokenRequests(copied, INST), [{ slugs: ['caldora', 'verdant'], request: AUTH0('caldora') }]);
  // however the client authenticates: basic or post, the token is the same
  assert.equal(sharedTokenRequests([gwProject('caldora', AUTH0('caldora')), gwProject('verdant', { ...AUTH0('caldora'), clientAuth: 'post' })], INST).length, 1);
  // one audience per route
  assert.deepEqual(sharedTokenRequests([gwProject('caldora', AUTH0('caldora')), gwProject('verdant', AUTH0('verdant'))], INST), []);
  // verdant has its own client
  assert.deepEqual(sharedTokenRequests(copied, { ...INST, GATEWAY_OAUTH_VERDANT_ID: 'v', GATEWAY_OAUTH_VERDANT_SECRET: 'w' }), []);
  // no installation pair: every project has its own client (or fails at mint, as before)
  assert.deepEqual(sharedTokenRequests(copied, {}), []);
  // two entries of ONE project asking for the same token
  const twice = { slug: 'caldora', mcp: [{ name: 'gw', auth: 'gateway-m2m', oauth: AUTH0('caldora') }, { name: 'gw2', auth: 'gateway-m2m', oauth: AUTH0('caldora') }] };
  assert.deepEqual(sharedTokenRequests([twice], INST), []);
  // entries without oauth are not on the installation pair
  assert.deepEqual(sharedTokenRequests([gwProject('caldora'), gwProject('verdant')], INST), []);
});

test('describeTokenRequest: the origin and the fields that are set', () => {
  assert.equal(describeTokenRequest(AUTH0('caldora')), 'https://tenant.example, audience https://gw.example/gw/caldora/mcp');
  assert.equal(describeTokenRequest(OAUTH), 'https://idp.example, scope gw-caldora/bot');
});

test('legacyGatewayProjects: the projects with a gateway entry without oauth', () => {
  const direct = { slug: 'ember', mcp: [{ name: 'docs' }] };
  assert.deepEqual(legacyGatewayProjects([gwProject('caldora'), gwProject('verdant', AUTH0('verdant')), gwProject('alder'), direct, { slug: 'bare' }]), ['caldora', 'alder']);
});
