import { test } from 'node:test';
import assert from 'node:assert/strict';
import { composerAuthCopyScript, composerAuthJson, resolveComposerAuth, validateComposerAuth } from './composerauth.js';

const env = { REGISTRY_TOKEN: 'reg-secret', REGISTRY_USER: 'token' };

test('validate: a well-formed entry passes and keeps its refs unresolved', () => {
  const v = validateComposerAuth({ 'repo.registry.example': { username: 'token', password: '${REGISTRY_TOKEN}' } }, 'project "atlas" composerAuth', env);
  assert.deepEqual(v, { 'repo.registry.example': { username: 'token', password: '${REGISTRY_TOKEN}' } });
});

test('validate: an unknown ref fails, naming the variable and never a value', () => {
  assert.throws(
    () => validateComposerAuth({ 'repo.registry.example': { username: 'token', password: '${MISSING}' } }, 'project "atlas" composerAuth', env),
    (e: Error) => /atlas/.test(e.message) && /MISSING/.test(e.message) && !/reg-secret/.test(e.message),
  );
});

test('validate: shape errors', () => {
  assert.throws(() => validateComposerAuth([], 'x', env), /object/);
  assert.throws(() => validateComposerAuth({ 'not a host': { username: 'a', password: 'b' } }, 'x', env), /host/);
  assert.throws(() => validateComposerAuth({ 'h.example': { username: 'a' } }, 'x', env), /username.*password/);
  assert.throws(() => validateComposerAuth({ 'h.example': { username: 'a', password: 'b', extra: 1 } }, 'x', env), /nothing else/);
});

test('resolve: refs are replaced from the environment', () => {
  const r = resolveComposerAuth({ 'repo.registry.example': { username: '${REGISTRY_USER}', password: '${REGISTRY_TOKEN}' } }, env);
  assert.deepEqual(r, { 'repo.registry.example': { username: 'token', password: 'reg-secret' } });
});

test('auth.json: GitHub, Bitbucket, then the project registries, in http-basic', () => {
  const json = JSON.parse(
    composerAuthJson({
      githubToken: 'ghs_x',
      bitbucket: { username: 'someone@example.com', token: 'bb' },
      extra: { 'repo.registry.example': { username: 'token', password: 'reg' } },
    }),
  );
  assert.deepEqual(Object.keys(json['http-basic']), ['github.com', 'bitbucket.org', 'repo.registry.example']);
  assert.deepEqual(json['http-basic']['github.com'], { username: 'x-access-token', password: 'ghs_x' });
  assert.deepEqual(json['http-basic']['bitbucket.org'], { username: 'someone@example.com', password: 'bb' });
});

test('auth.json: without a GitHub token there is no github.com entry', () => {
  const json = JSON.parse(composerAuthJson({ bitbucket: { username: 'x-token-auth', token: 'bb' } }));
  assert.deepEqual(Object.keys(json['http-basic']), ['bitbucket.org']);
});

test('copy script: per checkout, the same steps as the GitHub-only script, a cp for the printf', () => {
  const s = composerAuthCopyScript('/root/.composer-auth.json', ['/w/atlas/booking-api']);
  assert.match(s, /^if \[ -f \/w\/atlas\/booking-api\/composer\.json \]; then cp \/root\/\.composer-auth\.json \/w\/atlas\/booking-api\/auth\.json && chmod 600/);
  assert.match(s, /\.git\/info\/exclude/);
  assert.match(s, /-wt\/\*\//);
  assert.match(s, /else rm -f \/w\/atlas\/booking-api\/auth\.json; fi; true$/);
});
