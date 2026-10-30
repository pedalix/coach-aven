import { test } from 'node:test';
import assert from 'node:assert/strict';
import { creditBootLine, creditFromApiKeySource } from './credit.js';

test('creditBootLine — the kind and where it came from, for each source; never the value (api-key-credit D3)', () => {
  const value = 'sk-ant-api03-test';
  assert.equal(creditBootLine({ kind: 'api-key', source: 'ANTHROPIC_API_KEY' }), 'credit: sandboxes run Claude Code on an Anthropic API key (from ANTHROPIC_API_KEY)');
  assert.equal(creditBootLine({ kind: 'subscription', source: 'CLAUDE_CODE_OAUTH_TOKEN' }), 'credit: sandboxes run Claude Code on a Claude subscription token (from CLAUDE_CODE_OAUTH_TOKEN)');
  assert.equal(creditBootLine({ kind: 'subscription', source: '~/.claude' }), "credit: sandboxes run Claude Code on a Claude subscription token (from this machine's ~/.claude login)");
  // Handed the whole credit (as cli.ts does), the line is the same: the value never reaches it.
  assert.ok(!creditBootLine({ kind: 'api-key', source: 'ANTHROPIC_API_KEY', value } as never).includes(value));
});

test('creditFromApiKeySource — ANTHROPIC_API_KEY is a key, none is our token, anything else is not a credit we configure', () => {
  assert.equal(creditFromApiKeySource('ANTHROPIC_API_KEY'), 'api-key');
  assert.equal(creditFromApiKeySource('none'), 'subscription');
  for (const v of [undefined, null, '', 'apiKeyHelper', '/login managed key', 42]) assert.equal(creditFromApiKeySource(v), undefined, String(v));
});
