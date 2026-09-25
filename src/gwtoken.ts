// Auth0 M2M tokens for the MCP gateway (<gateway-host>/gw/<slug>/mcp).
//
// The bot reaches a project's gateway route as a machine identity: the Auth0 client
// `coach-aven-<slug>` (client credentials, audience = the route URL). The token proves
// "this is the <slug> bot" to the gateway, whose route policy decides what it may do.
//
// Why a cache, and why here in the orchestrator: Auth0 Free mints only 1000 M2M tokens a
// month for the whole tenant, a token lives 24 h, and the sandbox must never see the client
// secret. So the orchestrator holds the secret, mints at most one token per (project,
// audience) per day, and hands the sandbox only the short-lived token (a file its MCP
// `headersHelper` reads — see project.ts seedGatewayAuth). Refresh happens when less than
// REFRESH_BEFORE_MS is left, so a token written at the start of a turn stays valid for at
// least an hour of that turn; a longer-lived Claude process that hits 401 re-runs the helper,
// which reads the file the NEXT turn refreshed.

export const REFRESH_BEFORE_MS = 60 * 60 * 1000; // refresh when < 1 h of the 24 h is left

export interface MintedToken {
  accessToken: string;
  expiresAt: number; // epoch ms
}

export type MintFn = () => Promise<MintedToken>;

// One cached token behind a single-flight mint: concurrent callers share one in-flight
// request (a burst of turns on one project must not burn the monthly quota).
export function createTokenCache(mint: MintFn, now: () => number = Date.now) {
  let current: MintedToken | undefined;
  let inflight: Promise<MintedToken> | undefined;
  return {
    async get(): Promise<string> {
      if (current && current.expiresAt - now() > REFRESH_BEFORE_MS) return current.accessToken;
      if (!inflight) {
        inflight = mint()
          .then((t) => {
            current = t;
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

// Process-wide registry: one cache per (slug, audience). Credentials are read from the env at
// first use, so a missing pair fails loudly for that project only.
export function createGatewayTokens(
  env: Record<string, string | undefined> = process.env,
  fetchFn: typeof fetch = fetch,
  now: () => number = Date.now,
) {
  const caches = new Map<string, ReturnType<typeof createTokenCache>>();
  return {
    get(slug: string, audience: string): Promise<string> {
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

// The conversation id the sandbox's headersHelper sends as `x-aven-session` (the gateway
// logs it as `aven_session`, joining its audit to coach-aven's event log). Header-safe and
// shell-safe: the value is interpolated into the claude command line.
export function avenSessionValue(key: string): string {
  return key.replace(/[^A-Za-z0-9:._-]/g, '_').slice(0, 120);
}
