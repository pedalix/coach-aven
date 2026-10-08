/**
 * Token store + minimal Slack Web API client. Shared by `auth.ts` (bootstrap) and `pull.ts`.
 *
 * Why no SDK: the whole surface we need is "GET a method with a Bearer token, follow
 * next_cursor, honour Retry-After"; the bot already depends on Bolt for its own app, but the
 * USER-token reads here are a separate trust domain and stay on bare fetch.
 *
 * Design (see README "Why no token rotation"): user tokens (`xoxp-`) do not expire unless the
 * app opts into rotation, so the normal record is just {xoxp, team}. Rotation is supported
 * as a fallback — the record then also carries client_id/secret/refresh_token and the client
 * refreshes on `token_expired`, persisting the new single-use refresh token *before* it is
 * used again (losing it means a laptop re-bootstrap).
 * Docs: https://docs.slack.dev/authentication/tokens
 *       https://docs.slack.dev/authentication/using-token-rotation
 *       https://docs.slack.dev/apis/web-api/rate-limits
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';

// ---------------------------------------------------------------------------------------
// Token store — ~/.config/coach-aven/sources/<slug>/slack.json (tokens.ts), mode 600. The path
// is always passed in; nothing here guesses a home directory.
// ---------------------------------------------------------------------------------------

export interface Rotation {
  client_id: string;
  client_secret: string;
  refresh_token: string;
  /** ISO; access tokens live 43,200 s. We refresh when within 10 min of this. */
  expires_at: string;
}

export interface WorkspaceRecord {
  team_id: string;
  /** Workspace display name from auth.test (`team`). */
  team: string;
  /** `https://pedalix.slack.com/` — permalinks are built on it. */
  url: string;
  user_id: string;
  user: string;
  /** User OAuth token. Never logged, never leaves this file except in the Authorization header. */
  xoxp: string;
  /** App-level token for Socket Mode (optional in v1: polling is the source of truth). */
  xapp?: string;
  /** How far back the first pull goes. Keep SHORT for third-party workspaces (API ToS: no long-term archive of others' data). */
  backfill_days: number;
  added_at: string;
  rotation?: Rotation;
}

export interface TokenStore {
  version: 1;
  workspaces: Record<string, WorkspaceRecord>;
}

export async function loadStore(file: string): Promise<TokenStore> {
  try {
    return normaliseStore(JSON.parse(await fs.readFile(file, 'utf8')));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, workspaces: {} };
    throw err;
  }
}

function normaliseStore(raw: unknown): TokenStore {
  const s = raw as Partial<TokenStore>;
  return { version: 1, workspaces: s.workspaces ?? {} };
}

/**
 * Atomic write: temp file + rename, so a crash mid-write (or a concurrent reader) never sees
 * a truncated store. Matters most with rotation on, where the refresh token inside is
 * single-use. 0600 on the file and 0700 on the dir: this is Owen's full Slack read reach.
 */
export async function saveStore(store: TokenStore, file: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(tmp, file);
}

// ---------------------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------------------

/** The token is dead (revoked, user deactivated, app removed). Not retryable — needs the laptop. */
export class SlackAuthError extends Error {
  constructor(public readonly team_id: string, public readonly code: string) {
    super(`slack auth failed for ${team_id}: ${code}`);
  }
}

export class SlackApiError extends Error {
  constructor(public readonly method: string, public readonly code: string, public readonly status: number) {
    super(`slack ${method} failed: ${code} (http ${status})`);
  }
}

/** Errors that mean "this token will never work again" — distinct from transient / permission errors. */
const DEAD_TOKEN_ERRORS = new Set(['invalid_auth', 'account_inactive', 'token_revoked', 'not_authed', 'team_access_not_granted']);

// ---------------------------------------------------------------------------------------
// HTTP client
// ---------------------------------------------------------------------------------------

export interface SlackResponse {
  ok: boolean;
  error?: string;
  warning?: string;
  response_metadata?: { next_cursor?: string; warnings?: string[] };
  [k: string]: unknown;
}

export interface CallOptions {
  /** POST as form body (needed for oauth.v2.access; everything we read is GET). */
  post?: boolean;
  /** Skip the Bearer header (oauth.v2.access authenticates with client_id/secret in the body). */
  noAuth?: boolean;
  /** Use the app-level token instead of the user token (apps.connections.open). */
  appToken?: boolean;
}

/** Overridable only for tests against a local mock; production never sets it. */
const BASE = process.env.SLACK_API_BASE ?? 'https://slack.com/api';
const MAX_ATTEMPTS = 6;

export type Logger = (msg: string) => void;
export const stderrLog: Logger = (m) => process.stderr.write(`${m}\n`);

/**
 * One client per workspace: rate limits are "per API method per workspace per app"
 * (https://docs.slack.dev/apis/web-api/rate-limits), so pacing state lives here, keyed by method.
 */
export class SlackClient {
  private lastCallAt = new Map<string, number>();
  private refreshing: Promise<void> | null = null;

  constructor(
    public ws: WorkspaceRecord,
    private readonly persist: (ws: WorkspaceRecord) => Promise<void>,
    private readonly log: Logger = stderrLog,
    /** Slack's guidance: design for ~1 request/second per method. Tier 3 (50+/min) tolerates this with headroom for bursts. */
    private readonly minIntervalMs = 1000,
  ) {}

  /** `T` is the caller's view of the ok-response; the index signature on SlackResponse makes the cast honest. */
  async call<T extends SlackResponse = SlackResponse>(method: string, params: Record<string, string | number | boolean | undefined> = {}, opts: CallOptions = {}): Promise<T> {
    let attempt = 0;
    let refreshedOnce = false;
    for (;;) {
      attempt++;
      await this.pace(method);
      let res: Response;
      try {
        res = await this.fetchOnce(method, params, opts);
      } catch (err) {
        // DNS/TLS/connection resets: transient, same treatment as a 5xx.
        if (attempt >= MAX_ATTEMPTS) throw err;
        await sleep(backoffMs(attempt));
        continue;
      }

      if (res.status === 429) {
        // Retry-After is seconds (https://docs.slack.dev/apis/web-api/rate-limits). Add 1 s: the header is a floor.
        const wait = (Number(res.headers.get('retry-after')) || backoffMs(attempt) / 1000) + 1;
        this.log(`  [${this.ws.team_id}] 429 on ${method}, sleeping ${wait}s`);
        await sleep(wait * 1000);
        continue;
      }
      if (res.status >= 500) {
        if (attempt >= MAX_ATTEMPTS) throw new SlackApiError(method, `http_${res.status}`, res.status);
        await sleep(backoffMs(attempt));
        continue;
      }

      const body = (await res.json()) as SlackResponse;
      if (body.ok) return body as T;

      const code = body.error ?? `http_${res.status}`;
      // Expired access token (rotation only). HTTP 401 is included because Slack's error-to-status
      // mapping has changed over the years; the body error is what we actually key on.
      if ((code === 'token_expired' || res.status === 401) && this.ws.rotation && !refreshedOnce) {
        refreshedOnce = true;
        await this.refresh();
        continue;
      }
      if (DEAD_TOKEN_ERRORS.has(code) || code === 'token_expired') throw new SlackAuthError(this.ws.team_id, code);
      if (code === 'ratelimited' || code === 'internal_error' || code === 'service_unavailable' || code === 'fatal_error') {
        if (attempt >= MAX_ATTEMPTS) throw new SlackApiError(method, code, res.status);
        await sleep(backoffMs(attempt));
        continue;
      }
      throw new SlackApiError(method, code, res.status);
    }
  }

  /** Follow `response_metadata.next_cursor` until it is empty. Yields pages, not items, so callers can checkpoint per page. */
  async *paginate(method: string, params: Record<string, string | number | boolean | undefined>): AsyncGenerator<SlackResponse> {
    let cursor: string | undefined;
    do {
      const page = await this.call(method, { ...params, cursor });
      yield page;
      cursor = page.response_metadata?.next_cursor || undefined;
    } while (cursor);
  }

  private async fetchOnce(method: string, params: Record<string, string | number | boolean | undefined>, opts: CallOptions): Promise<Response> {
    const clean = Object.fromEntries(Object.entries(params).filter(([, v]) => v !== undefined && v !== '').map(([k, v]) => [k, String(v)]));
    const headers: Record<string, string> = {};
    if (!opts.noAuth) {
      const token = opts.appToken ? this.ws.xapp : this.ws.xoxp;
      if (!token) throw new SlackAuthError(this.ws.team_id, opts.appToken ? 'missing_xapp' : 'missing_xoxp');
      headers.authorization = `Bearer ${token}`;
    }
    if (opts.post) {
      headers['content-type'] = 'application/x-www-form-urlencoded';
      return fetch(`${BASE}/${method}`, { method: 'POST', headers, body: new URLSearchParams(clean).toString() });
    }
    const qs = new URLSearchParams(clean).toString();
    return fetch(`${BASE}/${method}${qs ? `?${qs}` : ''}`, { headers });
  }

  private async pace(method: string): Promise<void> {
    const last = this.lastCallAt.get(method) ?? 0;
    const wait = last + this.minIntervalMs - Date.now();
    if (wait > 0) await sleep(wait);
    this.lastCallAt.set(method, Date.now());
  }

  /** Proactive refresh for rotation-enabled records, so a long pull does not trip over the 12 h expiry mid-page. */
  async ensureFresh(): Promise<void> {
    const r = this.ws.rotation;
    if (!r) return;
    if (Date.parse(r.expires_at) - Date.now() < 10 * 60 * 1000) await this.refresh();
  }

  /**
   * oauth.v2.access grant_type=refresh_token. Single-flight: a burst of expired calls must not
   * spend the same single-use refresh token twice (the second would get `invalid_refresh_token`).
   * The new tokens are persisted before the method returns — the old refresh token is dead the
   * moment Slack answers.
   */
  private refresh(): Promise<void> {
    if (!this.refreshing) {
      this.refreshing = this.doRefresh().finally(() => {
        this.refreshing = null;
      });
    }
    return this.refreshing;
  }

  private async doRefresh(): Promise<void> {
    const r = this.ws.rotation;
    if (!r) throw new SlackAuthError(this.ws.team_id, 'token_expired');
    this.log(`  [${this.ws.team_id}] refreshing user token`);
    const body = await this.call(
      'oauth.v2.access',
      { client_id: r.client_id, client_secret: r.client_secret, grant_type: 'refresh_token', refresh_token: r.refresh_token },
      { post: true, noAuth: true },
    ).catch((err: unknown) => {
      // Any failure here is terminal for headless operation: say so loudly.
      throw new SlackAuthError(this.ws.team_id, `refresh_failed: ${err instanceof Error ? err.message : String(err)}`);
    });
    const next = extractUserTokens(body);
    this.ws = { ...this.ws, xoxp: next.access_token, rotation: { ...r, refresh_token: next.refresh_token, expires_at: new Date(Date.now() + next.expires_in * 1000).toISOString() } };
    await this.persist(this.ws);
  }
}

/**
 * oauth.v2.access responses put user tokens under `authed_user` on the initial grant, but a
 * refresh of a user token answers with `token_type: "user"` and the tokens at the top level.
 * Handle both. Docs: https://docs.slack.dev/authentication/using-token-rotation
 */
export function extractUserTokens(body: SlackResponse): { access_token: string; refresh_token: string; expires_in: number } {
  const top = body as { token_type?: string; access_token?: string; refresh_token?: string; expires_in?: number };
  const au = body.authed_user as { access_token?: string; refresh_token?: string; expires_in?: number } | undefined;
  const pick = au?.access_token ? au : top.token_type === 'user' || top.access_token?.includes('xoxp') ? top : undefined;
  if (!pick?.access_token || !pick.refresh_token || !pick.expires_in) {
    throw new Error('oauth.v2.access answered without a user access/refresh token pair — is this app user-scoped with rotation on?');
  }
  return { access_token: pick.access_token, refresh_token: pick.refresh_token, expires_in: pick.expires_in };
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** 1s, 2s, 4s … capped at 30s, with jitter so N workspaces do not retry in lockstep. */
export function backoffMs(attempt: number): number {
  return Math.min(30_000, 1000 * 2 ** (attempt - 1)) * (0.8 + Math.random() * 0.4);
}

/** Last 4 chars only — enough to tell two tokens apart in a log, useless to an attacker. */
export function redact(token: string | undefined): string {
  return token ? `${token.slice(0, 5)}…${token.slice(-4)}` : '(none)';
}
