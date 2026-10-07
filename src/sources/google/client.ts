/**
 * Shared plumbing for the Google connector: the token store on disk, short-lived access-token
 * minting for both auth paths, and a fetch wrapper that knows Google's failure modes.
 *
 * Two headless-safe credentials, chosen per account (see README):
 *   oauth — a refresh token from the one-time installed-app flow (`auth.ts login`). Exchanged at
 *           POST https://oauth2.googleapis.com/token grant_type=refresh_token for a ~1h access token.
 *           https://developers.google.com/identity/protocols/oauth2/native-app#offline
 *   dwd   — a service account with domain-wide delegation. No refresh token at all: we sign a JWT
 *           {iss: SA email, sub: the user, scope, aud: token endpoint} and exchange it with
 *           grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer.
 *           https://developers.google.com/identity/protocols/oauth2/service-account#authorizingrequests
 *
 * Neither path ever needs a browser after bootstrap, and Google does not rotate refresh tokens,
 * so storing one static credential per account is enough. The only thing that kills an `oauth`
 * credential silently is listed at https://developers.google.com/identity/protocols/oauth2#expiration
 * (6 months unused, password change with Gmail scopes, >100 tokens per client, Testing-mode
 * 7-day expiry, admin restriction) — all of which surface as `invalid_grant` here and are raised
 * as `ReauthRequired` so the caller can alert instead of retrying forever.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createSign } from 'node:crypto';

export const SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/drive.readonly',
  'https://www.googleapis.com/auth/calendar.readonly',
] as const;

export const TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const TOKENINFO_URL = 'https://oauth2.googleapis.com/tokeninfo';

// ---------------------------------------------------------------------------------------
// Store: ~/.config/coach-aven/sources/<slug>/google.json (tokens.ts), mode 600.
// One file per project, N accounts, M OAuth clients. The path is always passed in — nothing
// here guesses a home directory, so the same code serves any project and any test.
// ---------------------------------------------------------------------------------------

export interface OAuthClient {
  client_id: string;
  client_secret: string;
  /** Internal = project under that Workspace's Cloud org (verification-exempt); external = published, unverified, personal use. */
  audience: 'internal' | 'external';
  added_at: string;
}
export interface OAuthAccount {
  kind: 'oauth';
  /** Key into `Store.clients`. */
  client: string;
  refresh_token: string;
  /** Scopes actually granted (the consent screen has per-scope checkboxes; we refuse partial grants). */
  scopes: string[];
  granted_at: string;
}
export interface DwdAccount {
  kind: 'dwd';
  client_email: string;
  private_key: string;
  private_key_id?: string;
  scopes: string[];
  granted_at: string;
}
export type Account = OAuthAccount | DwdAccount;
export interface Store {
  version: 1;
  clients: Record<string, OAuthClient>;
  accounts: Record<string, Account>;
}

export function loadStore(path: string): Store {
  if (!existsSync(path)) return { version: 1, clients: {}, accounts: {} };
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<Store>;
  return { version: 1, clients: parsed.clients ?? {}, accounts: parsed.accounts ?? {} };
}

/** Atomic write (tmp + rename) so a crash mid-write never leaves a half-file; 0600 because it holds secrets. */
export function saveStore(store: Store, path: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(store, null, 2) + '\n', { mode: 0o600 });
  renameSync(tmp, path);
  chmodSync(path, 0o600);
}

// ---------------------------------------------------------------------------------------
// Access tokens
// ---------------------------------------------------------------------------------------

/** The stored credential is dead; only a human can fix it (re-run `orch sources auth … google login`). Never retried. */
export class ReauthRequired extends Error {
  constructor(public readonly account: string, detail: string) {
    super(`${account}: re-authentication required — ${detail}`);
    this.name = 'ReauthRequired';
  }
}

export class HttpError extends Error {
  constructor(public readonly status: number, public readonly url: string, public readonly body: string) {
    super(`HTTP ${status} ${url.split('?')[0]}: ${body.slice(0, 300)}`);
    this.name = 'HttpError';
  }
  /** Google error envelopes carry a machine `reason` in `error.errors[].reason` (legacy) or `error.details[].reason` / `error.status` (new). */
  get reason(): string {
    try {
      const j = JSON.parse(this.body) as { error?: { errors?: { reason?: string }[]; status?: string; details?: { reason?: string }[] } };
      return j.error?.errors?.[0]?.reason ?? j.error?.details?.[0]?.reason ?? j.error?.status ?? '';
    } catch {
      return '';
    }
  }
}

interface TokenResponse { access_token: string; expires_in: number; scope?: string; token_type?: string }

export async function tokenPost(params: Record<string, string>, account: string): Promise<TokenResponse> {
  const res = await fetchWithRetry(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
  });
  const text = await res.text();
  if (res.ok) return JSON.parse(text) as TokenResponse;
  let err = '';
  let desc = '';
  try {
    const j = JSON.parse(text) as { error?: string; error_description?: string };
    err = j.error ?? '';
    desc = j.error_description ?? '';
  } catch { /* non-JSON body, fall through */ }
  // invalid_grant: refresh token revoked/expired, or (DWD) the Admin-console grant is missing /
  // scopes differ. unauthorized_client: DWD client id not authorised for these scopes.
  // Both need a human; everything else (5xx, network) was already retried by fetchWithRetry.
  if (err === 'invalid_grant' || err === 'unauthorized_client' || err === 'invalid_client') {
    throw new ReauthRequired(account, `${err}: ${desc || text.slice(0, 200)}`);
  }
  throw new HttpError(res.status, TOKEN_URL, text);
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

/** RS256 JWT for the service-account flow, signed with Node's crypto only. */
export function signServiceAccountJwt(acct: DwdAccount, subject: string, scopes: readonly string[], now = Date.now()): string {
  const iat = Math.floor(now / 1000);
  const header = { alg: 'RS256', typ: 'JWT', ...(acct.private_key_id ? { kid: acct.private_key_id } : {}) };
  const claims = { iss: acct.client_email, sub: subject, scope: scopes.join(' '), aud: TOKEN_URL, iat, exp: iat + 3600 };
  const unsigned = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
  const sig = createSign('RSA-SHA256').update(unsigned).sign(acct.private_key);
  return `${unsigned}.${b64url(sig)}`;
}

/**
 * Per-account access-token cache. Tokens live ~1h; we refresh 60s early and single-flight
 * concurrent callers so a burst of parallel `messages.get` does not mint ten tokens at once
 * (there is no published limit on the token endpoint, but there is no reason to find it).
 */
export class Tokens {
  private cache = new Map<string, { token: string; exp: number }>();
  private inflight = new Map<string, Promise<string>>();
  constructor(private readonly store: Store) {}

  async access(account: string, force = false): Promise<string> {
    const hit = this.cache.get(account);
    if (!force && hit && hit.exp > Date.now()) return hit.token;
    const pending = this.inflight.get(account);
    if (pending && !force) return pending;
    const p = this.mint(account).finally(() => this.inflight.delete(account));
    this.inflight.set(account, p);
    return p;
  }

  private async mint(account: string): Promise<string> {
    const acct = this.store.accounts[account];
    if (!acct) throw new Error(`no credentials stored for ${account} (run: orch sources auth <slug> google login)`);
    const res = await mintToken(acct, account, this.store);
    this.cache.set(account, { token: res.access_token, exp: Date.now() + (res.expires_in - 60) * 1000 });
    return res.access_token;
  }
}

export async function mintToken(acct: Account, account: string, store: Store): Promise<TokenResponse> {
  if (acct.kind === 'dwd') {
    return tokenPost({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: signServiceAccountJwt(acct, account, acct.scopes) }, account);
  }
  const client = store.clients[acct.client];
  if (!client) throw new Error(`${account}: references OAuth client '${acct.client}' which is not in the store`);
  return tokenPost({ grant_type: 'refresh_token', client_id: client.client_id, client_secret: client.client_secret, refresh_token: acct.refresh_token }, account);
}

// ---------------------------------------------------------------------------------------
// Fetch with Google-aware retry
// ---------------------------------------------------------------------------------------

const MAX_ATTEMPTS = 8;
const MAX_BACKOFF_MS = 64_000;

/** Retry-After may be seconds or an HTTP-date; Google mostly omits it on 429 and expects exponential backoff. */
function retryAfterMs(res: Response): number | undefined {
  const h = res.headers.get('retry-after');
  if (!h) return undefined;
  const secs = Number(h);
  if (Number.isFinite(secs)) return secs * 1000;
  const at = Date.parse(h);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : undefined;
}

/** Google's documented formula: min((2^n) + random_ms, cap). https://developers.google.com/workspace/gmail/api/guides/handle-errors */
function backoffMs(attempt: number): number {
  return Math.min(2 ** attempt * 1000 + Math.floor(Math.random() * 1000), MAX_BACKOFF_MS);
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Retries 429, 5xx and dropped connections. 403 is retried only when the body says it is a rate
 * limit (`userRateLimitExceeded`, `rateLimitExceeded`, `quotaExceeded`, `RESOURCE_EXHAUSTED`) —
 * a 403 for a missing scope must fail fast. 401 is NOT handled here; `gfetch` owns token refresh.
 */
export async function fetchWithRetry(url: string, init: RequestInit): Promise<Response> {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, init);
    } catch (e) {
      // undici surfaces TLS resets / DNS hiccups as TypeError('fetch failed'); treat like a 503.
      if (attempt === MAX_ATTEMPTS - 1) throw e;
      await sleep(backoffMs(attempt));
      continue;
    }
    if (res.status !== 429 && res.status < 500 && res.status !== 403) return res;
    if (res.status === 403) {
      const body = await res.clone().text();
      if (!/ateLimitExceeded|quotaExceeded|RESOURCE_EXHAUSTED/.test(body)) return res;
    }
    // Out of attempts: hand the caller the response UNREAD so it can still `.text()` the error.
    // (Cancelling the body here and returning it later was the "Body is unusable" failure on the
    // first real Gmail backfill — a burst of 429s on messages.get exhausted the attempts.)
    if (attempt === MAX_ATTEMPTS - 1) return res;
    await res.body?.cancel().catch(() => undefined);
    await sleep(retryAfterMs(res) ?? backoffMs(attempt));
  }
  throw new Error('unreachable');
}

/** Authenticated GET/POST as `account`. On 401 the cached token is dropped and the call retried once with a fresh one. */
export async function gfetch(tokens: Tokens, account: string, url: string, init: RequestInit = {}): Promise<Response> {
  for (let pass = 0; pass < 2; pass++) {
    const token = await tokens.access(account, pass > 0);
    const res = await fetchWithRetry(url, { ...init, headers: { ...(init.headers as Record<string, string> | undefined), authorization: `Bearer ${token}` } });
    if (res.status !== 401 || pass > 0) return res;
    await res.body?.cancel().catch(() => undefined);
  }
  throw new Error('unreachable');
}

/** JSON helper: throws HttpError on non-2xx so callers can switch on `status` (404 history gone, 410 sync token gone). */
export async function gjson<T>(tokens: Tokens, account: string, url: string, init: RequestInit = {}): Promise<T> {
  const res = await gfetch(tokens, account, url, init);
  const text = await res.text();
  if (!res.ok) throw new HttpError(res.status, url, text);
  return (text ? JSON.parse(text) : {}) as T;
}

/** Build a URL with query params; repeated keys (Gmail `historyTypes`) pass as arrays. */
export function withQuery(base: string, params: Record<string, string | number | boolean | string[] | undefined>): string {
  const u = new URL(base);
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined) continue;
    if (Array.isArray(v)) for (const x of v) u.searchParams.append(k, x);
    else u.searchParams.set(k, String(v));
  }
  return u.toString();
}

/** Who is this token for? `users.me.profile` costs 1 unit and works with gmail.readonly — no extra `email` scope needed. */
export async function whoAmI(accessToken: string): Promise<{ email: string; historyId: string }> {
  const res = await fetchWithRetry('https://gmail.googleapis.com/gmail/v1/users/me/profile', { headers: { authorization: `Bearer ${accessToken}` } });
  const text = await res.text();
  if (!res.ok) throw new HttpError(res.status, 'users/me/profile', text);
  const j = JSON.parse(text) as { emailAddress: string; historyId: string };
  return { email: j.emailAddress.toLowerCase(), historyId: j.historyId };
}

/** Granted scopes + remaining lifetime of an access token (unauthenticated endpoint). */
export async function tokenInfo(accessToken: string): Promise<{ scope: string; expires_in: number }> {
  const res = await fetchWithRetry(`${TOKENINFO_URL}?access_token=${encodeURIComponent(accessToken)}`, {});
  const text = await res.text();
  if (!res.ok) throw new HttpError(res.status, TOKENINFO_URL, text);
  const j = JSON.parse(text) as { scope?: string; expires_in?: string | number };
  return { scope: j.scope ?? '', expires_in: Number(j.expires_in ?? 0) };
}

export function missingScopes(granted: string): string[] {
  const have = new Set(granted.split(/\s+/));
  return SCOPES.filter((s) => !have.has(s));
}
