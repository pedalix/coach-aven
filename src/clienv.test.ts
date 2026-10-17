import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isolatedClaudeEnv } from './clienv.js';

test('isolatedClaudeEnv — drops what a parent Claude Code session and the shell set, keeps the rest', () => {
  const base = {
    PATH: '/usr/bin',
    HOME: '/home/owen',
    LANG: 'C.UTF-8',
    CLAUDE_CLI_VERSION: '2.1.282',
    CLAUDECODE: '1',
    CLAUDE_CODE_ENTRYPOINT: 'cli',
    CLAUDE_CODE_SSE_PORT: '41234',
    CLAUDE_CODE_OAUTH_TOKEN: 'parent-token',
    CLAUDE_PID: '4242',
    CLAUDE_EFFORT: 'high',
    CLAUDE_CONFIG_DIR: '/home/owen/.claude',
    AI_AGENT: 'claude-code',
    ANTHROPIC_API_KEY: 'shell-key',
    ANTHROPIC_BASE_URL: 'https://gateway.example',
  };
  const env = isolatedClaudeEnv(base, { configDir: '/tmp/run/config', token: 'probe-token' });
  assert.deepEqual(env, {
    PATH: '/usr/bin',
    HOME: '/home/owen',
    LANG: 'C.UTF-8',
    CLAUDE_CLI_VERSION: '2.1.282',
    CLAUDE_CONFIG_DIR: '/tmp/run/config',
    CLAUDE_CODE_OAUTH_TOKEN: 'probe-token',
  });
  assert.equal(base.CLAUDECODE, '1', 'the caller’s environment is not touched');
});
