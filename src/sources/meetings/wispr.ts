// Wispr Flow Notetaker. There is no REST API and no personal token — the only programmatic door
// is the remote MCP server https://api.wisprflow.ai/connect/mcp. It is headless-capable, though,
// because its authorization server (https://mcp-auth.wisprflow.com, RFC 8414 metadata) supports
// dynamic client registration, the DEVICE CODE grant and refresh tokens with `offline_access`
// (verified 2026-10-09 against /.well-known/oauth-authorization-server). So:
//
//   orch sources auth <slug> meetings wispr login   registers a public client (once), starts a
//        device flow, prints the verification URL + code for the operator to approve in a browser
//        (Google/Apple/Microsoft/SSO sign-in — Wispr's email+password logins cannot authorize MCP),
//        and stores { client_id, refresh_token } in ~/.config/coach-aven/sources/<slug>/wispr.json.
//   pull: refresh → access token → MCP initialize → tools/call search_meetings / get_meeting.
//
// Refresh tokens may rotate; every refresh rewrites the file. MCP over streamable HTTP: a POST
// may answer JSON or an SSE stream; we read the body once and parse either.
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { TrackerHttpError } from '../trackers/http.js';
import { readTokenFile, writeTokenFile } from '../trackers/writer.js';
import type { PullContext } from '../types.js';
import { normaliseWisprMeeting } from './normalise.js';
import { MeetingWriter, meetingDir, needsFetch, readMeetingCursor, writeMeetingCursor } from './writer.js';

export const WISPR_MCP = 'https://api.wisprflow.ai/connect/mcp';
export const WISPR_AUTH = 'https://mcp-auth.wisprflow.com';
const SCOPE = 'openid offline_access email';
const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';

export interface WisprToken {
  client_id: string;
  refresh_token?: string;
  access_token?: string;
  /** ms epoch */
  expires_at?: number;
  account?: string;
}

export class WisprReauth extends Error {}

type Rec = Record<string, unknown>;
const form = (o: Record<string, string>) => new URLSearchParams(o).toString();

async function post(url: string, body: string, contentType: string, fetchImpl: typeof fetch): Promise<{ status: number; json: Rec }> {
  const res = await fetchImpl(url, { method: 'POST', headers: { 'content-type': contentType, accept: 'application/json' }, body });
  const text = await res.text();
  let json: Rec = {};
  try {
    json = text ? (JSON.parse(text) as Rec) : {};
  } catch {
    json = { error: 'non_json', error_description: text.slice(0, 200) };
  }
  return { status: res.status, json };
}

export async function registerClient(fetchImpl: typeof fetch = fetch): Promise<string> {
  const r = await post(
    `${WISPR_AUTH}/oauth2/register`,
    JSON.stringify({
      client_name: 'coach-aven sources',
      // A redirect URI is mandatory for registration even though we only use the device grant.
      redirect_uris: ['http://127.0.0.1:53682/callback'], // the browser login's loopback (WISPR_REDIRECT)
      grant_types: ['authorization_code', DEVICE_GRANT, 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      scope: SCOPE,
    }),
    'application/json',
    fetchImpl,
  );
  const id = r.json.client_id;
  if (typeof id !== 'string' || !id) throw new Error(`wispr: client registration failed: ${JSON.stringify(r.json).slice(0, 200)}`);
  return id;
}

/** Interactive part of `login`: start the device flow, print the code, poll until approved. */
export async function deviceLogin(tokenPath: string, log: (l: string) => void, fetchImpl: typeof fetch = fetch, sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))): Promise<WisprToken> {
  const existing = readTokenFile<WisprToken>(tokenPath);
  const client_id = existing?.client_id ?? (await registerClient(fetchImpl));
  const d = await post(`${WISPR_AUTH}/oauth2/device_authorization`, form({ client_id, scope: SCOPE, resource: WISPR_MCP }), 'application/x-www-form-urlencoded', fetchImpl);
  if (d.status !== 200 || typeof d.json.device_code !== 'string') throw new Error(`wispr: device authorization failed: ${JSON.stringify(d.json).slice(0, 200)}`);
  log(`Open ${String(d.json.verification_uri_complete ?? d.json.verification_uri)} and approve code ${String(d.json.user_code)} (sign in with Google/Apple/Microsoft/SSO; expires in ${String(d.json.expires_in)}s)`);
  let interval = Number(d.json.interval ?? 5) * 1000;
  const deadline = Date.now() + Number(d.json.expires_in ?? 300) * 1000;
  while (Date.now() < deadline) {
    await sleep(interval);
    const t = await post(`${WISPR_AUTH}/oauth2/token`, form({ grant_type: DEVICE_GRANT, device_code: d.json.device_code, client_id }), 'application/x-www-form-urlencoded', fetchImpl);
    if (t.status === 200 && typeof t.json.access_token === 'string') {
      const tok: WisprToken = {
        client_id,
        access_token: t.json.access_token,
        expires_at: Date.now() + (Number(t.json.expires_in ?? 3600) - 60) * 1000,
        ...(typeof t.json.refresh_token === 'string' ? { refresh_token: t.json.refresh_token } : {}),
      };
      if (!tok.refresh_token) log('wispr: WARNING — no refresh token returned; the pull will need a new login when the access token expires');
      writeTokenFile(tokenPath, tok);
      return tok;
    }
    const err = String(t.json.error ?? '');
    if (err === 'authorization_pending') continue;
    if (err === 'slow_down') {
      interval += 5000;
      continue;
    }
    throw new Error(`wispr: device flow failed: ${err} ${String(t.json.error_description ?? '')}`);
  }
  throw new Error('wispr: device code expired before approval');
}

export const WISPR_REDIRECT = 'http://127.0.0.1:53682/callback';

function tokenFrom(client_id: string, j: Rec): WisprToken {
  return {
    client_id,
    access_token: String(j.access_token),
    expires_at: Date.now() + (Number(j.expires_in ?? 3600) - 60) * 1000,
    ...(typeof j.refresh_token === 'string' ? { refresh_token: j.refresh_token } : {}),
  };
}

/** Pure: the authorize URL for the PKCE loopback flow (tested). */
export function authorizeUrl(client_id: string, challenge: string, state: string): string {
  const q = new URLSearchParams({
    response_type: 'code',
    client_id,
    redirect_uri: WISPR_REDIRECT,
    scope: SCOPE,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
    resource: WISPR_MCP,
  });
  return `${WISPR_AUTH}/oauth2/authorize?${q.toString()}`;
}

/**
 * Browser login: authorization code + PKCE over the loopback redirect registered at DCR time.
 * Why not only the device flow: Wispr's hosted login page rejects device-code approvals with
 * "Missing external_auth_id" (its IdP needs the browser round-trip the code flow provides),
 * although the metadata advertises the device grant. Under WSL2 the Windows browser reaches the
 * 127.0.0.1 listener through localhost forwarding; if it does not, paste the final redirect URL.
 */
export async function browserLogin(tokenPath: string, log: (l: string) => void, fetchImpl: typeof fetch = fetch): Promise<WisprToken> {
  const existing = readTokenFile<WisprToken>(tokenPath);
  const client_id = existing?.client_id ?? (await registerClient(fetchImpl));
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const state = randomBytes(16).toString('base64url');
  const code = await new Promise<string>((resolve, reject) => {
    const server = createServer((req, res) => {
      const u = new URL(req.url ?? '/', WISPR_REDIRECT);
      if (u.pathname !== '/callback') { res.writeHead(404).end(); return; }
      const err = u.searchParams.get('error');
      const c = u.searchParams.get('code');
      const ok = !err && c && u.searchParams.get('state') === state;
      res.writeHead(ok ? 200 : 400, { 'content-type': 'text/plain; charset=utf-8' }).end(ok ? 'Wispr connected — you can close this tab.' : `Wispr login failed: ${err ?? 'state mismatch'}`);
      server.close();
      ok ? resolve(c!) : reject(new Error(`wispr: authorize failed: ${err ?? 'state mismatch'} ${u.searchParams.get('error_description') ?? ''}`));
    });
    server.on('error', reject);
    server.listen(53682, '127.0.0.1', () => log(`Open this URL in your browser and sign in to Wispr:\n${authorizeUrl(client_id, challenge, state)}`));
    setTimeout(() => { server.close(); reject(new Error('wispr: no redirect within 10 minutes')); }, 600_000).unref();
  });
  const t = await post(`${WISPR_AUTH}/oauth2/token`, form({ grant_type: 'authorization_code', code, redirect_uri: WISPR_REDIRECT, client_id, code_verifier: verifier }), 'application/x-www-form-urlencoded', fetchImpl);
  if (t.status !== 200 || typeof t.json.access_token !== 'string') throw new Error(`wispr: code exchange failed: ${JSON.stringify(t.json).slice(0, 200)}`);
  const tok = tokenFrom(client_id, t.json);
  if (!tok.refresh_token) log('wispr: WARNING — no refresh token returned; the pull will need a new login when the access token expires');
  writeTokenFile(tokenPath, tok);
  return tok;
}

/** A valid access token, refreshing (and persisting the rotated refresh token) when needed. */
export async function accessToken(tokenPath: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  const t = readTokenFile<WisprToken>(tokenPath);
  if (!t?.client_id) throw new WisprReauth(`no Wispr credentials in ${tokenPath}`);
  if (t.access_token && t.expires_at && t.expires_at > Date.now()) return t.access_token;
  if (!t.refresh_token) throw new WisprReauth('Wispr access token expired and no refresh token stored');
  const r = await post(`${WISPR_AUTH}/oauth2/token`, form({ grant_type: 'refresh_token', refresh_token: t.refresh_token, client_id: t.client_id }), 'application/x-www-form-urlencoded', fetchImpl);
  if (r.status !== 200 || typeof r.json.access_token !== 'string') {
    if (r.status === 400 || r.status === 401) throw new WisprReauth(`Wispr refresh rejected: ${String(r.json.error ?? r.status)}`);
    throw new Error(`Wispr refresh failed: HTTP ${r.status}`);
  }
  const next: WisprToken = {
    ...t,
    access_token: r.json.access_token,
    expires_at: Date.now() + (Number(r.json.expires_in ?? 3600) - 60) * 1000,
    ...(typeof r.json.refresh_token === 'string' ? { refresh_token: r.json.refresh_token } : {}),
  };
  writeTokenFile(tokenPath, next);
  return next.access_token!;
}

// ── minimal MCP client (streamable HTTP) ─────────────────────────────────────────────────

/** Parse a JSON-RPC response body that is either plain JSON or an SSE stream; pick the frame with `id`. */
export function parseRpcBody(body: string, id: number): Rec | undefined {
  const frames: string[] = [];
  if (/^\s*[[{]/.test(body)) frames.push(body);
  else for (const line of body.split(/\r?\n/)) if (line.startsWith('data:')) frames.push(line.slice(5).trim());
  for (const f of frames) {
    try {
      const j = JSON.parse(f) as Rec | Rec[];
      for (const m of Array.isArray(j) ? j : [j]) if (m && m.id === id) return m;
    } catch {
      /* keep-alive or partial frame */
    }
  }
  return undefined;
}

/** A tools/call result's first text content, JSON-decoded when it is JSON. */
export function toolPayload(result: Rec | undefined): unknown {
  const content = (result?.content as Rec[] | undefined) ?? [];
  const text = content.find((c) => c?.type === 'text')?.text;
  if (typeof text !== 'string') return result?.structuredContent ?? result;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export class WisprMcp {
  private session?: string;
  private nextId = 1;
  constructor(
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async rpc(method: string, params: Rec | undefined, notify = false): Promise<Rec | undefined> {
    const id = this.nextId++;
    const body = JSON.stringify(notify ? { jsonrpc: '2.0', method, ...(params ? { params } : {}) } : { jsonrpc: '2.0', id, method, ...(params ? { params } : {}) });
    for (let attempt = 0; attempt < 4; attempt++) {
      const res = await this.fetchImpl(WISPR_MCP, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.token}`,
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'mcp-protocol-version': '2025-06-18',
          ...(this.session ? { 'mcp-session-id': this.session } : {}),
        },
        body,
      });
      const text = await res.text(); // the one read
      const sid = res.headers.get('mcp-session-id');
      if (sid) this.session = sid;
      if (res.status === 429 || res.status >= 500) {
        // Wispr docs: "Too many requests: wait about a minute, then retry."
        await new Promise((r) => setTimeout(r, Math.min(60_000, 15_000 * (attempt + 1))));
        continue;
      }
      if (res.status === 401 || res.status === 403) throw new WisprReauth(`Wispr MCP refused the token (HTTP ${res.status})`);
      if (res.status < 200 || res.status >= 300) throw new TrackerHttpError(res.status, WISPR_MCP, text);
      if (notify) return undefined;
      const msg = parseRpcBody(text, id);
      if (!msg) throw new Error(`wispr MCP: no response frame for ${method}`);
      if (msg.error) throw new Error(`wispr MCP ${method}: ${JSON.stringify(msg.error).slice(0, 200)}`);
      return msg.result as Rec;
    }
    throw new Error(`wispr MCP ${method}: rate limited`);
  }

  async init(): Promise<void> {
    await this.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'coach-aven-sources', version: '1.0' } });
    await this.rpc('notifications/initialized', undefined, true);
  }

  async call(name: string, args: Rec): Promise<unknown> {
    const r = await this.rpc('tools/call', { name, arguments: args });
    if (r?.isError) throw new Error(`wispr ${name}: ${JSON.stringify(toolPayload(r)).slice(0, 200)}`);
    return toolPayload(r);
  }
}

/** Find the next transcript offset in a bounded transcript response (field or the appended marker). */
export function transcriptPage(payload: unknown): { text: string; next?: number } {
  const p = (payload ?? {}) as Rec;
  const t = p.transcript as unknown;
  let text = '';
  let next: number | undefined;
  if (typeof t === 'string') text = t;
  else if (t && typeof t === 'object') {
    const o = t as Rec;
    text = String(o.text ?? o.content ?? '');
    if (typeof o.next_start_char === 'number') next = o.next_start_char;
    if (o.truncated === true && typeof o.end_char === 'number') next = o.end_char;
  }
  if (next === undefined) {
    const m = /start_char[^0-9]{0,12}(\d+)/.exec(text.slice(-400));
    if (m && /truncat|continu/i.test(text.slice(-400))) {
      next = Number(m[1]);
      text = text.replace(/\n?[^\n]*(truncat|continu)[^\n]*$/i, '');
    }
  }
  return { text, ...(next !== undefined ? { next } : {}) };
}

export interface WisprPullResult {
  account: string;
  count: number;
  withheld: number;
  reauth: boolean;
  error?: string;
}

export async function pullWispr(ctx: PullContext, tokenPath: string, o: { since?: string; full?: boolean; fetchImpl?: typeof fetch; now?: () => Date } = {}): Promise<WisprPullResult> {
  const now = o.now ?? (() => new Date());
  const f = o.fetchImpl ?? fetch;
  let account = readTokenFile<WisprToken>(tokenPath)?.account ?? 'wispr';
  const dir = meetingDir(ctx.outDir, 'wispr', 'wispr');
  const cursor = readMeetingCursor(dir);
  const writer = new MeetingWriter(ctx, dir);
  try {
    const mcp = new WisprMcp(await accessToken(tokenPath, f), f);
    await mcp.init();
    if (account === 'wispr') {
      try {
        const info = (await mcp.call('get_account_info', {})) as Rec;
        const email = String(info?.email ?? (info?.account as Rec | undefined)?.email ?? '');
        if (email) {
          account = email.toLowerCase();
          const t = readTokenFile<WisprToken>(tokenPath);
          if (t) writeTokenFile(tokenPath, { ...t, account });
        }
      } catch {
        /* optional */
      }
    }
    let cursorTok: string | undefined;
    const since = o.since ? `${o.since}T00:00:00Z` : undefined;
    let pages = 0;
    do {
      const res = (await mcp.call('search_meetings', { ...(since ? { since } : {}), limit: 50, ...(cursorTok ? { cursor: cursorTok } : {}) })) as Rec;
      for (const m of (Array.isArray(res?.meetings) ? res.meetings : []) as Rec[]) {
        const id = String(m.id ?? '');
        if (!id || m.finalized === false) continue; // still processing — next run
        const version = String(m.modified_at ?? m.end ?? '');
        if (!needsFetch(cursor, id, version, o.full)) continue;
        const full = (await mcp.call('get_meeting', { meeting_id: id })) as Rec;
        let transcript = '';
        if (m.has_transcript !== false) {
          let start = 0;
          for (let i = 0; i < 20; i++) {
            const page = transcriptPage(await mcp.call('get_meeting', { meeting_id: id, view_transcript: { start_char: start, char_limit: 40000 } }));
            transcript += page.text;
            if (page.next === undefined || page.next <= start) break;
            start = page.next;
          }
        }
        writer.write(normaliseWisprMeeting({ ...m, ...full }, transcript.trim(), account));
        cursor.seen[id] = version;
      }
      cursorTok = res?.has_more ? String(res?.next_cursor ?? '') || undefined : undefined;
    } while (cursorTok && ++pages < 50);
    writeMeetingCursor(dir, { seen: cursor.seen, lastRunAt: now().toISOString() });
    ctx.log(`wispr/${account}: ${writer.count} meetings`);
    return { account, count: writer.count, withheld: writer.withheld, reauth: false };
  } catch (e) {
    writeMeetingCursor(dir, { seen: cursor.seen, lastRunAt: now().toISOString() });
    return { account, count: writer.count, withheld: writer.withheld, reauth: e instanceof WisprReauth || (e instanceof TrackerHttpError && e.reauth), error: e instanceof Error ? e.message : String(e) };
  }
}
