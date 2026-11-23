// The agents' MCP endpoint for people (OpenSpec `agent-mcp-endpoint`), over a real loopback socket: the
// real listener, tool table and service; a scripted engine stands in for the answering turn.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AddressInfo } from 'node:net';
import { Store } from '../state.js';
import { shadowDriver } from '../chat/shadow/driver.js';
import type { ProjectConfig, RegistryRef } from '../projects.js';
import { LocalTransport } from './local.js';
import { memoryStore } from './transport.js';
import { createMessaging, type MessagingEngine } from './service.js';
import { GROUPS_HEADER, handleEndpoint, personOf, startEndpoint, USER_HEADER } from './endpoint.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
const TOKEN = 'gateway-bearer';
const quiet = { info: () => {}, warn: () => {}, error: () => {} };

async function stand(answer: (question: string) => Promise<string> | string) {
  const dir = mkdtempSync(join(tmpdir(), 'aven-endpoint-'));
  const store = new Store(join(dir, 'state.json'));
  const projects = [
    { slug: 'caldora', repos: ['Org/caldora'], messaging: { accept: ['group:support'], description: 'Orders and payments of caldora' } },
    { slug: 'bluefin-ops', repos: ['Org/ops'], messaging: { accept: ['*'] } },
  ] as unknown as ProjectConfig[];
  const turns: string[] = [];
  const engine = {
    async liveTurn(_d: Any, _c: Any, _m: Any, _t: Any, _key: string, _p: Any, question: string, _a: Any, opts: Any) {
      turns.push(question);
      opts?.onAccepted?.();
      opts?.onStart?.();
      await opts?.onAnswer?.(await answer(question), undefined);
      await opts?.onSettle?.('ok');
    },
    turnOn: () => undefined,
    noteInjection: () => {},
    liveSession: () => undefined,
    sessionFor: async () => ({}),
    isAsk: () => false,
    cancelKey: () => {},
    closeSession: async () => {},
    retireSession: async () => {},
    hasKey: () => false,
  } as unknown as MessagingEngine;
  const local = new LocalTransport(memoryStore(), { installation: 'bluefin' });
  const svc = createMessaging({ installation: 'bluefin', store, reg: { current: { projects } } as unknown as RegistryRef, home: () => undefined, peers: () => ({}), engine, local, shadow: shadowDriver({ dir: join(dir, 'shadow') }), platform: 'slack', driverFor: () => undefined });
  const server = await startEndpoint({ listen: '127.0.0.1:0', token: TOKEN }, { messaging: () => svc }, quiet);
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
  let id = 0;
  const post = (body: unknown, headers: Record<string, string> = {}) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const as = (email: string, groups = 'support') => ({ authorization: `Bearer ${TOKEN}`, [USER_HEADER]: email, [GROUPS_HEADER]: groups });
  const call = async (who: Record<string, string>, name: string, args: Record<string, unknown> = {}) => {
    const r = (await (await post({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name, arguments: args } }, who)).json()) as Any;
    return { isError: r.result.isError as boolean, data: JSON.parse(r.result.content[0].text) as Any };
  };
  return { server, svc, store, turns, post, as, call, url };
}

test('only the gateway may call: no bearer or a wrong one is 401 with no body, and nothing starts', async () => {
  const s = await stand(() => 'x');
  try {
    for (const h of [{}, { authorization: 'Bearer nope' }, { [USER_HEADER]: 'nora@bluefin.example', [GROUPS_HEADER]: 'support' }]) {
      const r = await s.post({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'send_message', arguments: { target: 'caldora', text: 'q' } } }, h as Record<string, string>);
      assert.equal(r.status, 401);
      assert.equal(await r.text(), '');
    }
    assert.equal((await fetch(s.url, { headers: { authorization: `Bearer ${TOKEN}` } })).status, 405, 'no event stream');
    assert.equal(s.store.messagingTasks().in.length, 0);
    assert.equal(s.turns.length, 0);
  } finally {
    s.server.close();
  }
});

test('the handshake and the tool table: four tools, the same names as the agents’ own', async () => {
  const s = await stand(() => 'x');
  try {
    const who = s.as('nora@bluefin.example');
    const init = (await (await s.post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'a-client', version: '1' } } }, who)).json()) as Any;
    assert.equal(init.result.serverInfo.name, 'coach-aven-agents');
    assert.deepEqual(init.result.capabilities, { tools: {} });
    assert.equal((await s.post({ jsonrpc: '2.0', method: 'notifications/initialized' }, who)).status, 202);
    const list = (await (await s.post({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, who)).json()) as Any;
    assert.deepEqual(list.result.tools.map((t: Any) => t.name), ['agents', 'send_message', 'get_task', 'cancel_task']);
    assert.ok(list.result.tools[1].inputSchema.properties.waitSeconds && list.result.tools[2].inputSchema.properties.waitSeconds);
  } finally {
    s.server.close();
  }
});

test('a full round: the person lists the agents that accept them, asks with waitSeconds and reads the answer; nobody else reads the task', async () => {
  const s = await stand(async () => {
    await new Promise((r) => setTimeout(r, 30));
    return '12 orders failed yesterday.';
  });
  try {
    const nora = s.as('Nora@Bluefin.example', 'Support, finance');
    const agents = await s.call(nora, 'agents');
    assert.deepEqual(agents.data.agents.map((a: Any) => a.name), ['bluefin/caldora'], 'the project that accepts only `*` is not shown to a person');
    const sent = await s.call(nora, 'send_message', { target: 'caldora', text: 'How many orders failed yesterday?', waitSeconds: 20 });
    assert.equal(sent.isError, false);
    assert.equal(sent.data.state, 'completed', 'the call was held until the answer');
    assert.equal(sent.data.last.text, '12 orders failed yesterday.');
    assert.match(s.turns[0]!, /^\[Request from a person\]\nFrom: nora@bluefin\.example, /);
    const again = await s.call(nora, 'get_task', { taskId: sent.data.taskId });
    assert.equal(again.data.last.text, '12 orders failed yesterday.');
    const other = await s.call(s.as('owen@bluefin.example'), 'get_task', { taskId: sent.data.taskId });
    assert.equal(other.isError, true);
    assert.match(other.data.error, /no task .* of yours here/);
    const outsider = await s.call(s.as('guest@elsewhere.example', 'sales'), 'send_message', { target: 'caldora', text: 'q' });
    assert.match(outsider.data.error, /no agent "caldora" here accepts tasks from you; agents that do: none/);
  } finally {
    s.server.close();
  }
});

test('the person is the one in the headers: an input naming someone else is ignored, and no identity is a tool error that creates nothing', async () => {
  const s = await stand(() => 'ok');
  try {
    const sent = await s.call(s.as('nora@bluefin.example'), 'send_message', { target: 'caldora', text: 'q', user: 'owen@bluefin.example', email: 'owen@bluefin.example', from: 'user:owen@bluefin.example', waitSeconds: 5 });
    assert.equal(s.store.messagingTasks().in[0]!.from, 'user:nora@bluefin.example');
    assert.equal(sent.data.state, 'completed');
    const none = await s.call({ authorization: `Bearer ${TOKEN}` }, 'send_message', { target: 'caldora', text: 'q' });
    assert.equal(none.isError, true);
    assert.match(none.data.error, /gateway sent no identity/);
    assert.equal(s.store.messagingTasks().in.length, 1);
    assert.deepEqual(personOf({ [USER_HEADER]: ' nora@bluefin.example ', [GROUPS_HEADER]: 'a, b,,c ' }), { email: 'nora@bluefin.example', groups: ['a', 'b', 'c'] });
  } finally {
    s.server.close();
  }
});

test('before the service has started the endpoint answers 503; other paths are 404; the docs name the headers the code trusts', async () => {
  const auth = { authorization: `Bearer ${TOKEN}` };
  assert.equal((await handleEndpoint('POST', '/mcp', auth, '{}', { token: TOKEN, messaging: () => undefined })).status, 503);
  assert.equal((await handleEndpoint('POST', '/other', auth, '{}', { token: TOKEN, messaging: () => undefined })).status, 404);
  assert.equal((await handleEndpoint('POST', '/mcp', auth, '{}', { token: '', messaging: () => undefined })).status, 401, 'an empty token refuses everyone');
  const doc = readFileSync(new URL('../../docs/runtime-config.md', import.meta.url), 'utf8').toLowerCase();
  for (const h of [USER_HEADER, GROUPS_HEADER]) assert.ok(doc.includes(h), `docs/runtime-config.md names ${h}`);
});

test('a bind beyond loopback is said out loud; a loopback one is not', async () => {
  const lines: string[] = [];
  const log = { info: () => {}, warn: (l: string) => void lines.push(l), error: () => {} };
  const wide = await startEndpoint({ listen: '0.0.0.0:0', token: TOKEN }, { messaging: () => undefined }, log);
  wide.close();
  assert.equal(lines.length, 1);
  assert.match(lines[0]!, /bound to 0\.0\.0\.0, not loopback/);
  const local = await startEndpoint({ listen: '0', token: TOKEN }, { messaging: () => undefined }, log);
  local.close();
  assert.equal(lines.length, 1);
});
