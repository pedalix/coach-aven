import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newId, pageUrl, parseConv, privateConv, projectOfConv, roomConv, userIdOf } from './keys.js';

test('room and private conversation ids round-trip and name their project', () => {
  assert.deepEqual(parseConv(roomConv('alpha')), { kind: 'room', slug: 'alpha' });
  assert.deepEqual(parseConv(privateConv('u1', 'alpha')), { kind: 'private', user: 'u1', slug: 'alpha' });
  // A user id with dots and an @ (an e-mail-shaped subject) still parses: the slug is the LAST segment.
  assert.deepEqual(parseConv(privateConv('ann.lee@corp.example', 'alpha')), { kind: 'private', user: 'ann.lee@corp.example', slug: 'alpha' });
  assert.equal(projectOfConv('room:alpha'), 'alpha');
  assert.equal(projectOfConv('pc:u1:alpha'), 'alpha');
  for (const bad of ['', 'room:', 'pc:', 'pc:u1', 'pc::alpha', 'C123', '19:x@thread.tacv2']) assert.equal(parseConv(bad), undefined, bad);
  // Its parts name a directory and a file (history.ts): plain names only, never a path (the security review of 2026-10-30).
  for (const bad of ['room:../../outside', 'room:..', 'room:.', 'room:a/b', 'room:a\\b', 'pc:../x:alpha', 'pc:u1:..', 'pc:u1:a/b', 'pc:u 1:alpha', `room:${'a'.repeat(129)}`]) {
    assert.equal(parseConv(bad), undefined, bad);
  }
});

test('user ids: a plain subject is kept, anything else becomes a digest without a colon', () => {
  assert.equal(userIdOf('3f2a9c10-1b7e-4a8e-9d1c-0f0e0d0c0b0a'), '3f2a9c10-1b7e-4a8e-9d1c-0f0e0d0c0b0a');
  assert.equal(userIdOf('ann.lee@corp.example'), 'ann.lee@corp.example');
  const odd = userIdOf('auth0|abc:def');
  assert.match(odd, /^u[0-9a-f]{32}$/);
  assert.equal(odd, userIdOf('auth0|abc:def'));
  assert.ok(!odd.includes(':'));
});

test('generated ids are prefixed, unique and free of colons', () => {
  const a = newId();
  const b = newId('t');
  assert.match(a, /^m[0-9a-z]+$/);
  assert.match(b, /^t[0-9a-z]+$/);
  assert.notEqual(a, newId());
});

test('page urls: room, thread, private; nothing for a foreign conversation', () => {
  assert.equal(pageUrl('https://chat.example', 'room:alpha'), 'https://chat.example/r/alpha');
  assert.equal(pageUrl('https://chat.example', 'room:alpha', 'm7'), 'https://chat.example/r/alpha/t/m7');
  assert.equal(pageUrl('https://chat.example', 'pc:u1:alpha'), 'https://chat.example/p/alpha');
  assert.equal(pageUrl('https://chat.example', 'C123'), undefined);
});
