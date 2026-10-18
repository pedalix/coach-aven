import { test } from 'node:test';
import assert from 'node:assert/strict';
import { repoSkillsEnv, retiredEnvWarnings } from './config.js';

test('retired switches: DISPATCH set to 1 or true warns once at boot, and nothing else reads it (retire-agent-dispatch D4)', () => {
  for (const v of ['1', 'true']) assert.deepEqual(retiredEnvWarnings({ DISPATCH: v }), ['config: DISPATCH is retired — agent messaging replaces it']);
  for (const v of [undefined, '', '0', 'false']) assert.deepEqual(retiredEnvWarnings({ DISPATCH: v }), []);
  assert.deepEqual(retiredEnvWarnings({}), []);
});

test('REPO_SKILLS — on unless it says 0/false/off/no (agent-skills: a kill switch, not an opt-in)', () => {
  for (const v of [undefined, '', '1', 'true', 'on', 'yes']) assert.equal(repoSkillsEnv(v), true, String(v));
  for (const v of ['0', 'false', 'FALSE', 'off', 'no', ' 0 ']) assert.equal(repoSkillsEnv(v), false, v);
});
