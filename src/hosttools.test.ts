import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mcpServer, MCP_PROTOCOL_VERSION } from './hosttools.js';

test('mcpServer — the MCP subset an in-process server needs: initialize, ping, tools/list, tools/call; notifications and responses are not answered', async () => {
  const calls: unknown[] = [];
  const server = mcpServer('host', [
    { name: 'echo', description: 'echo', inputSchema: { type: 'object' }, call: (a) => { calls.push(a); return { text: `echo:${String(a.text ?? '')}` }; } },
    { name: 'bad', description: 'bad', inputSchema: { type: 'object' }, call: () => ({ text: 'nope', isError: true }) },
    { name: 'boom', description: 'boom', inputSchema: { type: 'object' }, call: () => { throw new Error('kaboom'); } },
  ], '9.9.9');
  assert.deepEqual(await server({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-03-26' } }), { jsonrpc: '2.0', id: 0, result: { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'host', version: '9.9.9' } } }, 'the client\'s revision is echoed');
  assert.equal(((await server({ jsonrpc: '2.0', id: 1, method: 'initialize' })) as { result: { protocolVersion: string } }).result.protocolVersion, MCP_PROTOCOL_VERSION);
  assert.equal(await server({ jsonrpc: '2.0', method: 'notifications/initialized' }), undefined, 'a notification has no reply');
  assert.equal(await server({ jsonrpc: '2.0', id: 5, result: {} }), undefined, 'a response is not a request');
  assert.deepEqual(await server({ jsonrpc: '2.0', id: 2, method: 'ping' }), { jsonrpc: '2.0', id: 2, result: {} });
  const list = (await server({ jsonrpc: '2.0', id: 3, method: 'tools/list' })) as { result: { tools: Record<string, unknown>[] } };
  assert.deepEqual(list.result.tools.map((t) => t.name), ['echo', 'bad', 'boom']);
  assert.equal('call' in list.result.tools[0]!, false, 'the listing carries no functions');
  assert.deepEqual(await server({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'echo', arguments: { text: 'x' } } }), { jsonrpc: '2.0', id: 4, result: { content: [{ type: 'text', text: 'echo:x' }], isError: false } });
  assert.deepEqual(calls, [{ text: 'x' }]);
  assert.deepEqual(await server({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'echo', arguments: 'junk' } }), { jsonrpc: '2.0', id: 6, result: { content: [{ type: 'text', text: 'echo:' }], isError: false } }, 'non-object arguments → empty');
  assert.equal(((await server({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'bad' } })) as { result: { isError: boolean } }).result.isError, true);
  assert.deepEqual(await server({ jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'boom' } }), { jsonrpc: '2.0', id: 8, result: { content: [{ type: 'text', text: 'boom failed: kaboom' }], isError: true } }, 'a throw is a tool error the agent reads, not a JSON-RPC error');
  assert.deepEqual(await server({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'nope' } }), { jsonrpc: '2.0', id: 9, error: { code: -32602, message: 'unknown tool "nope"' } });
  assert.deepEqual(await server({ jsonrpc: '2.0', id: 10, method: 'resources/list' }), { jsonrpc: '2.0', id: 10, error: { code: -32601, message: 'method not found: resources/list' } });
});
