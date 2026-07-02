import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMcpServers } from './mcp.js';

test('stdio spec → command/args/env with ${ENV} refs resolved', () => {
  const servers = buildMcpServers(
    [
      {
        name: 'grafana',
        command: 'docker',
        args: ['run', '-i', '--rm', 'grafana/mcp-grafana', '-t', 'stdio'],
        env: { GRAFANA_URL: 'https://observe.example.com', TOKEN: '${MY_TOKEN}' },
      },
    ],
    { MY_TOKEN: 'sekret' },
  );
  assert.deepEqual(servers, {
    grafana: {
      command: 'docker',
      args: ['run', '-i', '--rm', 'grafana/mcp-grafana', '-t', 'stdio'],
      env: { GRAFANA_URL: 'https://observe.example.com', TOKEN: 'sekret' },
    },
  });
});

test('url spec → http server with header env refs resolved', () => {
  const servers = buildMcpServers(
    [
      {
        name: 'grafana',
        url: 'https://observe.example.com/mcp',
        headers: { Authorization: 'Basic ${MCP_AUTH}' },
      },
    ],
    { MCP_AUTH: 'dXNlcjpwYXNz' },
  );
  assert.deepEqual(servers, {
    grafana: {
      type: 'http',
      url: 'https://observe.example.com/mcp',
      headers: { Authorization: 'Basic dXNlcjpwYXNz' },
    },
  });
});

test('unknown ${ENV} ref resolves to empty string, not the literal', () => {
  const servers = buildMcpServers([{ name: 's', url: 'https://x/mcp', headers: { A: '${NOPE}' } }], {});
  assert.deepEqual(servers, { s: { type: 'http', url: 'https://x/mcp', headers: { A: '' } } });
});

test('args and env/headers default to empty', () => {
  const servers = buildMcpServers([{ name: 'a', command: 'foo' }, { name: 'b', url: 'https://x/mcp' }], {});
  assert.deepEqual(servers, {
    a: { command: 'foo', args: [], env: {} },
    b: { type: 'http', url: 'https://x/mcp', headers: {} },
  });
});
