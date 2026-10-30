// The WEB_* block (web-chat-driver 2.1): absent, partial, full, the loopback-only rule of WEB_AUTH=none, the local link mode.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { webConfigFrom, webSessionSecretFile } from '../../config.js';

const FULL = {
  WEB_OIDC_ISSUER: 'https://cognito-idp.eu-central-1.amazonaws.com/eu-central-1_abc',
  WEB_OIDC_CLIENT_ID: 'client1',
  WEB_OIDC_CLIENT_SECRET: 'shh',
  WEB_BASE_URL: 'https://chat.example/',
  WEB_SESSION_SECRET: 's'.repeat(32),
};

test('no WEB_* setting → no web block; an empty value counts as unset', () => {
  assert.equal(webConfigFrom({}), undefined);
  assert.equal(webConfigFrom({ WEB_PORT: '', SLACK_APP_TOKEN: 'x' }), undefined);
});

test('a partial block fails naming every missing setting', () => {
  assert.throws(() => webConfigFrom({ WEB_PORT: '8787' }), /missing WEB_OIDC_ISSUER, WEB_OIDC_CLIENT_ID, WEB_OIDC_CLIENT_SECRET, WEB_BASE_URL, WEB_SESSION_SECRET/);
  assert.throws(() => webConfigFrom({ ...FULL, WEB_SESSION_SECRET: undefined }), /missing WEB_SESSION_SECRET/);
  assert.throws(() => webConfigFrom({ ...FULL, WEB_SESSION_SECRET: 'short' }), /at least 32 characters/);
  assert.throws(() => webConfigFrom({ ...FULL, WEB_OIDC_ISSUER: 'http://idp.example' }), /must be an https URL/);
  assert.throws(() => webConfigFrom({ ...FULL, WEB_AUTH: 'basic' }), /WEB_AUTH must be/);
  assert.throws(() => webConfigFrom({ ...FULL, WEB_PORT: 'eighty' }), /WEB_PORT must be a number/);
});

test('the full OIDC block: defaults filled, lists split, trailing slashes dropped, the org from the issuer', () => {
  const c = webConfigFrom({ ...FULL, WEB_OPERATORS: ' ann@corp.example, sub-1 ', WEB_ALLOW: 'group:staff,bo@corp.example', WEB_ORG: 'corp' })!;
  assert.deepEqual(c, {
    port: 8787,
    bind: '127.0.0.1',
    baseUrl: 'https://chat.example',
    auth: 'oidc',
    oidc: { issuer: FULL.WEB_OIDC_ISSUER, clientId: 'client1', clientSecret: 'shh', groupsClaim: 'cognito:groups' },
    org: 'corp',
    operators: ['ann@corp.example', 'sub-1'],
    allow: ['group:staff', 'bo@corp.example'],
    sessionSecret: FULL.WEB_SESSION_SECRET,
    maxFileMb: 20,
  });
  assert.equal(webConfigFrom(FULL)!.org, 'cognito-idp.eu-central-1.amazonaws.com');
  assert.equal(webConfigFrom({ ...FULL, WEB_OIDC_GROUPS_CLAIM: 'groups', WEB_PORT: '9000', WEB_MAX_FILE_MB: '5' })!.oidc!.groupsClaim, 'groups');
});

test('WEB_AUTH=none: only a loopback listener with a localhost base URL, a fixed org, a session secret generated when absent', () => {
  const c = webConfigFrom({ WEB_AUTH: 'none' })!;
  assert.equal(c.auth, 'none');
  assert.equal(c.baseUrl, 'http://127.0.0.1:8787');
  assert.equal(c.org, 'local');
  assert.equal(c.oidc, undefined);
  assert.equal(c.sessionSecret.length, 64);
  assert.equal(webConfigFrom({ WEB_AUTH: 'none', WEB_BASE_URL: 'http://localhost:8787/' })!.baseUrl, 'http://localhost:8787');
  assert.throws(() => webConfigFrom({ WEB_AUTH: 'none', WEB_BIND: '0.0.0.0' }), /needs a loopback listener/);
  assert.throws(() => webConfigFrom({ WEB_AUTH: 'none', WEB_BASE_URL: 'https://chat.example' }), /needs a localhost WEB_BASE_URL/);
});

test('WEB_AUTH=link: any listener, a localhost base URL only, the secret left to the installation directory when unset', () => {
  const c = webConfigFrom({ WEB_AUTH: 'link', WEB_BIND: '0.0.0.0' })!;
  assert.equal(c.auth, 'link');
  assert.equal(c.bind, '0.0.0.0', 'inside a container the listener binds every interface');
  assert.equal(c.baseUrl, 'http://localhost:8787');
  assert.equal(c.org, 'local');
  assert.equal(c.sessionSecret, '', 'loadConfig fills it from web-session.secret');
  assert.equal(webConfigFrom({ WEB_AUTH: 'link', WEB_PORT: '8790' })!.baseUrl, 'http://localhost:8790');
  assert.equal(webConfigFrom({ WEB_AUTH: 'link' })!.bind, '127.0.0.1', 'outside a container the default stays loopback');
  assert.throws(() => webConfigFrom({ WEB_AUTH: 'link', WEB_BASE_URL: 'https://chat.example.com' }), /WEB_AUTH=link needs a localhost WEB_BASE_URL/);
  assert.throws(() => webConfigFrom({ WEB_AUTH: 'link', WEB_SESSION_SECRET: 'short' }), /at least 32 characters/);
  assert.equal(webConfigFrom({ WEB_AUTH: 'link', WEB_SESSION_SECRET: 'x'.repeat(32) })!.sessionSecret, 'x'.repeat(32));
  assert.throws(() => webConfigFrom({ WEB_AUTH: 'none', WEB_BIND: '0.0.0.0' }), /needs a loopback listener/, '`none` keeps its loopback rule');
});

test('webSessionSecretFile: generated once, owner-only, reused', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aven-web-secret-'));
  const a = webSessionSecretFile(dir);
  assert.ok(a.length >= 32);
  assert.equal(statSync(join(dir, 'web-session.secret')).mode & 0o777, 0o600);
  assert.equal(webSessionSecretFile(dir), a);
});
