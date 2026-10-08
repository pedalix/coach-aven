/**
 * Token store + token refresh + a throttling-aware Graph fetch. Shared by `auth.ts`
 * (bootstrap / check) and `pull.ts` (steady state). Built-ins and global fetch only.
 *
 * Why no MSAL: the two flows we need (auth-code+PKCE once, refresh_token forever) are ~60
 * lines against the documented v2 endpoints, and a dependency-free token path is easier to
 * audit for a file that IS mailbox access:
 *   https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow
 *   https://learn.microsoft.com/en-us/entra/identity-platform/refresh-tokens
 *
 * Refresh-token rules that shape this file (public client, no secret):
 *  - Entra ROTATES the refresh token on every use. The old one is not revoked, but a chain
 *    that forks (two processes refreshing from the same stored token) is exactly the
 *    situation the docs warn about, so every refresh runs under an exclusive lock and the
 *    NEW token is persisted before the access token is handed out.
 *  - Lifetime: 90-day sliding inactivity window, max age "until revoked". A poller that
 *    runs at least every few days never lets it lapse on its own.
 *  - Revocation (password change/reset, SSPR, admin revoke, user disabled) and forced
 *    re-auth (Conditional Access sign-in frequency / device / location policies) show up as
 *    `invalid_grant` / `interaction_required` with the AADSTS codes in NEEDS_REAUTH. The
 *    only fix is a human redoing `orch sources auth … msgraph login`, so we surface it loudly.
 */
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, openSync, closeSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** Base URLs are env-overridable ONLY so client.test.ts can point them at a local mock. */
export const LOGIN_BASE = process.env.MSGRAPH_LOGIN_BASE ?? 'https://login.microsoftonline.com';
export const GRAPH = `${process.env.MSGRAPH_API_BASE ?? 'https://graph.microsoft.com'}/v1.0`;
/** SharePoint/OneDrive de-prioritise "undecorated" traffic; this is the documented convention. */
export const USER_AGENT = 'NONISV|Pedalix|coach-aven-sources/1.0';

export const DEFAULT_SCOPES = [
  'User.Read',
  'offline_access',
  'openid',
  'profile',
  'Mail.Read',
  'Calendars.Read',
  'Chat.Read',
  'Team.ReadBasic.All',
  'Channel.ReadBasic.All',
  'Files.Read.All',
  'Sites.Read.All',
];
/** Admin-consent-required even as a delegated scope; requested separately once Tobin has granted it. */
export const CHANNEL_SCOPE = 'ChannelMessage.Read.All';

// ---------------------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------------------

export interface StoredAccount {
  /** `<tenant_id>:<upn>` — one entry per (tenant, user) pair; N tenants/users coexist. */
  key: string;
  tenant_id: string;
  client_id: string;
  upn: string;
  user_id: string;
  display_name?: string;
  /** Short scope names (`Mail.Read`); Graph resource prefix is added when talking to Entra. */
  scopes: string[];
  refresh_token: string;
  access_token?: string;
  /** Epoch millis. Access tokens live 60–90 min; we refresh 2 min early. */
  expires_at?: number;
  obtained_via: 'pkce' | 'device_code';
  obtained_at: string;
  last_refresh_at?: string;
  refresh_count?: number;
}

export interface TokenStore {
  version: 1;
  accounts: Record<string, StoredAccount>;
}

/**
 * The token store for ONE project: ~/.config/coach-aven/sources/<slug>/msgraph.json (tokens.ts).
 * Instance-based (not module globals) so the bot can hold several projects' stores at once and
 * tests can point at a temp file without touching the environment.
 */
export class MsTokenStore {
  constructor(public readonly path: string) {}

  read(): TokenStore {
    if (!existsSync(this.path)) return { version: 1, accounts: {} };
    const parsed = JSON.parse(readFileSync(this.path, 'utf8')) as TokenStore;
    if (parsed.version !== 1 || typeof parsed.accounts !== 'object') throw new Error(`${this.path}: unknown store format`);
    return parsed;
  }

  /** Atomic (tmp + rename) and private (0600 file, 0700 dir) — the file IS the user's mailbox access. */
  write(store: TokenStore): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const tmp = `${this.path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(store, null, 2) + '\n', { mode: 0o600 });
    renameSync(tmp, this.path);
  }

  /**
   * Exclusive lock via O_EXCL lock file. Node has no flock; `wx` create is atomic on every
   * filesystem we care about. A lock older than 60 s belongs to a crashed process.
   */
  async withLock<T>(fn: () => Promise<T>): Promise<T> {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const lock = `${this.path}.lock`;
    const deadline = Date.now() + 30_000;
    for (;;) {
      try {
        closeSync(openSync(lock, 'wx', 0o600));
        break;
      } catch (e) {
        const err = e as NodeJS.ErrnoException;
        if (err.code !== 'EEXIST') throw e;
        try {
          if (Date.now() - statSync(lock).mtimeMs > 60_000) {
            unlinkSync(lock);
            continue;
          }
        } catch {
          /* vanished between stat and unlink */
        }
        if (Date.now() > deadline) throw new Error(`${lock}: still held after 30 s — another refresher running?`);
        await sleep(200);
      }
    }
    try {
      return await fn();
    } finally {
      try {
        unlinkSync(lock);
      } catch {
        /* already gone */
      }
    }
  }

  getAccount(key: string): StoredAccount {
    const store = this.read();
    const acct = store.accounts[key] ?? Object.values(store.accounts).find((a) => a.upn.toLowerCase() === key.toLowerCase());
    if (!acct) throw new Error(`No account '${key}' in ${this.path}; run: orch sources auth <slug> msgraph login (known: ${Object.keys(store.accounts).join(', ') || 'none'})`);
    return acct;
  }

  /**
   * Refresh under the store lock, re-reading the store first (another process may have
   * rotated the token since we read it), and persist the rotated refresh token BEFORE the
   * caller gets the access token. `scopes` defaults to the stored list — passing a superset
   * is how a newly admin-consented scope (ChannelMessage.Read.All) is picked up without a
   * new bootstrap: refresh tokens cover every permission the client has been consented.
   */
  refreshAccount(key: string, scopes?: string[]): Promise<StoredAccount> {
    return this.withLock(async () => {
      const store = this.read();
      const acct = store.accounts[key];
      if (!acct) throw new Error(`No account '${key}' in ${this.path}`);
      const wanted = scopes ?? acct.scopes;
      const tok = await tokenRequest(acct.tenant_id, {
        client_id: acct.client_id,
        grant_type: 'refresh_token',
        refresh_token: acct.refresh_token,
        scope: scopeString(wanted),
      });
      acct.refresh_token = tok.refresh_token ?? acct.refresh_token;
      acct.access_token = tok.access_token;
      acct.expires_at = Date.now() + tok.expires_in * 1000;
      acct.scopes = wanted;
      acct.last_refresh_at = new Date().toISOString();
      acct.refresh_count = (acct.refresh_count ?? 0) + 1;
      this.write(store);
      return acct;
    });
  }

  /** Cached access token if it has >2 min left, else a refreshed one. */
  async getAccessToken(key: string, force = false): Promise<string> {
    const acct = this.getAccount(key);
    if (!force && acct.access_token && acct.expires_at && acct.expires_at - Date.now() > 120_000) return acct.access_token;
    return (await this.refreshAccount(acct.key)).access_token!;
  }
}

export function accountKey(tenantId: string, upn: string): string {
  return `${tenantId}:${upn.toLowerCase()}`;
}

// ---------------------------------------------------------------------------------------
// Entra token endpoint
// ---------------------------------------------------------------------------------------

export function authority(tenantId: string): string {
  return `${LOGIN_BASE}/${tenantId}/oauth2/v2.0`;
}

/** `Mail.Read` → `https://graph.microsoft.com/Mail.Read`; OIDC scopes stay bare. */
export function scopeString(scopes: string[]): string {
  const oidc = new Set(['openid', 'profile', 'offline_access', 'email']);
  return scopes.map((s) => (oidc.has(s) || s.includes('://') ? s : `https://graph.microsoft.com/${s}`)).join(' ');
}

export interface TokenResponse {
  token_type: string;
  scope: string;
  expires_in: number;
  access_token: string;
  refresh_token?: string;
  id_token?: string;
}

/** AADSTS codes that mean "a human must sign in again"; see the plan's revocation table. */
const NEEDS_REAUTH = new Set([70008, 700082, 700084, 50173, 50076, 50074, 50078, 53003, 530036, 65001, 90094, 50089, 50133, 50057, 500011]);

export class TokenError extends Error {
  constructor(
    public readonly error: string,
    public readonly description: string,
    public readonly codes: number[],
    public readonly status: number,
  ) {
    super(`${error}: ${description.split('\n')[0]}`);
  }
  /** True when retrying will never help: the refresh token is dead or consent is missing. */
  get needsReauth(): boolean {
    return this.error === 'invalid_grant' || this.error === 'interaction_required' || this.codes.some((c) => NEEDS_REAUTH.has(c));
  }
}

export async function tokenRequest(tenantId: string, params: Record<string, string>): Promise<TokenResponse> {
  const res = await fetch(`${authority(tenantId)}/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': USER_AGENT },
    body: new URLSearchParams(params).toString(),
  });
  const body = (await res.json().catch(() => ({}))) as Partial<TokenResponse> & { error?: string; error_description?: string; error_codes?: number[] };
  if (!res.ok || !body.access_token) {
    throw new TokenError(body.error ?? `http_${res.status}`, body.error_description ?? res.statusText, body.error_codes ?? [], res.status);
  }
  return body as TokenResponse;
}

/** `scp` claim of a Graph access token — lets pull.ts skip channels when the scope is absent instead of burning 403s. */
export function tokenScopes(accessToken: string): string[] {
  try {
    const payload = accessToken.split('.')[1] ?? '';
    const json = JSON.parse(Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')) as { scp?: string };
    return (json.scp ?? '').split(' ').filter(Boolean);
  } catch {
    return [];
  }
}

// PKCE helpers (RFC 7636, S256) — used by auth.ts, kept here so they are unit-testable.
export function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = base64url(randomBytes(32));
  return { verifier, challenge: base64url(createHash('sha256').update(verifier).digest()) };
}

// ---------------------------------------------------------------------------------------
// Graph fetch with throttling + auth handling
// ---------------------------------------------------------------------------------------

export class GraphError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly url: string,
  ) {
    super(`Graph ${status} ${code}: ${message} (${url.replace(/\?.*$/, '')})`);
  }
}

export interface GraphPage<T> {
  value: T[];
  '@odata.nextLink'?: string;
  '@odata.deltaLink'?: string;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** `Retry-After` is seconds or an HTTP date; fall back to exponential backoff capped at 60 s. */
export function retryAfterMs(h: string | null, attempt: number): number {
  if (h) {
    const secs = Number(h);
    if (Number.isFinite(secs)) return Math.max(1000, secs * 1000);
    const at = Date.parse(h);
    if (Number.isFinite(at)) return Math.max(1000, at - Date.now());
  }
  return Math.min(60_000, 1000 * 2 ** attempt);
}

export interface GraphClientOptions {
  /** Minimum gap between requests, globally. Teams limits are per-chat 1 rps; see pull.ts pacing. */
  minIntervalMs?: number;
  log?: (msg: string) => void;
}

export class GraphClient {
  private lastAt = 0;
  private token: string | undefined;
  constructor(
    private readonly store: MsTokenStore,
    public readonly accountKey: string,
    private readonly opts: GraphClientOptions = {},
  ) {}

  private async bearer(force = false): Promise<string> {
    if (force || !this.token) this.token = await this.store.getAccessToken(this.accountKey, force);
    return this.token;
  }

  async scopes(): Promise<string[]> {
    return tokenScopes(await this.bearer());
  }

  /**
   * GET with: pacing, 429/503/504 Retry-After (honoured — early retries count against the
   * quota and SharePoint blocks repeat offenders), one forced refresh on 401, transient
   * network errors retried. 4xx other than 401/429 are thrown as GraphError for the caller
   * to decide (403 on channels = scope missing, 410 on delta = resync, 404 = gone).
   */
  async get<T = unknown>(urlOrPath: string, headers: Record<string, string> = {}): Promise<{ body: T; headers: Headers }> {
    const url = urlOrPath.startsWith('http') ? urlOrPath : `${GRAPH}${urlOrPath.startsWith('/') ? '' : '/'}${urlOrPath}`;
    let refreshed = false;
    for (let attempt = 0; ; attempt++) {
      const gap = (this.opts.minIntervalMs ?? 0) - (Date.now() - this.lastAt);
      if (gap > 0) await sleep(gap);
      this.lastAt = Date.now();
      let res: Response;
      try {
        res = await fetch(url, { headers: { authorization: `Bearer ${await this.bearer()}`, accept: 'application/json', 'user-agent': USER_AGENT, ...headers } });
      } catch (e) {
        if (attempt >= 5) throw e;
        this.opts.log?.(`network error (${(e as Error).message}); retry ${attempt + 1}`);
        await sleep(retryAfterMs(null, attempt));
        continue;
      }
      if (res.status === 401 && !refreshed) {
        refreshed = true;
        await res.text().catch(() => undefined);
        await this.bearer(true);
        continue;
      }
      if ((res.status === 429 || res.status === 503 || res.status === 504) && attempt < 8) {
        const wait = retryAfterMs(res.headers.get('retry-after'), attempt);
        await res.text().catch(() => undefined);
        this.opts.log?.(`${res.status} on ${url.replace(/\?.*$/, '')}; waiting ${Math.round(wait / 1000)} s`);
        await sleep(wait);
        continue;
      }
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        let code = `http_${res.status}`;
        let message = text.slice(0, 300);
        try {
          const j = JSON.parse(text) as { error?: { code?: string; message?: string } };
          code = j.error?.code ?? code;
          message = j.error?.message ?? message;
        } catch {
          /* non-JSON error body */
        }
        const err = new GraphError(res.status, code, message, url);
        if (res.status === 410) (err as GraphError & { location?: string }).location = res.headers.get('location') ?? undefined;
        throw err;
      }
      const ct = res.headers.get('content-type') ?? '';
      const body = (ct.includes('json') ? await res.json() : await res.text()) as T;
      return { body, headers: res.headers };
    }
  }

  /** Follow `@odata.nextLink` to the end; returns the final `@odata.deltaLink` when present. */
  async *pages<T>(urlOrPath: string, headers: Record<string, string> = {}): AsyncGenerator<GraphPage<T>, string | undefined, void> {
    let next: string | undefined = urlOrPath;
    let delta: string | undefined;
    while (next) {
      const { body }: { body: GraphPage<T> } = await this.get<GraphPage<T>>(next, headers);
      yield body;
      next = body['@odata.nextLink'];
      delta = body['@odata.deltaLink'] ?? delta;
    }
    return delta;
  }

  async all<T>(urlOrPath: string, headers: Record<string, string> = {}): Promise<T[]> {
    const out: T[] = [];
    for await (const page of this.pages<T>(urlOrPath, headers)) out.push(...page.value);
    return out;
  }
}
