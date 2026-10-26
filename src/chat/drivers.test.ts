import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CHAT_DRIVERS, unknownCommandText } from './drivers.js';

test('the build ships the Slack, Teams and web drivers', () => {
  assert.deepEqual([...CHAT_DRIVERS], ['slack', 'teams', 'web']);
});

test('an unknown run mode names the drivers that exist', () => {
  const t = unknownCommandText('irc');
  assert.match(t, /unknown command 'irc'/);
  assert.match(t, /slack \(`orch slack`\), teams \(`orch teams`\), web \(`orch web`\)/);
});
