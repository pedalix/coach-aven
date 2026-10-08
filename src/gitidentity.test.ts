import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { ATTRIBUTION_SETTINGS, GIT_EMAIL, GIT_NAME, gitIdentityEnv } from './gitidentity.js';

test('gitIdentityEnv exports all four identity vars, shell-safe', () => {
  // Run it through a real shell: the brackets in the name must survive unglobbed.
  const out = execFileSync('bash', [
    '-c',
    `${gitIdentityEnv()} bash -c 'echo "$GIT_AUTHOR_NAME|$GIT_AUTHOR_EMAIL|$GIT_COMMITTER_NAME|$GIT_COMMITTER_EMAIL"'`,
  ]).toString().trim();
  assert.equal(out, `${GIT_NAME}|${GIT_EMAIL}|${GIT_NAME}|${GIT_EMAIL}`);
});

test('attribution credits Coach Aven, not Claude', () => {
  const { commit, pr } = ATTRIBUTION_SETTINGS.attribution;
  assert.match(commit, /^Co-Authored-By: Coach Aven </);
  assert.doesNotMatch(commit + pr, /anthropic|Claude/i);
});
