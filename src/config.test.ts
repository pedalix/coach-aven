import { test } from 'node:test';
import assert from 'node:assert/strict';
import { retiredEnvWarnings } from './config.js';

test('retired switches: DISPATCH set to 1 or true warns once at boot, and nothing else reads it (retire-agent-dispatch D4)', () => {
  for (const v of ['1', 'true']) assert.deepEqual(retiredEnvWarnings({ DISPATCH: v }), ['config: DISPATCH is retired — agent messaging replaces it']);
  for (const v of [undefined, '', '0', 'false']) assert.deepEqual(retiredEnvWarnings({ DISPATCH: v }), []);
  assert.deepEqual(retiredEnvWarnings({}), []);
});
