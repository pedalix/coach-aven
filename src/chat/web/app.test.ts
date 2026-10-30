// The web surface's small rules that live in its composition root (OpenSpec quickstart D2): who is an operator,
// and the one line that carries the `link` sign-in key.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isWebOperator, signInLine } from './app.js';

test('operators: WEB_OPERATORS everywhere; under link the local user too, and only there', () => {
  assert.equal(isWebOperator({ auth: 'link', operators: [] }, 'local'), true);
  assert.equal(isWebOperator({ auth: 'none', operators: [] }, 'local'), false, '`none` keeps WEB_OPERATORS as the only list');
  assert.equal(isWebOperator({ auth: 'none', operators: ['local'] }, 'local'), true);
  assert.equal(isWebOperator({ auth: 'oidc', operators: ['ann@corp.example'] }, 'u1', 'ann@corp.example'), true);
  assert.equal(isWebOperator({ auth: 'link', operators: [] }, 'u1'), false);
  assert.equal(isWebOperator({ auth: 'link', operators: [] }, undefined), false);
});

test('the sign-in line: the base URL and the key, in the shape the docs grep for', () => {
  assert.equal(signInLine('http://localhost:8787', 'abc'), 'Web chat sign-in: http://localhost:8787/login?key=abc');
});
