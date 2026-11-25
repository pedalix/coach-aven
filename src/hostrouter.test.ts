import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createHostRouter, daemonRoute, declares, sourcesRoute, sourcesWorker, type SourcesCall } from './hostrouter.js';
import type { ProjectConfig } from './projects.js';
import type { HostCaller, JsonRpc } from './hosttools.js';

const project = (slug: string, extra: Partial<ProjectConfig> = {}): ProjectConfig => ({ slug, repos: [`Org/${slug}`], ...extra });
const bluefin = project('bluefin-ops', { sources: { youtrack: { url: 'https://yt', projects: ['CG'] } } });
const own = project('owen-ops', { slackChannel: 'C1', sources: { slack: { workspaces: ['T1'] } }, mcp: [{ name: 'sources', url: 'https://daemon/mcp' }] });
const plain = project('plain');
const caller = (slug: string): HostCaller => ({ slug, conversationKey: 'thread:1' });
const missing = join(mkdtempSync(join(tmpdir(), 'hostrouter-')), 'nope.sqlite');
const noSources: SourcesCall = async () => assert.fail('no sources call expected');
const fakeMessaging = { sendMessage: () => ({ ok: true, data: {} }) } as unknown as import('./messaging/service.js').Messaging;

test('routesFor — host for every project (brain_history; messaging adds its tools), sources only for a sources project, and a project\'s own server of either name wins', () => {
  const off = createHostRouter({ replicaPath: () => missing, sources: noSources });
  assert.deepEqual(off.routesFor(caller('plain'), plain).map((r) => r.name), ['host'], 'no messaging, no sources → `host` with brain_history alone');
  assert.deepEqual(off.routesFor(caller('bluefin-ops'), bluefin).map((r) => r.name), ['host', 'sources'], 'sources needs no flag — only the project block');
  assert.deepEqual(off.routesFor(caller('owen-ops'), own).map((r) => r.name), ['host'], 'a declared `sources` server is the project\'s own; the bot registers none');
  const on = createHostRouter({ replicaPath: () => missing, sources: noSources, messaging: () => fakeMessaging });
  const both = project('bluefin-ops', { sources: { youtrack: { url: 'https://yt', projects: ['CG'] } }, messaging: { send: true } });
  assert.deepEqual(on.routesFor(caller('bluefin-ops'), both).map((r) => [r.name, r.timeoutMs]), [['host', 30_000], ['sources', 90_000]]);
  assert.deepEqual(on.routesFor(caller('plain'), project('plain', { mcp: [{ name: 'host', command: 'own' }], messaging: { send: true } })).map((r) => r.name), [], 'a declared `host` wins too');
  assert.equal(declares(own, 'sources'), true);
  assert.equal(declares(bluefin, 'sources'), false);
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
  const router = createHostRouter({ replicaPath: () => missing, sources: local, forward: up });
  const route = router.routesFor(caller('acme'), viaDaemon).find((x) => x.name === 'sources');
  assert.deepEqual(await route!.handle({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'stats', arguments: {} } }), { jsonrpc: '2.0', id: 5, result: { daemon: 'acme' } });
});

// ── agent messaging (OpenSpec agent-messaging, tasks 3.5 / 5.1) ─────────────────────────────────────
const sender = project('owen-ops', { messaging: { send: true } });
const answerOnly = project('caldora', { messaging: { accept: ['owen-ops'] } });
const toolNames = async (r: ReturnType<typeof createHostRouter>, c: HostCaller, p: ProjectConfig): Promise<string[] | undefined> => {
  const host = r.routesFor(c, p).find((x) => x.name === 'host');
  if (!host) return undefined;
  const list = (await host.handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' })) as { result: { tools: { name: string }[] } };
  return list.result.tools.map((t) => t.name);
};
test('a project without messaging: `host` carries brain_history alone — with or without the service', async () => {
  for (const messaging of [undefined, () => fakeMessaging]) {
    const r = createHostRouter({ replicaPath: () => missing, sources: noSources, ...(messaging ? { messaging } : {}) });
    assert.deepEqual(await toolNames(r, caller('plain'), plain), ['brain_history']);
  }
});

test('no messaging tool without the gate: a messaging project without the service started gets brain_history alone', async () => {
  const r = createHostRouter({ replicaPath: () => missing, sources: noSources, messaging: () => undefined });
  assert.deepEqual(await toolNames(r, caller('owen-ops'), sender), ['brain_history']);
});

test('messaging without dispatch: a sending project gets the messaging tools — no propose or registry exists; an answer-only project outside a task gets none', async () => {
  const r = createHostRouter({ replicaPath: () => missing, sources: noSources, messaging: () => fakeMessaging });
  assert.deepEqual(await toolNames(r, caller('owen-ops'), sender), ['send_message', 'get_task', 'cancel_task', 'agents', 'brain_history']);
  assert.deepEqual(await toolNames(r, caller('caldora'), answerOnly), ['brain_history']);
});

test('retired flag: DISPATCH=1 in the environment changes no session\'s tools (retire-agent-dispatch)', async (t) => {
  const prev = process.env.DISPATCH;
  t.after(() => (prev === undefined ? delete process.env.DISPATCH : (process.env.DISPATCH = prev)));
  const names = async () => {
    const r = createHostRouter({ replicaPath: () => missing, sources: noSources, messaging: () => fakeMessaging });
    return [await toolNames(r, caller('owen-ops'), sender), await toolNames(r, caller('plain'), plain), r.routesFor(caller('bluefin-ops'), bluefin).map((x) => x.name)];
  };
  delete process.env.DISPATCH;
  const without = await names();
  process.env.DISPATCH = '1';
  assert.deepEqual(await names(), without);
});

test('shadow conversation: request_input, and the sending tools when the project may send', async () => {
  const on = createHostRouter({ replicaPath: () => missing, sources: noSources, messaging: () => fakeMessaging });
  const shadow: HostCaller = { slug: 'caldora', conversationKey: `a2a:home:${'a'.repeat(24)}:caldora` };
  assert.deepEqual(await toolNames(on, shadow, answerOnly), ['request_input']);
  assert.deepEqual(await toolNames(on, { ...shadow, slug: 'owen-ops' }, sender), ['send_message', 'get_task', 'cancel_task', 'agents', 'request_input']);
});

test('a host tool call needs no transport: send_message is answered in-process, with the call’s control request id', async () => {
  const seen: unknown[] = [];
  const m = { sendMessage: (c: unknown, a: unknown, rid: string) => (seen.push([c, a, rid]), { ok: true, data: { taskId: 't', state: 'submitted' } }) } as unknown as import('./messaging/service.js').Messaging;
  const r = createHostRouter({ replicaPath: () => missing, sources: noSources, messaging: () => m });
  const host = r.routesFor(caller('owen-ops'), sender).find((x) => x.name === 'host')!;
  const reply = (await host.handle({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'send_message', arguments: { target: 'caldora', text: 'q' } } }, { requestId: 'req-uuid-1' })) as { result: { content: { text: string }[] } };
  assert.deepEqual(JSON.parse(reply.result.content[0]!.text), { taskId: 't', state: 'submitted' });
  assert.deepEqual(seen, [[{ slug: 'owen-ops', conversationKey: 'thread:1' }, { target: 'caldora', text: 'q' }, 'req-uuid-1']]);
});

// Company brain: `brain_history` rides the `host` server for every project, messaging or not. The project is the
// caller's — the tool takes no project argument.
test('brain: every project gets brain_history on `host`; a shadow conversation and a project with its own `host` get none', async () => {
  const plain = { slug: 'skishop', repos: ['o/r'] } as unknown as ProjectConfig;
  const caller = { slug: 'skishop', conversationKey: 'thread:1' };
  const names = async (r: ReturnType<typeof createHostRouter>, c = caller, p = plain): Promise<string[]> => {
    const host = r.routesFor(c, p).find((x) => x.name === 'host');
    if (!host) return [];
    const list = (await host.handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' })) as { result: { tools: { name: string }[] } };
    return list.result.tools.map((t) => t.name);
  };
  const later = () => ({ count: 0 });
  const on = createHostRouter({ replicaPath: () => '/nope', sources: async () => undefined, laterTurns: later });
  assert.deepEqual(await names(on), ['brain_history']);
  assert.deepEqual(await names(on, { slug: 'skishop', conversationKey: `a2a:home:${'a'.repeat(24)}:skishop` }), []);
  assert.deepEqual(await names(on, caller, { ...plain, mcp: [{ name: 'host' }] } as unknown as ProjectConfig), []);
});

test('brain_history: the caller\'s own project is answered from its log; the same ticket asked from another project finds nothing', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'aven-brainhist-'));
  const prev = process.env.AVEN_DIR;
  process.env.AVEN_DIR = dir;
  t.after(() => {
    if (prev === undefined) delete process.env.AVEN_DIR;
    else process.env.AVEN_DIR = prev;
    rmSync(dir, { recursive: true, force: true });
  });
  mkdirSync(join(dir, 'brain', 'skishop'), { recursive: true });
  const entry = (at: string, key: string, answer: string) => JSON.stringify({ at, key, turnId: `t-${at}`, question: 'Why twice?', answer, records: ['glacier-12.md'], tickets: ['GLACIER-12'], link: 'https://chat.example/t/1' });
  writeFileSync(join(dir, 'brain', 'skishop', 'answers.jsonl'), `${entry('2026-05-02T08:00:00.000Z', 'thread:1', 'The export joins twice.')}\n${entry('2026-05-09T08:00:00.000Z', 'thread:2', 'Fixed in the March release.')}\n`);
  const r = createHostRouter({ replicaPath: () => '/nope', sources: async () => undefined, laterTurns: (key) => (key === 'thread:2' ? { count: 2, last: '2026-05-10T08:00:00.000Z' } : { count: 0 }) });
  const ask = async (slug: string): Promise<string> => {
    const host = r.routesFor({ slug, conversationKey: 'thread:9' }, { slug, repos: ['o/r'] } as unknown as ProjectConfig).find((x) => x.name === 'host')!;
    const res = (await host.handle({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'brain_history', arguments: { query: 'GLACIER-12' } } })) as { result: { content: { text: string }[] } };
    return res.result.content[0].text;
  };
  const mine = await ask('skishop');
  assert.match(mine, /2 logged answers for "GLACIER-12", oldest first:/);
  assert.match(mine, /── 1\. 2026-05-02 — https:\/\/chat\.example\/t\/1 — no later turn in that conversation/);
  assert.match(mine, /── 2\. 2026-05-09 — https:\/\/chat\.example\/t\/1 — 2 later turns in that conversation \(last 2026-05-10\)/);
  assert.equal(await ask('otherproject'), 'No logged answer for "GLACIER-12" in this project.');
});
