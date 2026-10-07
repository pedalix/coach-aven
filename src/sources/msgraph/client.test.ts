/**
 * Behavioural tests for the token/HTTP layer against a local mock of Entra + Graph.
 * The mock is reached by setting MSGRAPH_LOGIN_BASE / MSGRAPH_API_BASE BEFORE `client.ts` is
 * imported (it reads them at module load), hence the dynamic import. The token store is an
 * instance pointed at a temp file.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'msgraph-test-'));
const storePath = join(dir, 'msgraph.json');

let server: Server;
let base: string;
let refreshCalls = 0;
let rtCounter = 0;
const hits: Record<string, number> = {};
let failRefreshWith: { error: string; codes: number[] } | undefined;

function fakeJwt(scp: string): string {
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'none' })}.${b64({ scp })}.sig`;
}

before(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    hits[url.pathname] = (hits[url.pathname] ?? 0) + 1;
    const json = (status: number, body: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, { 'content-type': 'application/json', ...headers });
      res.end(JSON.stringify(body));
    };
    if (url.pathname.endsWith('/oauth2/v2.0/token')) {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const p = new URLSearchParams(body);
        refreshCalls++;
        assert.equal(p.get('grant_type'), 'refresh_token');
        assert.equal(p.get('client_secret'), null, 'public client must not send a secret');
        if (failRefreshWith) return json(400, { error: failRefreshWith.error, error_description: 'AADSTS' + failRefreshWith.codes[0] + ': dead', error_codes: failRefreshWith.codes });
        // Entra rotates: every response carries a NEW refresh token; the request must carry the latest one.
        assert.equal(p.get('refresh_token'), `rt-${rtCounter}`);
        rtCounter++;
        json(200, { token_type: 'Bearer', expires_in: 3600, scope: 'Mail.Read', access_token: fakeJwt(`User.Read Mail.Read${p.get('scope')?.includes('ChannelMessage') ? ' ChannelMessage.Read.All' : ''}`), refresh_token: `rt-${rtCounter}` });
      });
      return;
    }
    const auth = req.headers.authorization ?? '';
    assert.equal(req.headers['user-agent'], 'NONISV|Pedalix|coach-aven-sources/1.0');
    switch (url.pathname) {
      case '/v1.0/throttled':
        if ((hits[url.pathname] ?? 0) < 3) return json(429, { error: { code: 'TooManyRequests', message: 'slow down' } }, { 'retry-after': '1' });
        return json(200, { value: ['ok'] });
      case '/v1.0/expired':
        if (auth.endsWith('stale')) return json(401, { error: { code: 'InvalidAuthenticationToken', message: 'expired' } });
        return json(200, { value: ['fresh'] });
      case '/v1.0/paged':
        return json(200, { value: [1, 2], '@odata.nextLink': `${base}/v1.0/paged2` });
      case '/v1.0/paged2':
        return json(200, { value: [3], '@odata.deltaLink': `${base}/v1.0/paged?token=abc` });
      case '/v1.0/forbidden':
        return json(403, { error: { code: 'Forbidden', message: 'Missing scope permissions on the request. API requires one of ChannelMessage.Read.All' } });
      default:
        return json(404, { error: { code: 'NotFound', message: url.pathname } });
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  process.env.MSGRAPH_LOGIN_BASE = base;
  process.env.MSGRAPH_API_BASE = base;
});
after(() => server.close());

async function client() {
  const c = await import('./client.js');
  return { ...c, store: new c.MsTokenStore(storePath) };
}

test('store: written atomically with mode 600; refresh rotates the token and persists before use', async () => {
  const c = await client();
  c.store.write({
    version: 1,
    accounts: {
      't:owen@x.com': {
        key: 't:owen@x.com', tenant_id: 't', client_id: 'app', upn: 'owen@x.com', user_id: 'u', scopes: ['User.Read', 'Mail.Read', 'offline_access'],
        refresh_token: 'rt-0', obtained_via: 'pkce', obtained_at: new Date().toISOString(),
      },
    },
  });
  assert.equal(statSync(storePath).mode & 0o777, 0o600);
  const a1 = await c.store.refreshAccount('t:owen@x.com');
  assert.equal(a1.refresh_token, 'rt-1');
  assert.equal(JSON.parse(readFileSync(storePath, 'utf8')).accounts['t:owen@x.com'].refresh_token, 'rt-1', 'rotated token persisted');
  // Cached access token is reused; a forced refresh rotates again from the persisted token.
  assert.equal(await c.store.getAccessToken('t:owen@x.com'), a1.access_token);
  const a2 = await c.store.refreshAccount('t:owen@x.com');
  assert.equal(a2.refresh_token, 'rt-2');
  assert.equal(a2.refresh_count, 2);
  // Account lookup by UPN works too (convenience for --account on the CLI).
  assert.equal(c.store.getAccount('owen@x.com').key, 't:owen@x.com');
});

test('refresh: concurrent refreshers are serialised by the lock (no forked rotation chain)', async () => {
  const c = await client();
  const before = rtCounter;
  await Promise.all([c.store.refreshAccount('t:owen@x.com'), c.store.refreshAccount('t:owen@x.com'), c.store.refreshAccount('t:owen@x.com')]);
  assert.equal(rtCounter, before + 3);
  assert.equal(c.store.getAccount('t:owen@x.com').refresh_token, `rt-${rtCounter}`);
});

test('refresh: extra scope is requested on refresh and shows up in scp (no re-login for newly consented scopes)', async () => {
  const c = await client();
  const a = await c.store.refreshAccount('t:owen@x.com', ['User.Read', 'Mail.Read', 'offline_access', 'ChannelMessage.Read.All']);
  assert.ok(c.tokenScopes(a.access_token!).includes('ChannelMessage.Read.All'));
  assert.deepEqual(a.scopes, ['User.Read', 'Mail.Read', 'offline_access', 'ChannelMessage.Read.All']);
});

test('GraphClient: 429 honours Retry-After then succeeds', async () => {
  const c = await client();
  const g = new c.GraphClient(c.store, 't:owen@x.com');
  const t0 = Date.now();
  const r = await g.get<{ value: string[] }>('/throttled');
  assert.deepEqual(r.body.value, ['ok']);
  assert.equal(hits['/v1.0/throttled'], 3);
  assert.ok(Date.now() - t0 >= 1900, `waited ${Date.now() - t0} ms for two Retry-After: 1 responses`);
});

test('GraphClient: 401 triggers exactly one forced refresh and a retry', async () => {
  const c = await client();
  // Plant a stale access token with a far-future expiry so the client trusts it until Graph says 401.
  const store = c.store.read();
  store.accounts['t:owen@x.com']!.access_token = 'stale';
  store.accounts['t:owen@x.com']!.expires_at = Date.now() + 3600_000;
  c.store.write(store);
  const before = refreshCalls;
  const g = new c.GraphClient(c.store, 't:owen@x.com');
  const r = await g.get<{ value: string[] }>('/expired');
  assert.deepEqual(r.body.value, ['fresh']);
  assert.equal(refreshCalls, before + 1);
  assert.equal(hits['/v1.0/expired'], 2);
});

test('GraphClient: pages() follows nextLink and returns the deltaLink; all() flattens', async () => {
  const c = await client();
  const g = new c.GraphClient(c.store, 't:owen@x.com');
  const seen: number[] = [];
  const it = g.pages<number>('/paged');
  let delta: string | undefined;
  for (;;) {
    const r = await it.next();
    if (r.done) {
      delta = r.value;
      break;
    }
    seen.push(...r.value.value);
  }
  assert.deepEqual(seen, [1, 2, 3]);
  assert.equal(delta, `${base}/v1.0/paged?token=abc`);
  assert.deepEqual(await g.all<number>('/paged'), [1, 2, 3]);
});

test('GraphClient: 403 surfaces as GraphError with the Graph error code (caller decides)', async () => {
  const c = await client();
  const g = new c.GraphClient(c.store, 't:owen@x.com');
  await assert.rejects(g.get('/forbidden'), (e: unknown) => e instanceof c.GraphError && e.status === 403 && e.code === 'Forbidden' && /ChannelMessage/.test(e.message));
});

test('TokenError: revoked refresh token is classified as needsReauth', async () => {
  const c = await client();
  failRefreshWith = { error: 'invalid_grant', codes: [70008] };
  try {
    await assert.rejects(c.store.refreshAccount('t:owen@x.com'), (e: unknown) => e instanceof c.TokenError && e.needsReauth && e.codes.includes(70008));
  } finally {
    failRefreshWith = undefined;
  }
});

test('retryAfterMs: seconds, HTTP-date, and exponential fallback', async () => {
  const c = await client();
  assert.equal(c.retryAfterMs('5', 0), 5000);
  assert.ok(Math.abs(c.retryAfterMs(new Date(Date.now() + 3000).toUTCString(), 0) - 3000) < 1200);
  assert.equal(c.retryAfterMs(null, 3), 8000);
  assert.equal(c.retryAfterMs(null, 10), 60_000);
});

test('pkcePair: S256 challenge of the verifier, base64url without padding', async () => {
  const c = await client();
  const { verifier, challenge } = c.pkcePair();
  assert.match(verifier, /^[A-Za-z0-9_-]{43}$/);
  assert.match(challenge, /^[A-Za-z0-9_-]{43}$/);
  const { createHash } = await import('node:crypto');
  assert.equal(challenge, c.base64url(createHash('sha256').update(verifier).digest()));
  assert.equal(c.scopeString(['User.Read', 'offline_access', 'Mail.Read']), 'https://graph.microsoft.com/User.Read offline_access https://graph.microsoft.com/Mail.Read');
});
