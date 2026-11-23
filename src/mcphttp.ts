// The HTTP shell of a stateless MCP streamable-HTTP server, shared by the two listeners the host runs:
// `orch sources serve` (src/sources/serve.ts) and the agents' MCP endpoint for people
// (src/messaging/endpoint.ts). The streamable-HTTP spec allows a server that never issues a session id
// and answers every request with application/json: no event stream, no resumability, no
// server-initiated message. The only client of either listener is the installation's gateway.
//
// What is here is the part that must not differ between the two: the listen address, the constant-time
// bearer check, the body limit, and the JSON-RPC framing of a POST (one message or a batch → 200 +
// JSON, notifications only → 202 with no body, junk → 400). What a message MEANS is the caller's.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { utf8Chunks } from './utf8.js';

export const MAX_BODY = 1_000_000;
export const MCP_PATH = '/mcp';

export interface HttpReply {
  status: number;
  body: string;
  headers: Record<string, string>;
}
export type Headers = Record<string, string | undefined>;

/** `host:port` → parts; a bare port binds loopback. */
export function parseListen(s: string): { host: string; port: number } {
  const m = /^(?:(\[[^\]]+\]|[^:]+):)?(\d{1,5})$/.exec(s.trim());
  if (!m) throw new Error(`--listen must be host:port or port, got ${JSON.stringify(s)}`);
  const port = Number(m[2]);
  if (port > 65535) throw new Error(`port out of range: ${port}`); // 0 = any free port (tests)
  return { host: (m[1] ?? '127.0.0.1').replace(/^\[|\]$/g, ''), port };
}

/** Whether a listen host is reachable only from the machine itself. */
export const isLoopback = (host: string): boolean => host === 'localhost' || host === '::1' || /^127\./.test(host);

/** Pure: is this request's Authorization header the configured bearer (constant-time)? */
export function authorized(header: string | undefined, token: string): boolean {
  if (!token) return false;
  const m = /^Bearer\s+(.+)$/i.exec(header ?? '');
  if (!m) return false;
  const a = Buffer.from(m[1]!.trim());
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

const JSON_TYPE = { 'content-type': 'application/json' };
/** A JSON-RPC error with no request to pin it to, as an HTTP reply. */
export const rpcError = (status: number, code: number, message: string): HttpReply => ({ status, body: JSON.stringify({ jsonrpc: '2.0', id: null, error: { code, message } }), headers: JSON_TYPE });

/**
 * The gate every request to the MCP path passes before its body is read as JSON-RPC: the bearer, then the
 * method. Returns the refusal, or undefined for a POST that may go on.
 */
export function gate(method: string, headers: Headers, token: string): HttpReply | undefined {
  if (!authorized(headers.authorization, token)) return { status: 401, body: '', headers: { 'www-authenticate': 'Bearer' } };
  if (method === 'GET') return { status: 405, body: '', headers: { allow: 'POST' } }; // no SSE stream: stateless server
  if (method === 'DELETE') return { status: 204, body: '', headers: {} }; // nothing to end
  if (method !== 'POST') return { status: 405, body: '', headers: { allow: 'POST' } };
  return undefined;
}

/** A POSTed body as JSON-RPC messages: the batch and whether it came as one, or the 400 for junk. */
export function parseRpc(body: string): { batch: unknown[]; isBatch: boolean } | HttpReply {
  let msg: unknown;
  try {
    msg = JSON.parse(body);
  } catch {
    return rpcError(400, -32700, 'parse error');
  }
  return Array.isArray(msg) ? { batch: msg, isBatch: true } : { batch: [msg], isBatch: false };
}

/** The responses of a batch as the HTTP reply: 202 with no body when every message was a notification. */
export function rpcReply(responses: unknown[], isBatch: boolean, headers: Headers): HttpReply {
  const extra: Record<string, string> = {};
  const pv = headers['mcp-protocol-version'];
  if (pv) extra['mcp-protocol-version'] = pv;
  if (!responses.length) return { status: 202, body: '', headers: extra };
  return { status: 200, body: JSON.stringify(isBatch ? responses : responses[0]), headers: { ...JSON_TYPE, ...extra } };
}

/**
 * Start a listener: each request is read whole (413 past the body limit), handed to `handle` with
 * lower-cased headers, and answered with what it returns; a handler that throws answers 500 and is
 * reported to `onError`. Resolves with the server once bound.
 */
export function listenHttp(
  listen: string,
  handle: (method: string, url: string, headers: Headers, body: string) => HttpReply | Promise<HttpReply>,
  onError: (e: unknown) => void,
): Promise<Server> {
  const { host, port } = parseListen(listen);
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
      const headers: Headers = {};
      for (const [k, v] of Object.entries(req.headers)) headers[k.toLowerCase()] = Array.isArray(v) ? v[0] : v;
      void (async () => {
        let r: HttpReply;
        try {
          r = await handle(req.method ?? 'GET', req.url ?? '/', headers, body);
        } catch (e) {
          onError(e);
          r = { status: 500, body: '', headers: {} };
        }
        if (res.destroyed) return; // the client hung up while the call was held
        res.writeHead(r.status, { ...r.headers, ...(r.body ? { 'content-length': String(Buffer.byteLength(r.body)) } : {}) });
        res.end(r.body);
      })();
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve(server));
  });
}
