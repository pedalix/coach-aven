import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createHostRouter, daemonRoute, declares, sourcesRoute, sourcesWorker, type SourcesCall } from './hostrouter.js';
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

test('daemonRoute — tools/call goes to the daemon; initialize and tools/list stay local; an unreachable daemon is a tool error, never a dead server', async () => {
  const cfg = { url: 'http://127.0.0.1:3416', tokenEnv: 'X_TOKEN' };
  const local: SourcesCall = async (m) => ({ jsonrpc: '2.0', id: m.id ?? null, result: { local: m.method } });
  const forwarded: JsonRpc[] = [];
  const up = async (_c: typeof cfg, slug: string, m: JsonRpc): Promise<JsonRpc> => {
    forwarded.push(m);
    return { jsonrpc: '2.0', id: m.id ?? null, result: { daemon: slug } };
  };
  assert.deepEqual(await daemonRoute({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }, cfg, 'acme', local, up), { jsonrpc: '2.0', id: 1, result: { local: 'initialize' } });
  assert.deepEqual(await daemonRoute({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, cfg, 'acme', local, up), { jsonrpc: '2.0', id: 2, result: { local: 'tools/list' } });
  assert.equal(forwarded.length, 0, 'a session opens without the daemon');
  assert.deepEqual(await daemonRoute({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'stats', arguments: {} } }, cfg, 'acme', local, up), { jsonrpc: '2.0', id: 3, result: { daemon: 'acme' } });
  const down = async (): Promise<JsonRpc> => {
    throw new Error('connect ECONNREFUSED 127.0.0.1:3416');
  };
  const r = await daemonRoute({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'stats', arguments: {} } }, cfg, 'acme', local, down);
  assert.deepEqual(r, { jsonrpc: '2.0', id: 4, result: { content: [{ type: 'text', text: 'sources: the daemon for acme is unavailable (connect ECONNREFUSED 127.0.0.1:3416)' }], isError: true } });
  // the router picks the daemon route for a project with `sources.daemon`
  const viaDaemon = project('acme', { sources: { youtrack: { url: 'https://yt', projects: ['AC'] }, daemon: cfg } });
  const router = createHostRouter({ reg: { current: { projects: [viaDaemon] } } as RegistryRef, home: () => undefined, propose: async () => assert.fail('no propose'), dispatchEnabled: false, replicaPath: () => missing, sources: local, forward: up });
  const [route] = router.routesFor(caller('acme'), viaDaemon);
  assert.deepEqual(await route!.handle({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'stats', arguments: {} } }), { jsonrpc: '2.0', id: 5, result: { daemon: 'acme' } });
});

// ── agent messaging (OpenSpec agent-messaging, tasks 3.5 / 5.1) ─────────────────────────────────────
const fakeMessaging = { sendMessage: () => ({ ok: true, data: {} }) } as unknown as import('./messaging/service.js').Messaging;
const sender = project('owen-ops', { messaging: { send: true } });
const answerOnly = project('caldora', { messaging: { accept: ['owen-ops'] } });
const toolNames = async (r: ReturnType<typeof createHostRouter>, c: HostCaller, p: ProjectConfig): Promise<string[] | undefined> => {
  const host = r.routesFor(c, p).find((x) => x.name === 'host');
  if (!host) return undefined;
  const list = (await host.handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' })) as { result: { tools: { name: string }[] } };
  return list.result.tools.map((t) => t.name);
};
const propose = async () => ({ ok: true as const, id: 'p-x', status: 'pending' as const, gate: 'buttons' as const });

test('installation without configuration / project not configured: no `host`, exactly as before — with or without the service', async () => {
  for (const messaging of [undefined, () => fakeMessaging]) {
    const r = createHostRouter({ reg, home: () => undefined, propose, dispatchEnabled: false, replicaPath: () => missing, sources: noSources, ...(messaging ? { messaging } : {}) });
    assert.equal(await toolNames(r, caller('plain'), plain), undefined);
  }
});

test('nothing is registered without the gate: a messaging project without the service started gets nothing either', async () => {
  const r = createHostRouter({ reg, home: () => undefined, propose, dispatchEnabled: false, replicaPath: () => missing, sources: noSources, messaging: () => undefined });
  assert.equal(await toolNames(r, caller('owen-ops'), sender), undefined);
});

test('messaging without dispatch: a sending project gets the messaging tools only; with DISPATCH both; an answer-only project outside a task gets none', async () => {
  const off = createHostRouter({ reg, home: () => undefined, propose, dispatchEnabled: false, replicaPath: () => missing, sources: noSources, messaging: () => fakeMessaging });
  assert.deepEqual(await toolNames(off, caller('owen-ops'), sender), ['send_message', 'get_task', 'cancel_task', 'agents']);
  assert.equal(await toolNames(off, caller('caldora'), answerOnly), undefined);
  const on = createHostRouter({ reg, home: () => undefined, propose, dispatchEnabled: true, replicaPath: () => missing, sources: noSources, messaging: () => fakeMessaging });
  assert.deepEqual(await toolNames(on, caller('owen-ops'), sender), ['propose', 'registry', 'send_message', 'get_task', 'cancel_task', 'agents']);
});

test('shadow conversation: request_input, the sending tools when the project may send — never propose or registry (nobody can click there)', async () => {
  const on = createHostRouter({ reg, home: () => undefined, propose, dispatchEnabled: true, replicaPath: () => missing, sources: noSources, messaging: () => fakeMessaging });
  const shadow: HostCaller = { slug: 'caldora', conversationKey: `a2a:home:${'a'.repeat(24)}:caldora` };
  assert.deepEqual(await toolNames(on, shadow, answerOnly), ['request_input']);
  assert.deepEqual(await toolNames(on, { ...shadow, slug: 'owen-ops' }, sender), ['send_message', 'get_task', 'cancel_task', 'agents', 'request_input']);
});

test('a host tool call needs no transport: send_message is answered in-process, with the call’s control request id', async () => {
  const seen: unknown[] = [];
  const m = { sendMessage: (c: unknown, a: unknown, rid: string) => (seen.push([c, a, rid]), { ok: true, data: { taskId: 't', state: 'submitted' } }) } as unknown as import('./messaging/service.js').Messaging;
  const r = createHostRouter({ reg, home: () => undefined, propose, dispatchEnabled: false, replicaPath: () => missing, sources: noSources, messaging: () => m });
  const host = r.routesFor(caller('owen-ops'), sender).find((x) => x.name === 'host')!;
  const reply = (await host.handle({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'send_message', arguments: { target: 'caldora', text: 'q' } } }, { requestId: 'req-uuid-1' })) as { result: { content: { text: string }[] } };
  assert.deepEqual(JSON.parse(reply.result.content[0]!.text), { taskId: 't', state: 'submitted' });
  assert.deepEqual(seen, [[{ slug: 'owen-ops', conversationKey: 'thread:1' }, { target: 'caldora', text: 'q' }, 'req-uuid-1']]);
});
