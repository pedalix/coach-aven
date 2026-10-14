import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { authorized, handleHttp, parseListen, startServe, type ServeOptions } from './serve.js';
import { openStore } from './store.js';
import { loadProjects } from '../projects.js';

function replica(): string {
  const dir = mkdtempSync(join(tmpdir(), 'serve-'));
  const path = join(dir, 'store.sqlite');
  const db = openStore(path);
  db.prepare("INSERT INTO sync_state(key, value) VALUES ('last_build_at', '2026-10-14T20:00:00.000Z')").run();
  db.close();
  return path;
}
const opts = (dbPath: string, over: Partial<ServeOptions> = {}): ServeOptions => ({ dbPath, token: 'secret-token', slug: 'bluefin-ops', log: () => undefined, ...over });
const auth = { authorization: 'Bearer secret-token' };
const rpc = (id: number, method: string, params?: unknown) => JSON.stringify({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) });

test('parseListen / authorized', () => {
  assert.deepEqual(parseListen('3415'), { host: '127.0.0.1', port: 3415 });
  assert.deepEqual(parseListen('0.0.0.0:80'), { host: '0.0.0.0', port: 80 });
  assert.deepEqual(parseListen('[::1]:9000'), { host: '::1', port: 9000 });
  assert.throws(() => parseListen('nope'), /host:port/);
  assert.throws(() => parseListen('70000'), /out of range/);
  assert.equal(authorized('Bearer secret-token', 'secret-token'), true);
  assert.equal(authorized('bearer secret-token', 'secret-token'), true);
  assert.equal(authorized('Bearer wrong', 'secret-token'), false);
  assert.equal(authorized('Bearer secret-token', ''), false, 'no configured token = nobody is authorized');
  assert.equal(authorized(undefined, 'secret-token'), false);
});

test('handleHttp — the stateless streamable-HTTP surface: auth, methods, JSON-RPC bodies, batches, health', () => {
  const db = replica();
  const o = opts(db);
  assert.equal(handleHttp('POST', '/mcp', {}, rpc(1, 'initialize'), o).status, 401);
  assert.equal(handleHttp('POST', '/mcp', { authorization: 'Bearer nope' }, rpc(1, 'initialize'), o).status, 401);
  assert.equal(handleHttp('POST', '/other', auth, rpc(1, 'initialize'), o).status, 404);
  assert.equal(handleHttp('GET', '/mcp', auth, '', o).status, 405, 'no SSE stream');
  assert.equal(handleHttp('DELETE', '/mcp', auth, '', o).status, 204);
  assert.equal(handleHttp('PUT', '/mcp', auth, '', o).status, 405);
  const init = handleHttp('POST', '/mcp?x=1', { ...auth, 'mcp-protocol-version': '2025-06-18' }, rpc(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } }), o);
  assert.equal(init.status, 200);
  assert.equal(init.headers['content-type'], 'application/json');
  assert.equal(init.headers['mcp-protocol-version'], '2025-06-18');
  const initBody = JSON.parse(init.body) as { result: { serverInfo: { name: string }; protocolVersion: string } };
  assert.equal(initBody.result.serverInfo.name, 'sources');
  assert.equal(handleHttp('POST', '/mcp', auth, JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }), o).status, 202, 'a notification gets 202 and no body');
  const list = JSON.parse(handleHttp('POST', '/mcp', auth, rpc(2, 'tools/list'), o).body) as { result: { tools: { name: string }[] } };
  assert.ok(list.result.tools.some((t) => t.name === 'unanswered') && list.result.tools.some((t) => t.name === 'stats'));
  const stats = JSON.parse(handleHttp('POST', '/mcp', auth, rpc(3, 'tools/call', { name: 'stats', arguments: {} }), o).body) as { result: { content: { text: string }[] } };
  assert.match(stats.result.content[0]!.text, /"last_build_at":"2026-10-14T20:00:00.000Z"/, 'the live replica\'s sync_state is what stats reports');
  const batch = JSON.parse(handleHttp('POST', '/mcp', auth, `[${rpc(4, 'ping')},${rpc(5, 'tools/list')}]`, o).body) as unknown[];
  assert.equal(batch.length, 2);
  assert.equal(handleHttp('POST', '/mcp', auth, '{not json', o).status, 400);
  assert.equal(handleHttp('POST', '/mcp', auth, rpc(6, 'nope'), o).status, 200, 'an unknown method is a JSON-RPC error, not an HTTP one');
  assert.equal(handleHttp('POST', '/mcp', auth, rpc(1, 'initialize'), opts(join(db, '..', 'missing.sqlite'))).status, 503, 'replica gone → 503');
  assert.equal(handleHttp('GET', '/health', {}, '', o).status, 200, 'health needs no token and tells nothing but presence');
  assert.equal(handleHttp('GET', '/health', {}, '', opts(join(db, '..', 'missing.sqlite'))).status, 503);
});

test('startServe — a real loopback round-trip with fetch, and the token check on the wire', async () => {
  const db = replica();
  const port = 20000 + Math.floor(Math.random() * 20000);
  const server = await startServe(`127.0.0.1:${port}`, opts(db));
  try {
    const base = `http://127.0.0.1:${port}`;
    const unauth = await fetch(`${base}/mcp`, { method: 'POST', body: rpc(1, 'ping') });
    assert.equal(unauth.status, 401);
    assert.equal(unauth.headers.get('www-authenticate'), 'Bearer');
    const r = await fetch(`${base}/mcp`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: rpc(1, 'tools/call', { name: 'stats', arguments: {} }) });
    assert.equal(r.status, 200);
    const j = (await r.json()) as { result: { content: { text: string }[] } };
    assert.match(j.result.content[0]!.text, /"tz":/);
    assert.equal((await fetch(`${base}/health`)).status, 200);
    assert.equal((await fetch(`${base}/mcp`, { headers: auth })).status, 405);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('a project with its own `sources` MCP url mounts no replica; one without still does', () => {
  const dir = mkdtempSync(join(tmpdir(), 'proj-'));
  mkdirSync(join(dir, 'projects.d'), { recursive: true });
  const cfg = join(dir, 'projects.config.json');
  const base = { repos: ['x/y'], sources: { youtrack: { url: 'https://x.youtrack.cloud', projects: ['A'] } } };
  writeFileSync(cfg, JSON.stringify({ projects: [
    { slug: 'local', ...base },
    { slug: 'remote', ...base, mcp: [{ name: 'sources', url: 'https://engine.example/gw/remote/mcp', auth: 'gateway-m2m' }] },
  ] }));
  const reg = loadProjects(cfg);
  const mounts = (slug: string) => (reg.projects.find((p) => p.slug === slug)!.sandbox?.mounts ?? []).map((m) => m.split(':')[1]);
  assert.deepEqual(mounts('local').filter((t) => t === '/data/sources'), ['/data/sources']);
  assert.deepEqual(mounts('remote').filter((t) => t === '/data/sources'), []);
});
