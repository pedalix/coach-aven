import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stepLabel } from './steps.js';

test('stepLabel — core tools render with their icon and key argument', () => {
  assert.equal(stepLabel('Read', { file_path: '/a/b.php' }), '📖 Read /a/b.php');
  assert.equal(stepLabel('Grep', { pattern: 'voucher' }), '🔍 Grep voucher');
  assert.equal(stepLabel('Bash', { command: 'npm test' }), '⚙️ npm test');
  assert.equal(stepLabel('WebSearch', { query: 'x' }), '🌐 Search x');
});

test('stepLabel — Task and Agent both label as Subtask, numbered when seq given', () => {
  assert.equal(stepLabel('Task', { description: 'find code' }), '🤖 Subtask: find code');
  assert.equal(stepLabel('Agent', { description: 'find code' }), '🤖 Subtask: find code');
  assert.equal(stepLabel('Agent', { prompt: 'dig' }, 2), '🤖 Subtask 2: dig');
});

test('stepLabel — MCP tools render as "server: tool <key arg>"', () => {
  assert.equal(
    stepLabel('mcp__youtrack__search_issues', { query: 'project: CB Voucher' }),
    '🔌 youtrack: search_issues project: CB Voucher',
  );
  assert.equal(stepLabel('mcp__youtrack__get_issue', { id: 'CB-53' }), '🔌 youtrack: get_issue CB-53');
  // no string args → bare server: tool
  assert.equal(stepLabel('mcp__grafana__list_datasources', {}), '🔌 grafana: list_datasources');
});

test('stepLabel — unknown non-MCP tool falls back to a wrench', () => {
  assert.equal(stepLabel('ToolSearch', { query: 'yt' }), '🔧 ToolSearch');
});

test('stepLabel — long arguments are truncated', () => {
  const label = stepLabel('mcp__youtrack__search_issues', { query: 'q'.repeat(100) });
  assert.equal(label.length < 80, true);
  assert.equal(label.endsWith('…'), true);
});
