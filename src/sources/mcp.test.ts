import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SOURCES_PROMPT_PARAGRAPH, SOURCES_SERVER_NAME, channelSourcesEnabled, sourcesTimezone } from './mcp.js';

test('channelSourcesEnabled — a sources project is served over the channel unless it declares its own `sources` url', () => {
  assert.equal(channelSourcesEnabled(false, undefined), false, 'no sources block → nothing');
  assert.equal(channelSourcesEnabled(false, [{ name: 'sources', url: 'https://d/mcp' }]), false);
  assert.equal(channelSourcesEnabled(true, undefined), true);
  assert.equal(channelSourcesEnabled(true, [{ name: 'grafana', url: 'https://observe/mcp' }]), true, 'other remote servers do not matter');
  assert.equal(channelSourcesEnabled(true, [{ name: SOURCES_SERVER_NAME, url: 'https://gw/bluefin-ops/mcp', auth: 'gateway-m2m' }]), false, 'a url entry is the override');
  assert.equal(channelSourcesEnabled(true, [{ name: SOURCES_SERVER_NAME, command: 'node', args: ['/x.mjs'] }]), true, 'a stdio entry of the same name does not claim the channel');
});

test('the prompt paragraph names the tools and the contract; the zone is the bot\'s AVEN_TZ', () => {
  // default = the bot's AVEN_TZ (the zone routines run in), UTC when unset
  assert.equal(sourcesTimezone(), process.env.AVEN_TZ || 'UTC');
  assert.match(SOURCES_PROMPT_PARAGRAPH, /`sources` MCP tools \(search, get, transcript, /);
  assert.match(SOURCES_PROMPT_PARAGRAPH, /served by the orchestrator/);
  assert.doesNotMatch(SOURCES_PROMPT_PARAGRAPH, /\/data\/sources/, 'no sandbox path: there is no mount');
  assert.match(SOURCES_PROMPT_PARAGRAPH, /never try to reconstruct/);
  // the failure contract: report, finish, never wait for the replica; stale sources are named
  assert.match(SOURCES_PROMPT_PARAGRAPH, /do not sleep, poll or ScheduleWakeup/);
  assert.match(SOURCES_PROMPT_PARAGRAPH, /older than its pull interval \(see `stats\.meta`\)/);
  assert.match(SOURCES_PROMPT_PARAGRAPH, /spawn one Agent with the question \+ ref/);
});
