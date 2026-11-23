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
import type { Server } from 'node:http';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { handleMessage } from '../../snapshot/plain/sources-mcp.mjs';
import { REPLICA_FILE } from './store.js';
import { replicaDir } from './paths.js';
import { gate, listenHttp, MCP_PATH, parseListen, parseRpc, rpcError, rpcReply, type Headers, type HttpReply } from '../mcphttp.js';

// The HTTP shell — listen address, bearer check, body limit, JSON-RPC framing — is shared with the
// agents' MCP endpoint (src/mcphttp.ts); re-exported here for this command's callers and tests.
export { authorized, MAX_BODY, MCP_PATH, parseListen } from '../mcphttp.js';
export const SERVE_TOKEN_ENV = 'SOURCES_SERVE_TOKEN';
export const DEFAULT_LISTEN = '127.0.0.1:3415';

export interface ServeOptions {
  /** The replica file served (default data/<slug>/replica/store.sqlite). */
  dbPath: string;
  /** Required bearer; empty = refuse every request (never serve a tenant store unauthenticated by accident). */
  token: string;
  /** Project slug, for the log line and the health answer. */
  slug: string;
  log?: (line: string) => void;
}

/**
 * Pure: one HTTP request → status + body. Exported so the test exercises the whole protocol surface
 * without sockets: POST /mcp with a JSON-RPC message (or a batch) answers 200 + JSON, a notification
 * 202 with no body, junk 400; GET /health 200 for monitoring; everything else 404/405.
 */
export function handleHttp(method: string, url: string, headers: Headers, body: string, o: ServeOptions): HttpReply {
  const path = url.split('?')[0] ?? url;
  if (path === '/health' && method === 'GET') {
    const ok = existsSync(o.dbPath);
    return { status: ok ? 200 : 503, body: JSON.stringify({ ok, slug: o.slug, replica: ok ? 'present' : 'missing' }), headers: { 'content-type': 'application/json' } };
  }
  if (path !== MCP_PATH) return { status: 404, body: '', headers: {} };
  const refused = gate(method, headers, o.token);
  if (refused) return refused;
  if (!existsSync(o.dbPath)) return rpcError(503, -32000, `replica not available for ${o.slug}`);
  const rpc = parseRpc(body);
  if ('status' in rpc) return rpc;
  return rpcReply(rpc.batch.map((m) => handleMessage(m, o.dbPath)).filter((r): r is Record<string, unknown> => !!r), rpc.isBatch, headers);
}

export function replicaPathFor(slug: string): string {
  return join(replicaDir(slug), REPLICA_FILE);
}

/** Start the listener; resolves with the server once bound. */
export async function startServe(listen: string, o: ServeOptions): Promise<Server> {
  const { host, port } = parseListen(listen);
  const log = o.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  const server = await listenHttp(listen, (method, url, headers, body) => handleHttp(method, url, headers, body, o), (e) => log(`serve ${o.slug}: ${e instanceof Error ? e.message : String(e)}`));
  log(`sources serve ${o.slug}: http://${host}:${port}${MCP_PATH} → ${o.dbPath}${o.token ? '' : ' (NO TOKEN — refusing every request)'}`);
  return server;
}
