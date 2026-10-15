import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createHostRouter, declares, sourcesRoute, sourcesWorker, type SourcesCall } from './hostrouter.js';
import type { ProjectConfig, RegistryRef } from './projects.js';
import type { HostCaller, JsonRpc } from './hosttools.js';

const project = (slug: string, extra: Partial<ProjectConfig> = {}): ProjectConfig => ({ slug, repos: [`Org/${slug}`], ...extra });
const bluefin = project('bluefin-ops', { sources: { youtrack: { url: 'https://yt', projects: ['CG'] } } });
const own = project('owen-ops', { slackChannel: 'C1', sources: { slack: { workspaces: ['T1'] } }, mcp: [{ name: 'sources', url: 'https://daemon/mcp' }] });
const plain = project('plain');
const reg = { current: { projects: [bluefin, own, plain] } } as RegistryRef;
const caller = (slug: string): HostCaller => ({ slug, conversationKey: 'thread:1' });
const missing = join(mkdtempSync(join(tmpdir(), 'hostrouter-')), 'nope.sqlite');
const noSources: SourcesCall = async () => assert.fail('no sources call expected');

test('routesFor — host only while DISPATCH is on, sources only for a sources project, and a project\'s own server of either name wins', () => {
  const propose = async () => ({ ok: true as const, id: 'p-x', status: 'pending' as const, gate: 'buttons' as const });
  const off = createHostRouter({ reg, home: () => undefined, propose, dispatchEnabled: false, replicaPath: () => missing, sources: noSources });
  assert.deepEqual(off.routesFor(caller('plain'), plain).map((r) => r.name), [], 'prod shape: no dispatch, no sources → nothing registered');
  assert.deepEqual(off.routesFor(caller('bluefin-ops'), bluefin).map((r) => r.name), ['sources'], 'sources needs no flag — only the project block');
  assert.deepEqual(off.routesFor(caller('owen-ops'), own).map((r) => r.name), [], 'a declared `sources` server is the project\'s own; the bot registers none');
  const on = createHostRouter({ reg, home: () => undefined, propose, dispatchEnabled: true, replicaPath: () => missing, sources: noSources });
  assert.deepEqual(on.routesFor(caller('bluefin-ops'), bluefin).map((r) => [r.name, r.timeoutMs]), [['host', 30_000], ['sources', 90_000]]);
  assert.deepEqual(on.routesFor(caller('plain'), project('plain', { mcp: [{ name: 'host', command: 'own' }] })).map((r) => r.name), [], 'a declared `host` wins too');
  assert.equal(declares(own, 'sources'), true);
  assert.equal(declares(bluefin, 'sources'), false);
});

test('the host route — registry lists the team\'s projects with the caller marked; propose reaches the dispatcher with the SESSION\'s slug', async () => {
  const seen: string[] = [];
  const router = createHostRouter({ reg, home: () => undefined, dispatchEnabled: true, replicaPath: () => missing, sources: noSources, propose: async (slug, record) => { seen.push(slug); return { ok: true, id: record.id, status: 'pending', gate: 'buttons' }; } });
  const host = router.routesFor(caller('bluefin-ops'), bluefin)[0]!;
  const call = async (name: string, args: Record<string, unknown> = {}) => JSON.parse(((await host.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })) as { result: { content: { text: string }[] } }).result.content[0]!.text);
  assert.deepEqual(await call('registry'), { projects: [{ slug: 'bluefin-ops', self: true }, { slug: 'owen-ops', channel: 'C1' }, { slug: 'plain' }] });
  assert.equal((await call('propose', { kind: 'message', target: 'owen-ops', text: 'hello', slug: 'evil' })).ok, true);
  assert.deepEqual(seen, ['bluefin-ops']);
});

test('sourcesRoute — a missing replica answers a tools/call as a tool error; a failing call becomes a JSON-RPC error; notifications pass', async () => {
  assert.deepEqual(await sourcesRoute({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'stats', arguments: {} } }, missing, 'bluefin-ops', noSources), { jsonrpc: '2.0', id: 2, result: { content: [{ type: 'text', text: 'sources: the replica for bluefin-ops is not available yet' }], isError: true } });
  const boom: SourcesCall = async () => { throw new Error('worker exited'); };
  assert.deepEqual(await sourcesRoute({ jsonrpc: '2.0', id: 3, method: 'tools/list' }, missing, 'bluefin-ops', boom), { jsonrpc: '2.0', id: 3, error: { code: -32603, message: 'sources: worker exited' } });
  assert.equal(await sourcesRoute({ jsonrpc: '2.0', method: 'notifications/initialized' }, missing, 'bluefin-ops', boom), undefined);
});

test('sourcesWorker — the real tool table answers on a worker thread, in the given zone; a call that outlives its limit restarts the worker', async () => {
  // a minimal store the table can open: an empty sqlite file with the schema the server checks lazily
  const dir = mkdtempSync(join(tmpdir(), 'hostrouter-db-'));
  const db = join(dir, 'store.sqlite');
  new DatabaseSync(db).close();
  const call = sourcesWorker('Europe/Zurich');
  const list = (await call({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, db)) as JsonRpc & { result: { tools: { name: string }[] } };
  assert.ok(list.result.tools.some((t) => t.name === 'unanswered') && list.result.tools.some((t) => t.name === 'search'), 'the same twelve tools');
  const init = (await call({ jsonrpc: '2.0', id: 2, method: 'initialize', params: {} }, db)) as JsonRpc & { result: { serverInfo: { name: string } } };
  assert.equal(init.result.serverInfo.name, 'sources');
  assert.ok(list.result.tools.some((t) => t.name === 'attribution' && /the project's time zone \(stats\.tz; Europe\/Zurich unless/.test((t as { description?: string }).description ?? '')), 'descriptions name the worker\'s default zone (set before the table is imported)');
  assert.equal(await call({ jsonrpc: '2.0', method: 'notifications/initialized' }, db), undefined);
  // a copy of an empty db is still a db: two calls in flight are answered in order, each with its own id
  copyFileSync(db, join(dir, 'b.sqlite'));
  const both = await Promise.all([call({ jsonrpc: '2.0', id: 3, method: 'ping' }, db), call({ jsonrpc: '2.0', id: 4, method: 'ping' }, join(dir, 'b.sqlite'))]);
  assert.deepEqual(both.map((r) => r?.id), [3, 4]);
  // a 1 ms limit cannot be met: the call fails, and the next call works on a fresh worker
  const tight = sourcesWorker('UTC', 1);
  await assert.rejects(() => tight({ jsonrpc: '2.0', id: 5, method: 'tools/list' }, db), /no answer within 0 s — the worker is restarted/);
});
