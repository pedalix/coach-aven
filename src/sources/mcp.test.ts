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

test('the spec becomes a stdio entry in the --mcp-config file, carrying the local zone; the script ships with the package', () => {
  const servers = buildMcpServers(withSourcesMcp(undefined, true, 'Europe/Moscow')!) as Record<string, { command: string; args: string[]; env: Record<string, string> }>;
  assert.deepEqual(servers.sources, { command: 'node', args: ['--no-warnings', SOURCES_MCP_PATH], env: { SOURCES_TZ: 'Europe/Moscow' } });
  // default = the bot's AVEN_TZ (the zone routines run in), UTC when unset
  assert.equal(sourcesMcpSpec().env?.SOURCES_TZ, process.env.AVEN_TZ || 'UTC');
  assert.equal(sourcesMcpSpec('Europe/Zurich').env?.SOURCES_TZ, 'Europe/Zurich');
  assert.ok(existsSync(SOURCES_MCP_SOURCE), `missing ${SOURCES_MCP_SOURCE}`);
  assert.match(sourcesMcpSha256(), /^[0-9a-f]{64}$/);
  assert.equal(SOURCES_DB_PATH, '/data/sources/store.sqlite');
  assert.match(SOURCES_PROMPT_PARAGRAPH, /`sources` MCP tools \(search, get, transcript, /);
  assert.match(SOURCES_PROMPT_PARAGRAPH, /never try to reconstruct/);
  // the failure contract: report, finish, never wait for the replica; stale sources are named
  assert.match(SOURCES_PROMPT_PARAGRAPH, /do not sleep, poll or ScheduleWakeup/);
  assert.match(SOURCES_PROMPT_PARAGRAPH, /older than its pull interval \(see `stats\.meta`\)/);
  assert.match(SOURCES_PROMPT_PARAGRAPH, /spawn one Agent with the question \+ ref/);
});
