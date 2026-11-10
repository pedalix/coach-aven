import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  ATTRIBUTION_SETTINGS,
  checkedIdentity,
  DEFAULT_GIT_IDENTITY,
  GIT_EMAIL,
  GIT_NAME,
  gitIdentityEnv,
  gitIdentityOverride,
  setGitIdentity,
} from './gitidentity.js';

test('gitIdentityEnv exports all four identity vars, shell-safe', () => {
  // Run it through a real shell: the brackets in the name must survive unglobbed.
  const out = execFileSync('bash', [
    '-c',
    `${gitIdentityEnv()} bash -c 'echo "$GIT_AUTHOR_NAME|$GIT_AUTHOR_EMAIL|$GIT_COMMITTER_NAME|$GIT_COMMITTER_EMAIL"'`,
  ]).toString().trim();
  assert.equal(out, `${GIT_NAME}|${GIT_EMAIL}|${GIT_NAME}|${GIT_EMAIL}`);
});

test('attribution credits CoachAven, not Claude', () => {
  const { commit, pr } = ATTRIBUTION_SETTINGS.attribution;
  assert.match(commit, /^Co-Authored-By: CoachAven </);
  assert.doesNotMatch(commit + pr, /anthropic|Claude/i);
});

test('before the lookup the identity is the shared App\'s bot, as it was when it was a constant', () => {
  assert.deepEqual(DEFAULT_GIT_IDENTITY, { login: 'coach-aven[bot]', email: '271933357+coach-aven[bot]@users.noreply.github.com' });
  assert.equal(GIT_NAME, 'coach-aven[bot]');
  assert.equal(GIT_EMAIL, '271933357+coach-aven[bot]@users.noreply.github.com');
});

test('.env names no account → no override; an empty pair is no pair', () => {
  assert.equal(gitIdentityOverride({}), undefined);
  assert.equal(gitIdentityOverride({ GITHUB_BOT_LOGIN: ' ', GITHUB_BOT_USER_ID: '' }), undefined);
});

test('.env names an App\'s bot or a person', () => {
  assert.deepEqual(gitIdentityOverride({ GITHUB_BOT_LOGIN: 'example-helper[bot]', GITHUB_BOT_USER_ID: '123456789' }), {
    login: 'example-helper[bot]',
    email: '123456789+example-helper[bot]@users.noreply.github.com',
  });
  assert.deepEqual(gitIdentityOverride({ GITHUB_BOT_LOGIN: 'robin-example', GITHUB_BOT_USER_ID: '4242' }), {
    login: 'robin-example',
    email: '4242+robin-example@users.noreply.github.com',
  });
});

test('half a pair, a value that is not a login, an id that is not a number: refused', () => {
  assert.throws(() => gitIdentityOverride({ GITHUB_BOT_LOGIN: 'example-helper[bot]' }), /go together/);
  assert.throws(() => gitIdentityOverride({ GITHUB_BOT_USER_ID: '123456789' }), /go together/);
  assert.throws(() => gitIdentityOverride({ GITHUB_BOT_LOGIN: 'example helper', GITHUB_BOT_USER_ID: '1' }), /not a GitHub login/);
  assert.throws(() => checkedIdentity("x'; rm -rf /;[bot]", 1, 'GET /user'), /GET \/user: not a GitHub login/);
  assert.throws(() => checkedIdentity(undefined, 1, 'GET /user'), /not a GitHub login/);
  assert.throws(() => checkedIdentity('example-helper[bot]', '12a', 'GET /user'), /numeric GitHub user id/);
});

test('setGitIdentity moves the name, the e-mail, the env prefix and the attribution together', () => {
  try {
    setGitIdentity({ login: 'example-helper[bot]', email: '123456789+example-helper[bot]@users.noreply.github.com' });
    assert.equal(GIT_NAME, 'example-helper[bot]');
    assert.match(gitIdentityEnv(), /GIT_COMMITTER_EMAIL='123456789\+example-helper\[bot\]@users\.noreply\.github\.com'/);
    assert.equal(ATTRIBUTION_SETTINGS.attribution.commit, 'Co-Authored-By: CoachAven <123456789+example-helper[bot]@users.noreply.github.com>');
  } finally {
    setGitIdentity(DEFAULT_GIT_IDENTITY);
  }
});
