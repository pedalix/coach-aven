import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkCsrf, cookieHeader, csrfToken, isAllowed, isOperatorOf, open, openSession, parseCookies, seal, sealSession, SESSION_MAX_AGE_MS } from './auth.js';

const SECRET = 's'.repeat(32);
const session = { user: 'u1', name: 'Ann', email: 'ann@corp.example', iat: 1_000_000 };

test('a sealed cookie opens only with the same secret and an untouched payload', () => {
  const c = seal(SECRET, { a: 1 });
  assert.deepEqual(open(SECRET, c), { a: 1 });
  assert.equal(open('x'.repeat(32), c), undefined);
  assert.equal(open(SECRET, `${c}0`), undefined);
  assert.equal(open(SECRET, c.replace(/^./, (ch) => (ch === 'A' ? 'B' : 'A'))), undefined);
  assert.equal(open(SECRET, 'nodot'), undefined);
  assert.equal(open(SECRET, undefined), undefined);
});

test('sessions expire after their max age and never come from the future', () => {
  const c = sealSession(SECRET, session);
  assert.deepEqual(openSession(SECRET, c, session.iat + 1000), session);
  assert.equal(openSession(SECRET, c, session.iat + SESSION_MAX_AGE_MS + 1), undefined);
  assert.equal(openSession(SECRET, c, session.iat - 120_000), undefined);
  assert.equal(openSession(SECRET, seal(SECRET, { user: '', iat: 1 }), 2), undefined);
  assert.equal(openSession(SECRET, seal(SECRET, { iat: 1 }), 2), undefined);
});

test('the CSRF token is bound to the session and checked in constant time', () => {
  const t = csrfToken(SECRET, session);
  assert.ok(checkCsrf(SECRET, session, t));
  assert.ok(!checkCsrf(SECRET, session, undefined));
  assert.ok(!checkCsrf(SECRET, session, `${t}x`));
  assert.ok(!checkCsrf(SECRET, { ...session, user: 'u2' }, t));
  assert.ok(!checkCsrf(SECRET, { ...session, iat: session.iat + 1 }, t));
});

test('cookies: parsing the header and writing a hardened Set-Cookie', () => {
  assert.deepEqual(parseCookies('a=1; aven_web=x.y; a=2;  b = 3 '), { a: '1', aven_web: 'x.y', b: '3' });
  assert.deepEqual(parseCookies(undefined), {});
  assert.equal(cookieHeader('aven_web', 'v', { secure: true, maxAgeMs: 60_000 }), 'aven_web=v; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=60');
  assert.equal(cookieHeader('aven_web', 'v', { secure: false, clear: true }), 'aven_web=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
});

test('the allow-list: empty is open; e-mails case-insensitively; group:<name> against the groups claim', () => {
  assert.ok(isAllowed([], { groups: [] }));
  assert.ok(isAllowed(['Ann@Corp.example'], { email: 'ann@corp.example', groups: [] }));
  assert.ok(!isAllowed(['ann@corp.example'], { email: 'bo@corp.example', groups: [] }));
  assert.ok(!isAllowed(['ann@corp.example'], { groups: [] }));
  assert.ok(isAllowed(['group:staff'], { groups: ['staff', 'x'] }));
  assert.ok(!isAllowed(['group:staff'], { groups: ['Staff'] }));
  assert.ok(isAllowed([' group:staff ', 'bo@corp.example'], { email: 'bo@corp.example', groups: [] }));
});

test('operators by subject or e-mail', () => {
  assert.ok(isOperatorOf(['u1'], { user: 'u1' }));
  assert.ok(isOperatorOf(['ANN@corp.example'], { user: 'u9', email: 'ann@corp.example' }));
  assert.ok(!isOperatorOf(['u2'], { user: 'u1', email: 'ann@corp.example' }));
  assert.ok(!isOperatorOf([], { user: 'u1' }));
});

test('the identity from the ID token: a display name from name, given+family, the pool\'s username, or the e-mail — never the bare subject', async () => {
  const { identityOf } = await import('./oidc.js');
  assert.deepEqual(identityOf({ sub: 's1', email: 'ann@corp.example', 'cognito:groups': ['staff'] }, 'cognito:groups'), { sub: 's1', groups: ['staff'], email: 'ann@corp.example', name: 'ann@corp.example' });
  assert.equal(identityOf({ sub: 's1', given_name: 'Ann', family_name: 'Lee', email: 'a@x.example' }, 'groups').name, 'Ann Lee');
  assert.equal(identityOf({ sub: 's1', name: 'Ann L.', given_name: 'Ann' }, 'groups').name, 'Ann L.');
  assert.equal(identityOf({ sub: 's1', preferred_username: 'ann', groups: 'a, b' }, 'groups').name, 'ann');
  assert.deepEqual(identityOf({ sub: 's1', groups: 'a, b' }, 'groups'), { sub: 's1', groups: ['a', 'b'] });
});
