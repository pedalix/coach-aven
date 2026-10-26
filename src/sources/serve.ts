// `orch sources serve <slug>` — the project's sources tools over MCP streamable HTTP, served by the
// host from the live replica (docs/sources.md → "Remote access", OpenSpec sources-serve-remote-mcp).
//
// Why: the replica bind mount only reaches sandboxes on the bot host's own docker engine (the home
// bot). Prod sandboxes run on a separate sandbox host (ssh-docker over ssh) — nothing on the bot host —
// so a tenant store there is reachable only over the network. agentgateway (engine.example.com)
// already fronts every project's MCP servers; this listener is one more upstream target for it,
// and the sandbox keeps talking to the gateway with its Auth0 M2M token exactly as for every
// other remote server (`mcp` entry with `url` + `auth: "gateway-m2m"`, docs/runtime-config.md).
//
// Shape: ONE tool table, two transports. The stdio server (snapshot/plain/sources-mcp.mjs) is
// imported here unchanged and its `handleMessage` answers each POSTed JSON-RPC message; the DB is
// opened per call there, so the replica swapped by a build between two calls is picked up without
// any restart. Stateless on purpose (the streamable-HTTP spec allows a server that never issues a
// session id and answers requests with application/json): no SSE stream, no resumability, no
// server-initiated messages — the gateway is the only client and needs none of them. A client that
// insists on an event stream gets 405 on GET and must fall back to plain POST (every MCP client does).
//
// Auth: a static bearer from SOURCES_SERVE_TOKEN (the gateway's .env holds the same value and sets
// the header on its target). Bound to loopback by default — TLS and the public name are nginx's
// job on the bot host (infra/deploy/). Requests without the right bearer get 401 and no body.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { handleMessage } from '../../snapshot/plain/sources-mcp.mjs';
import { REPLICA_FILE } from './store.js';
import { replicaDir } from './paths.js';
import { utf8Chunks } from '../utf8.js';

export const SERVE_TOKEN_ENV = 'SOURCES_SERVE_TOKEN';
export const DEFAULT_LISTEN = '127.0.0.1:3415';
export const MAX_BODY = 1_000_000;
export const MCP_PATH = '/mcp';

export interface ServeOptions {
  /** The replica file served (default data/<slug>/replica/store.sqlite). */
  dbPath: string;
  /** Required bearer; empty = refuse every request (never serve a tenant store unauthenticated by accident). */
  token: string;
  /** Project slug, for the log line and the health answer. */
  slug: string;
  log?: (line: string) => void;
}

/** `host:port` → parts; a bare port binds loopback. */
export function parseListen(s: string): { host: string; port: number } {
  const m = /^(?:(\[[^\]]+\]|[^:]+):)?(\d{1,5})$/.exec(s.trim());
  if (!m) throw new Error(`--listen must be host:port or port, got ${JSON.stringify(s)}`);
  const port = Number(m[2]);
  if (port > 65535) throw new Error(`port out of range: ${port}`); // 0 = any free port (tests)
  return { host: (m[1] ?? '127.0.0.1').replace(/^\[|\]$/g, ''), port };
}

/** Pure: is this request's Authorization header the configured bearer (constant-time)? */
export function authorized(header: string | undefined, token: string): boolean {
  if (!token) return false;
  const m = /^Bearer\s+(.+)$/i.exec(header ?? '');
  if (!m) return false;
  const a = Buffer.from(m[1]!.trim());
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Pure: one HTTP request → status + body. Exported so the test exercises the whole protocol surface
 * without sockets: POST /mcp with a JSON-RPC message (or a batch) answers 200 + JSON, a notification
 * 202 with no body, junk 400; GET /health 200 for monitoring; everything else 404/405.
 */
export function handleHttp(
  method: string,
  url: string,
  headers: Record<string, string | undefined>,
  body: string,
  o: ServeOptions,
): { status: number; body: string; headers: Record<string, string> } {
  const path = url.split('?')[0] ?? url;
  if (path === '/health' && method === 'GET') {
    const ok = existsSync(o.dbPath);
    return { status: ok ? 200 : 503, body: JSON.stringify({ ok, slug: o.slug, replica: ok ? 'present' : 'missing' }), headers: { 'content-type': 'application/json' } };
  }
  if (path !== MCP_PATH) return { status: 404, body: '', headers: {} };
  if (!authorized(headers.authorization, o.token)) return { status: 401, body: '', headers: { 'www-authenticate': 'Bearer' } };
  if (method === 'GET') return { status: 405, body: '', headers: { allow: 'POST' } }; // no SSE stream: stateless server
  if (method === 'DELETE') return { status: 204, body: '', headers: {} }; // nothing to end
  if (method !== 'POST') return { status: 405, body: '', headers: { allow: 'POST' } };
  if (!existsSync(o.dbPath)) {
    return { status: 503, body: JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32000, message: `replica not available for ${o.slug}` } }), headers: { 'content-type': 'application/json' } };
  }
  let msg: unknown;
  try {
    msg = JSON.parse(body);
  } catch {
    return { status: 400, body: JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }), headers: { 'content-type': 'application/json' } };
  }
  const batch = Array.isArray(msg) ? msg : [msg];
  const out = batch.map((m) => handleMessage(m, o.dbPath)).filter((r): r is Record<string, unknown> => !!r);
  const extra: Record<string, string> = {};
  const pv = headers['mcp-protocol-version'];
  if (pv) extra['mcp-protocol-version'] = pv;
  if (!out.length) return { status: 202, body: '', headers: extra }; // notification(s) only
  return { status: 200, body: JSON.stringify(Array.isArray(msg) ? out : out[0]), headers: { 'content-type': 'application/json', ...extra } };
}

export function replicaPathFor(slug: string): string {
  return join(replicaDir(slug), REPLICA_FILE);
}

/** Start the listener; resolves with the server once bound. */
export function startServe(listen: string, o: ServeOptions): Promise<Server> {
  const { host, port } = parseListen(listen);
  const log = o.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let body = '';
    let over = false;
    const dec = utf8Chunks(); // a per-chunk toString splits multibyte chars in the JSON body
    req.on('data', (chunk: Buffer) => {
      if (over) return;
      body += dec.push(chunk);
      if (body.length > MAX_BODY) {
        over = true;
        res.writeHead(413).end();
        req.destroy();
      }
    });
    req.on('end', () => {
      if (over) return;
      body += dec.flush();
      const headers: Record<string, string | undefined> = {};
      for (const [k, v] of Object.entries(req.headers)) headers[k.toLowerCase()] = Array.isArray(v) ? v[0] : v;
      let r: ReturnType<typeof handleHttp>;
      try {
        r = handleHttp(req.method ?? 'GET', req.url ?? '/', headers, body, o);
      } catch (e) {
        log(`serve ${o.slug}: ${e instanceof Error ? e.message : String(e)}`);
        r = { status: 500, body: '', headers: {} };
      }
      res.writeHead(r.status, { ...r.headers, ...(r.body ? { 'content-length': String(Buffer.byteLength(r.body)) } : {}) });
      res.end(r.body);
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      log(`sources serve ${o.slug}: http://${host}:${port}${MCP_PATH} → ${o.dbPath}${o.token ? '' : ' (NO TOKEN — refusing every request)'}`);
      resolve(server);
    });
  });
}
