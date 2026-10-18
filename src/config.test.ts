import { test } from 'node:test';
import assert from 'node:assert/strict';
import { repoSkillsEnv, retiredEnvWarnings } from './config.js';

test('retired switches: DISPATCH set to 1 or true warns once at boot, and nothing else reads it (retire-agent-dispatch D4)', () => {
  for (const v of ['1', 'true']) assert.deepEqual(retiredEnvWarnings({ DISPATCH: v }), ['config: DISPATCH is retired — agent messaging replaces it']);
  for (const v of [undefined, '', '0', 'false']) assert.deepEqual(retiredEnvWarnings({ DISPATCH: v }), []);
  assert.deepEqual(retiredEnvWarnings({}), []);
});

test('REPO_SKILLS — opt-in (agent-skills, bucket 3): exactly 1 turns it on; unset or anything else keeps it off', () => {
  for (const v of ['1', ' 1 ']) assert.equal(repoSkillsEnv(v), true, v);
  for (const v of [undefined, '', '0', 'true', 'on', 'yes', 'false', '2']) assert.equal(repoSkillsEnv(v), false, String(v));
});
