// OAuth client-credentials tokens for the MCP gateway (engine.example.com/gw/<slug>/mcp).
//
// The bot reaches a project's gateway route as a machine identity, a client at the
// installation's identity provider, with one token PER ROUTE: the token proves "this is the
// <slug> bot" to the gateway (its `aud` or its scope names the route), whose route policy decides
// what it may do. Two ways to ask for it, chosen per mcp entry:
//   - an `oauth` object (OpenSpec `gateway-oauth-client-credentials`) — THE path: the standard
//     RFC 6749 §4.4 request any OAuth server takes: a form body, HTTP Basic (or `post`) client
//     authentication, `scope` / `audience` / `resource` as configured. Cognito: a `scope` per
//     route, tokens without `aud` (fine, the bot never reads a token). Auth0: `audience` = the
//     route URL (Auth0 refuses `resource` on client credentials). Credentials: the project's
//     GATEWAY_OAUTH_<SLUG>_* pair, or else the installation's ONE pair GATEWAY_OAUTH_ID / _SECRET
//     (OpenSpec `gateway-installation-client`): a client per project buys no isolation — every
//     secret sits in this one process's env — the per-route token does. That is also why two
//     projects on the installation pair must not ask the same token request (sharedTokenRequests,
//     checked at config load).
//   - no `oauth` object: DEPRECATED (a warning at config load), Auth0's JSON request with
//     `audience` = the entry's URL, credentials AUTH0_M2M_* — byte for byte as it always was
//     (pinned by a test) until a later change removes it.
//
// Why a cache, and why here in the orchestrator: providers bill or cap mints (Auth0 Free: 1000
// M2M tokens a month for the whole tenant), and the sandbox must never see the client secret.
// So the orchestrator holds the secret, mints at most one token per (project, token request)
// per lifetime, and hands the sandbox only the short-lived token (a file its MCP
// `headersHelper` reads — see project.ts seedGatewayAuth). Refresh happens when less than
// min(REFRESH_BEFORE_MS, half the token's lifetime) is left: a 24 h token is replaced in its
// last hour, so a token written at the start of a turn stays valid for at least an hour of that
// turn; a 1 h token (Cognito's default) in its last 30 min instead of on every turn. A
// longer-lived Claude process that hits 401 re-runs the helper, which reads the file the NEXT
// turn refreshed.

export const REFRESH_BEFORE_MS = 60 * 60 * 1000; // refresh when < 1 h of the 24 h is left

export interface MintedToken {
  accessToken: string;
  expiresAt: number; // epoch ms
}

export type MintFn = () => Promise<MintedToken>;

// One cached token behind a single-flight mint: concurrent callers share one in-flight
// request (a burst of turns on one project must not burn the monthly quota). The refresh
// margin is relative to the lifetime the token had when it arrived (see the header).
export function createTokenCache(mint: MintFn, now: () => number = Date.now) {
  let current: (MintedToken & { margin: number }) | undefined;
  let inflight: Promise<MintedToken> | undefined;
  return {
    async get(): Promise<string> {
      if (current && current.expiresAt - now() > current.margin) return current.accessToken;
      if (!inflight) {
        inflight = mint()
          .then((t) => {
            current = { ...t, margin: Math.min(REFRESH_BEFORE_MS, (t.expiresAt - now()) / 2) };
            return t;
          })
          .finally(() => {
            inflight = undefined;
          });
      }
      return (await inflight).accessToken;
    },
  };
}

// Env names of a project's M2M client: AUTH0_M2M_<SLUG>_ID / _SECRET (slug upper-cased,
// dashes → underscores — the bluefin-infra Terraform output naming).
export function m2mEnvNames(slug: string): { id: string; secret: string } {
  const s = slug.toUpperCase().replace(/[^A-Z0-9]/g, '_');
  return { id: `AUTH0_M2M_${s}_ID`, secret: `AUTH0_M2M_${s}_SECRET` };
}

export interface M2mConfig {
  tokenUrl: string; // https://<tenant>/oauth/token
  clientId: string;
  clientSecret: string;
  audience: string; // the gateway route URL
}

// One client-credentials request. Errors carry the Auth0 error code only — never the body,
// which could echo the client id.
export function auth0Mint(c: M2mConfig, fetchFn: typeof fetch = fetch, now: () => number = Date.now): MintFn {
  return async () => {
    const res = await fetchFn(c.tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'client_credentials',
        client_id: c.clientId,
        client_secret: c.clientSecret,
        audience: c.audience,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    const body = (await res.json().catch(() => ({}))) as {
      access_token?: string;
      expires_in?: number;
      error?: string;
    };
    if (!res.ok || !body.access_token) {
      const code = typeof body.error === 'string' && /^[a-z_]{1,64}$/.test(body.error) ? body.error : 'no_token';
      throw new Error(`Auth0 M2M token request failed (${res.status} ${code}) for ${c.audience}`);
    }
    const ttl = typeof body.expires_in === 'number' && body.expires_in > 0 ? body.expires_in : 3600;
    return { accessToken: body.access_token, expiresAt: now() + ttl * 1000 };
  };
}

// ── The provider-neutral path: an `oauth` object on the gateway entry ─────────────────────

// The non-secret half of a project's gateway client, as projects.config.json carries it on a
// `gateway-m2m` mcp entry. The secret half never sits here: GATEWAY_OAUTH_<SLUG>_ID / _SECRET.
export interface GatewayOAuth {
  tokenUrl: string; // https only
  scope?: string; // RFC 6749 §3.3, space-delimited, sent as is (Cognito: <resource-server>/<scope>)
  audience?: string; // for servers that take Auth0's parameter
  resource?: string; // RFC 8707
  clientAuth?: 'basic' | 'post'; // RFC 6749 §2.3.1 HTTP Basic (default) or the body
}

// What a gateway entry asks the token registry for: the URL the sandbox connects to (the Auth0
// path's audience) and, when set, the provider-neutral request.
export interface GatewayTarget {
  url: string;
  oauth?: GatewayOAuth;
}

const OAUTH_FIELDS = new Set(['tokenUrl', 'scope', 'audience', 'resource', 'clientAuth']);

// Validate an `oauth` object from the project config (the caller prefixes the config path). A
// field that smells like a credential gets its own message: secrets belong in the env, and a
// config that carries one must not load at all.
export function validateGatewayOAuth(raw: unknown, label: string): GatewayOAuth {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`${label} must be an object`);
  const o = raw as Record<string, unknown>;
  for (const k of Object.keys(o)) {
    if (OAUTH_FIELDS.has(k)) continue;
    if (/secret|client_?id/i.test(k)) {
      throw new Error(`${label}.${k}: client credentials go in the env (GATEWAY_OAUTH_<SLUG>_ID / _SECRET), never in the config`);
    }
    throw new Error(`${label}.${k} is not a known field (tokenUrl, scope, audience, resource, clientAuth)`);
  }
  let url: URL | undefined;
  try {
    url = typeof o.tokenUrl === 'string' ? new URL(o.tokenUrl) : undefined;
  } catch {
    url = undefined;
  }
  if (!url || url.protocol !== 'https:') throw new Error(`${label}.tokenUrl must be an https URL`);
  for (const k of ['scope', 'audience', 'resource'] as const) {
    if (o[k] !== undefined && (typeof o[k] !== 'string' || !(o[k] as string).trim())) {
      throw new Error(`${label}.${k} must be a non-empty string`);
    }
  }
  if (o.clientAuth !== undefined && o.clientAuth !== 'basic' && o.clientAuth !== 'post') {
    throw new Error(`${label}.clientAuth must be "basic" or "post"`);
  }
  return o as unknown as GatewayOAuth;
}

// Env names of a project's provider-neutral client: GATEWAY_OAUTH_<SLUG>_ID / _SECRET (the
// m2mEnvNames mapping) — never under an AUTH0_ name, which would mislead whoever rotates it.
export function oauthEnvNames(slug: string): { id: string; secret: string } {
  const s = slug.toUpperCase().replace(/[^A-Z0-9]/g, '_');
  return { id: `GATEWAY_OAUTH_${s}_ID`, secret: `GATEWAY_OAUTH_${s}_SECRET` };
}

// The installation pair: one client for every `oauth` entry whose project has no pair of its own.
// It can never be a project's name — those are GATEWAY_OAUTH_<S>_ID with a non-empty <S> (a
// GATEWAY_OAUTH_CLIENT_ID would be project `client`'s).
export const INSTALLATION_OAUTH_ENV = { id: 'GATEWAY_OAUTH_ID', secret: 'GATEWAY_OAUTH_SECRET' } as const;

export type OAuthCredentials =
  | { clientId: string; clientSecret: string; source: 'project' | 'installation' }
  | { error: string };

// Which pair an `oauth` entry of `slug` authenticates with: the project's own when both halves are
// set, the installation's when neither is. A half-set project pair is an error, never a fallback —
// a half-rotated secret must not quietly turn into another client. Messages name env vars only.
export function resolveOAuthCredentials(env: Record<string, string | undefined>, slug: string): OAuthCredentials {
  const own = oauthEnvNames(slug);
  const inst = INSTALLATION_OAUTH_ENV;
  const id = env[own.id];
  const secret = env[own.secret];
  if (id && secret) return { clientId: id, clientSecret: secret, source: 'project' };
  if (id || secret) {
    return { error: `gateway auth for ${slug}: ${own.id} and ${own.secret} must both be set, only one is (a half pair never falls back to ${inst.id})` };
  }
  const instId = env[inst.id];
  const instSecret = env[inst.secret];
  if (instId && instSecret) return { clientId: instId, clientSecret: instSecret, source: 'installation' };
  return { error: `gateway auth for ${slug} needs ${own.id} and ${own.secret}, or the installation pair ${inst.id} and ${inst.secret}, in the env` };
}

export interface OAuthMintConfig extends GatewayOAuth {
  slug: string; // for the error message only
  clientId: string;
  clientSecret: string;
}

// application/x-www-form-urlencoded of one value — what RFC 6749 §2.3.1 applies to the id and
// secret before they become the Basic user and password.
const formEncode = (v: string) => new URLSearchParams([['', v]]).toString().slice(1);

// One RFC 6749 §4.4 client-credentials request. `scope` / `audience` / `resource` only when
// configured; the secret in the Authorization header (basic) or the body (post), never both. A
// token that is not a bearer token is refused rather than handed to the sandbox as one. Errors
// carry the status and the §5.2 `error` code — never `error_description` or the body, which can
// echo the client id — plus the project and the token URL's origin.
export function oauthMint(c: OAuthMintConfig, fetchFn: typeof fetch = fetch, now: () => number = Date.now): MintFn {
  return async () => {
    const form = new URLSearchParams({ grant_type: 'client_credentials' });
    if (c.scope) form.set('scope', c.scope);
    if (c.audience) form.set('audience', c.audience);
    if (c.resource) form.set('resource', c.resource);
    const headers: Record<string, string> = {
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
    };
    if (c.clientAuth === 'post') {
      form.set('client_id', c.clientId);
      form.set('client_secret', c.clientSecret);
    } else {
      const basic = Buffer.from(`${formEncode(c.clientId)}:${formEncode(c.clientSecret)}`).toString('base64');
      headers.authorization = `Basic ${basic}`;
    }
    const res = await fetchFn(c.tokenUrl, {
      method: 'POST',
      headers,
      body: form.toString(),
      signal: AbortSignal.timeout(15_000),
    });
    const body = (await res.json().catch(() => ({}))) as {
      access_token?: string;
      token_type?: string;
      expires_in?: number;
      error?: string;
    };
    const where = `for ${c.slug} at ${new URL(c.tokenUrl).origin}`;
    if (!res.ok || !body.access_token) {
      const code = typeof body.error === 'string' && /^[a-z_]{1,64}$/.test(body.error) ? body.error : 'no_token';
      throw new Error(`OAuth token request failed (${res.status} ${code}) ${where}`);
    }
    if (body.token_type !== undefined && String(body.token_type).toLowerCase() !== 'bearer') {
      throw new Error(`OAuth token ${where} is not a bearer token — not handed to the sandbox`);
    }
    const ttl = typeof body.expires_in === 'number' && body.expires_in > 0 ? body.expires_in : 3600;
    return { accessToken: body.access_token, expiresAt: now() + ttl * 1000 };
  };
}

// The canonical token request of an `oauth` entry — what the identity provider is asked for,
// whoever asks. The entry's URL is not part of it: the token is not bound to where the sandbox
// connects (which may be an internal address).
function oauthRequest(o: GatewayOAuth): string {
  return JSON.stringify([o.tokenUrl, o.scope ?? null, o.audience ?? null, o.resource ?? null, o.clientAuth ?? 'basic']);
}

// The cache key of an `oauth` entry: the project plus the whole token request, so two entries
// asking for different tokens never share one.
function oauthKey(slug: string, o: GatewayOAuth): string {
  return `${slug}|oauth|${oauthRequest(o)}`;
}

// Process-wide registry: one cache per (slug, token request). An entry without `oauth` keeps
// today's key `${slug}|${url}` and today's env names; credentials are read from the env at
// first use, so a missing pair fails loudly for that project only. The installation pair is
// read for `oauth` entries only.
export function createGatewayTokens(
  env: Record<string, string | undefined> = process.env,
  fetchFn: typeof fetch = fetch,
  now: () => number = Date.now,
) {
  const caches = new Map<string, ReturnType<typeof createTokenCache>>();
  return {
    get(slug: string, target: GatewayTarget): Promise<string> {
      const o = target.oauth;
      if (o) {
        const key = oauthKey(slug, o);
        let cache = caches.get(key);
        if (!cache) {
          const cred = resolveOAuthCredentials(env, slug);
          if ('error' in cred) return Promise.reject(new Error(cred.error));
          const { clientId, clientSecret } = cred;
          cache = createTokenCache(oauthMint({ ...o, slug, clientId, clientSecret }, fetchFn, now), now);
          caches.set(key, cache);
        }
        return cache.get();
      }
      const audience = target.url;
      const key = `${slug}|${audience}`;
      let cache = caches.get(key);
      if (!cache) {
        const names = m2mEnvNames(slug);
        const clientId = env[names.id];
        const clientSecret = env[names.secret];
        const tokenUrl = env.AUTH0_M2M_TOKEN_URL;
        if (!clientId || !clientSecret || !tokenUrl) {
          return Promise.reject(
            new Error(`gateway auth for ${slug} needs ${names.id}, ${names.secret} and AUTH0_M2M_TOKEN_URL in the env`),
          );
        }
        cache = createTokenCache(auth0Mint({ tokenUrl, clientId, clientSecret, audience }, fetchFn, now), now);
        caches.set(key, cache);
      }
      return cache.get();
    },
  };
}

export const gatewayTokens = createGatewayTokens();

// ── Checks at config load (projects.ts loadProjects) ────────────────────────────────────────

// What these checks read of a project (projects.ts imports this module, so not its types).
export interface GatewayProjectView {
  slug: string;
  mcp?: { name: string; auth?: string; oauth?: GatewayOAuth }[];
}

export interface SharedTokenRequest {
  slugs: string[]; // two or more projects
  request: GatewayOAuth;
}

// Projects on the installation pair that ask for the same token (OpenSpec
// gateway-installation-client D3): one client asking the same thing gets interchangeable tokens,
// so a token minted for one project would be valid on the other's route. Compared on what decides
// the token — token URL, scope, audience, resource — not on how the client authenticates. Nothing
// without the installation pair: every project then has a client of its own, which the gateway
// tells apart. Two entries of ONE project asking the same token are fine (one token, one cache).
export function sharedTokenRequests(projects: GatewayProjectView[], env: Record<string, string | undefined>): SharedTokenRequest[] {
  if (!env[INSTALLATION_OAUTH_ENV.id] || !env[INSTALLATION_OAUTH_ENV.secret]) return [];
  const byToken = new Map<string, SharedTokenRequest>();
  for (const p of projects) {
    const cred = resolveOAuthCredentials(env, p.slug);
    if ('error' in cred || cred.source !== 'installation') continue;
    for (const s of p.mcp ?? []) {
      if (s.auth !== 'gateway-m2m' || !s.oauth) continue;
      const o = s.oauth;
      const key = JSON.stringify([o.tokenUrl, o.scope ?? null, o.audience ?? null, o.resource ?? null]);
      const group = byToken.get(key) ?? { slugs: [], request: o };
      if (!group.slugs.includes(p.slug)) group.slugs.push(p.slug);
      byToken.set(key, group);
    }
  }
  return [...byToken.values()].filter((g) => g.slugs.length > 1);
}

// A token request in a message: the token URL's origin and the fields that are set. No credential
// is part of a request, so nothing here is secret.
export function describeTokenRequest(o: GatewayOAuth): string {
  const parts = [new URL(o.tokenUrl).origin];
  for (const k of ['scope', 'audience', 'resource'] as const) if (o[k]) parts.push(`${k} ${o[k]}`);
  return parts.join(', ');
}

// Projects still on the deprecated path: a gateway entry without `oauth`.
export function legacyGatewayProjects(projects: GatewayProjectView[]): string[] {
  return projects.filter((p) => (p.mcp ?? []).some((s) => s.auth === 'gateway-m2m' && !s.oauth)).map((p) => p.slug);
}

// The conversation id the sandbox's headersHelper sends as `x-aven-session` (the gateway
// logs it as `aven_session`, joining its audit to coach-aven's event log). Header-safe and
// shell-safe: the value is interpolated into the claude command line.
export function avenSessionValue(key: string): string {
  return key.replace(/[^A-Za-z0-9:._-]/g, '_').slice(0, 120);
}
