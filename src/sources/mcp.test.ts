import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import {
  SOURCES_DB_PATH,
  SOURCES_MCP_PATH,
  SOURCES_MCP_SOURCE,
  SOURCES_PROMPT_PARAGRAPH,
  sourcesMcpSha256,
  sourcesMcpSpec,
  withSourcesMcp,
} from './mcp.js';
import { buildMcpServers } from '../mcp.js';

test('withSourcesMcp adds the server only for projects with sources, and never twice', () => {
  const grafana = { name: 'grafana', url: 'https://observe/mcp' };
  assert.equal(withSourcesMcp(undefined, false), undefined);
  assert.deepEqual(withSourcesMcp([grafana], false), [grafana]);
  const merged = withSourcesMcp([grafana], true)!;
  assert.deepEqual(merged.map((s) => s.name), ['grafana', 'sources']);
  assert.deepEqual(withSourcesMcp(undefined, true), [sourcesMcpSpec()]);
  // an operator-declared `sources` server wins over the built-in one
  const custom = { name: 'sources', command: 'node', args: ['/x/other.mjs'] };
  assert.deepEqual(withSourcesMcp([custom], true), [custom]);
});

test('the spec becomes a stdio entry in the --mcp-config file and the script ships with the package', () => {
  const servers = buildMcpServers(withSourcesMcp(undefined, true)!) as Record<string, { command: string; args: string[] }>;
  assert.deepEqual(servers.sources, { command: 'node', args: ['--no-warnings', SOURCES_MCP_PATH], env: {} });
  assert.ok(existsSync(SOURCES_MCP_SOURCE), `missing ${SOURCES_MCP_SOURCE}`);
  assert.match(sourcesMcpSha256(), /^[0-9a-f]{64}$/);
  assert.equal(SOURCES_DB_PATH, '/data/sources/store.sqlite');
  assert.match(SOURCES_PROMPT_PARAGRAPH, /`sources` MCP tools/);
  assert.match(SOURCES_PROMPT_PARAGRAPH, /never try to reconstruct/);
});
