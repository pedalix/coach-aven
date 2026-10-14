import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tokenKind } from './auth.js';

test('tokenKind — a bot token answers auth.test with bot_id, a user token does not', () => {
  assert.equal(tokenKind({ bot_id: 'B0ABC' }), 'bot');
  assert.equal(tokenKind({}), 'user');
  assert.equal(tokenKind({ bot_id: '' }), 'user');
});
