import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMcpServers, GATEWAY_DIR, GATEWAY_HELPER_PATH, GATEWAY_HELPER_SCRIPT, gatewayTokenPath } from './mcp.js';

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

test('buildMcpServers: a gateway-m2m entry gets the headersHelper, static headers kept', () => {
  const servers = buildMcpServers(
    [{ name: 'gw', url: 'https://engine.example.com/gw/caldora/mcp', auth: 'gateway-m2m' }],
    {},
  );
  assert.deepEqual(servers.gw, {
    type: 'http',
    url: 'https://engine.example.com/gw/caldora/mcp',
    headers: {},
    headersHelper: GATEWAY_HELPER_PATH,
  });
});

test('GATEWAY_HELPER_SCRIPT prints the bearer from the per-server token file and the session id', async () => {
  const { execFileSync } = await import('node:child_process');
  const { mkdtempSync, writeFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const dir = mkdtempSync(join(tmpdir(), 'gwh-'));
  // Same script, pointed at a temp dir instead of /root/.aven.
  const script = GATEWAY_HELPER_SCRIPT.replaceAll(GATEWAY_DIR, dir);
  writeFileSync(join(dir, 'gw-token-gw'), 'eyJ.tok.sig');
  const out = execFileSync('sh', ['-c', script], {
    env: { PATH: process.env.PATH ?? '', CLAUDE_CODE_MCP_SERVER_NAME: 'gw', AVEN_SESSION: 'C1:2.3' },
  }).toString();
  assert.deepEqual(JSON.parse(out), { Authorization: 'Bearer eyJ.tok.sig', 'x-aven-session': 'C1:2.3' });
  assert.equal(gatewayTokenPath('gw'), `${GATEWAY_DIR}/gw-token-gw`);
});
