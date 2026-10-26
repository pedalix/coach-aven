import { test } from 'node:test';
import assert from 'node:assert/strict';
import { autoStopMinutesEnv, repoSkillsEnv, retiredEnvWarnings } from './config.js';

test('retired switches: DISPATCH set to 1 or true warns once at boot, and nothing else reads it (retire-agent-dispatch D4)', () => {
  for (const v of ['1', 'true']) assert.deepEqual(retiredEnvWarnings({ DISPATCH: v }), ['config: DISPATCH is retired — agent messaging replaces it']);
  for (const v of [undefined, '', '0', 'false']) assert.deepEqual(retiredEnvWarnings({ DISPATCH: v }), []);
  assert.deepEqual(retiredEnvWarnings({}), []);
});

test('REPO_SKILLS — opt-in (agent-skills, bucket 3): exactly 1 turns it on; unset or anything else keeps it off', () => {
  for (const v of ['1', ' 1 ']) assert.equal(repoSkillsEnv(v), true, v);
  for (const v of [undefined, '', '0', 'true', 'on', 'yes', 'false', '2']) assert.equal(repoSkillsEnv(v), false, String(v));
});

test('SANDBOX_AUTOSTOP_MINUTES — trimmed; unset, empty or only spaces is the default 30; 0 is never; not a number fails naming the key (sandbox-idle-stop D9)', () => {
  for (const v of [undefined, '', '   ']) assert.equal(autoStopMinutesEnv(v), 30, JSON.stringify(v));
  assert.equal(autoStopMinutesEnv(' 45 '), 45);
  assert.equal(autoStopMinutesEnv('0'), 0);
  assert.equal(autoStopMinutesEnv('-5'), -5);
  assert.throws(() => autoStopMinutesEnv('thirty'), /SANDBOX_AUTOSTOP_MINUTES must be a number, got: thirty/);
});

test('CHAT_SURFACES — the additional chat surfaces, validated against the drivers this build has (multi-driver-installation)', async () => {
  const { parseSurfaces } = await import('./chat/surfaces.js');
  assert.deepEqual(parseSurfaces(undefined), []);
  assert.deepEqual(parseSurfaces('teams'), ['teams']);
  assert.deepEqual(parseSurfaces('web'), ['web']);
  assert.throws(() => parseSurfaces('irc'), /unknown chat drivers: irc/);
});
