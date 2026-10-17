import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isTerminal, parseCard, parseMessage, parseStatus, parseTask, textMessage, textOf } from './a2a.js';

const ID = 'a1b2c3d4e5f60718293a4b5c';
const TASK = '0f1e2d3c4b5a69788796a5b4';

test('parseMessage — a text message; unknown fields ignored; malformed refused', () => {
  const m = textMessage('user', 'Which orders failed today?', ID, TASK);
  assert.deepEqual(parseMessage({ ...m, extra: 1, parts: [{ kind: 'text', text: 'Which orders failed today?', extra: true }] }), m);
  assert.equal(parseMessage({ ...m, role: 'system' }), undefined);
  assert.equal(parseMessage({ ...m, messageId: 'not-an-id' }), undefined);
  assert.equal(parseMessage({ ...m, parts: [] }), undefined);
  assert.equal(parseMessage({ ...m, parts: [{ kind: 'file', uri: 'x' }] }), undefined);
  assert.equal(parseMessage({ ...m, taskId: 'X'.repeat(24) }), undefined);
  assert.equal(parseMessage({ ...m, parts: [{ kind: 'text', text: 'x'.repeat(256 * 1024 + 1) }] }), undefined, 'over the answer cap');
  assert.equal(textOf({ ...m, parts: [{ kind: 'text', text: 'a' }, { kind: 'text', text: 'b' }] }), 'a\nb');
});

test('parseStatus / parseTask — A2A states, the message optional; terminal states', () => {
  const status = { state: 'input-required', timestamp: '2026-10-17T10:00:00.000Z', message: textMessage('agent', 'Which month?', ID, TASK) };
  assert.deepEqual(parseStatus(status), status);
  assert.equal(parseStatus({ ...status, state: 'pending' }), undefined);
  assert.equal(parseStatus({ ...status, message: { role: 'agent' } }), undefined);
  assert.deepEqual(parseTask({ id: TASK, contextId: 'c', status }), { id: TASK, contextId: 'c', status });
  assert.equal(parseTask({ id: 'x', contextId: 'c', status }), undefined);
  assert.deepEqual(['completed', 'canceled', 'failed', 'rejected', 'working', 'input-required'].map((s) => isTerminal(s as never)), [true, true, true, true, false, false]);
});

test('parseCard — name, description, accepting and the domain extension', () => {
  const card = { name: 'caldora', description: 'Orders and payments of caldora', accepting: true, domain: 'bluefin' };
  assert.deepEqual(parseCard({ ...card, url: 'https://agent.example' }), card);
  assert.equal(parseCard({ ...card, accepting: 'yes' }), undefined);
  assert.equal(parseCard({ ...card, domain: undefined }), undefined);
});
