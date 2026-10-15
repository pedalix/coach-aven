import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CHAT_DRIVERS, unknownCommandText } from './drivers.js';

test('the build ships the Slack driver', () => {
  assert.deepEqual([...CHAT_DRIVERS], ['slack']);
});

test('an unknown run mode names the drivers that exist', () => {
  const t = unknownCommandText('teams');
  assert.match(t, /unknown command 'teams'/);
  assert.match(t, /slack \(`orch slack`\)/);
});
