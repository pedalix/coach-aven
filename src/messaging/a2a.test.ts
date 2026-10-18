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

test('parseCard — name, description, accepting and the domain extension; a card without skills (an older release) offers none', () => {
  const card = { name: 'caldora', description: 'Orders and payments of caldora', accepting: true, domain: 'bluefin' };
  assert.deepEqual(parseCard({ ...card, url: 'https://agent.example' }), { ...card, skills: [] });
  assert.equal(parseCard({ ...card, accepting: 'yes' }), undefined);
  assert.equal(parseCard({ ...card, domain: undefined }), undefined);
});

test('parseCard — skills: the A2A AgentSkill subset; tags always present, examples only when given, both capped; a malformed skill is dropped, not the card', () => {
  const card = { name: 'bluefin/brand-studio', description: 'Brand work for hotels', accepting: true, domain: 'bluefin' };
  const skills = [
    { id: 'brand-profile', name: 'brand-profile', description: 'A brand profile from a hotel website', tags: ['brand', 'web'], examples: ['profile for hotel-x.example'] },
    { id: 'site-design', name: 'site-design', description: 'x'.repeat(400), tags: Array.from({ length: 12 }, (_, i) => `t${i}`), examples: Array.from({ length: 9 }, (_, i) => `e${i}`) },
    { id: 'Not An Id', name: 'bad', description: 'dropped' },
    { id: 'no-tags', name: 'no-tags', description: 'no tags given' },
  ];
  const out = parseCard({ ...card, skills })!;
  assert.deepEqual(out.skills.map((s) => s.id), ['brand-profile', 'site-design', 'no-tags']);
  assert.deepEqual(out.skills[0], skills[0]);
  assert.equal(out.skills[1]!.description.length, 300);
  assert.equal(out.skills[1]!.tags.length, 8);
  assert.equal(out.skills[1]!.examples!.length, 5);
  assert.deepEqual(out.skills[2], { id: 'no-tags', name: 'no-tags', description: 'no tags given', tags: [] }, 'tags present, examples absent');
});

test('parseCard — a peer\'s card is capped: at most 32 skills, a name of at most 64 characters', () => {
  const card = { name: 'bluefin/brand-studio', description: 'd', accepting: true, domain: 'bluefin' };
  const skills = Array.from({ length: 40 }, (_, i) => ({ id: `skill-${i}`, name: i === 0 ? 'n'.repeat(500) : `skill-${i}`, description: 'd' }));
  const out = parseCard({ ...card, skills })!;
  assert.equal(out.skills.length, 32);
  assert.equal(out.skills[0]!.name.length, 64);
});
