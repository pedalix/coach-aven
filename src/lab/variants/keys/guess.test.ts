import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ItemUnit, LlmLike } from '../../types.js';
import { buildGuessPrompt, guessGroups, guessSpace, parseGuesses, type GuessGroup } from './guess.js';

const SPACE = ['acme/shop', 'acme/web', 'acme/admin', 'none', 'unregistered'];
const CARDS = [{ id: 'acme/shop', umbrella: 'acme', name: 'Shop relaunch', done: false, code: 'P7', cues: ['shop.acme.example', 'SHOP-'], people: ['Mara Quill (exclusive)'] }];

const unit = (id: string, text: string): ItemUnit => ({
  id,
  day: '2026-01-05',
  ts: '2026-01-05T08:00:00Z',
  type: 'message',
  source: 'slack',
  account: 'T0',
  container: '#ops-alerts',
  thread: null,
  author: 'Uptime Watch',
  authorPerson: null,
  isBot: true,
  participants: [],
  toPersons: [],
  subject: null,
  text,
  keys: [],
});

const groups: GuessGroup[] = [
  { tag: 'g1', members: [unit('slack:T0:C9:1', 'DOWN <https://shop.acme.example/health?x=1|shop> is down')], size: 4, keyType: 'host', kGuess: null },
  { tag: 'g2', members: [unit('slack:T0:C9:2', 'deploy finished: brochure-site')], size: 1, keyType: 'app', kGuess: 'acme/web' },
];

test('the prompt: the closed list with its cards, tags instead of ids, URLs cut to their host', () => {
  const { system, prompt } = buildGuessPrompt('t1-item', groups, SPACE, CARDS);
  assert.ok(system.includes('acme/shop | acme | Shop relaunch | P7 | cues: shop.acme.example, SHOP- | people: Mara Quill (exclusive)'));
  assert.ok(system.includes('\nunregistered\n') || system.includes('\nunregistered'), 'every id of the label space is listed');
  assert.ok(prompt.startsWith('g1 (4 records, shared key: host)'));
  assert.ok(prompt.includes('… 3 more like these'));
  assert.ok(prompt.includes('K guess: acme/web'));
  assert.ok(!prompt.includes('slack:T0:C9'), 'store ids never reach the model');
  assert.ok(prompt.includes('shop.acme.example') && !prompt.includes('/health'));
  const kind = buildGuessPrompt('t4-kind', groups, guessSpace('t4-kind', []), []);
  assert.ok(kind.system.includes('incident — something is broken'));
});

test('parsing keeps known tags and closed-list ids only, first answer per tag', () => {
  const text = 'Here you go:\n```json\n[{"group":"g1","guess":"acme/shop","cite":"shop is down"},{"group":"g1","guess":"acme/web"},{"group":"g2","guess":"acme/blog"},{"group":"g7","guess":"none"}]\n```';
  assert.deepEqual([...parseGuesses(text, ['g1', 'g2'], SPACE)], [['g1', 'acme/shop']]);
  assert.deepEqual([...parseGuesses('{"groups":[{"group":"g2","guess":" none "}]}', ['g2'], SPACE)], [['g2', 'none']]);
  assert.equal(parseGuesses('no json at all', ['g1'], SPACE).size, 0);
});

test('a failing model guesses nothing and never throws', async () => {
  const throwing: LlmLike = { call: async () => Promise.reject(new Error('no token')) };
  const r = await guessGroups(throwing, 't1-item', groups, SPACE, CARDS);
  assert.equal(r.guesses.size, 0);
  assert.match(r.error ?? '', /no token/);
  const erroring: LlmLike = { call: async () => ({ text: '', costUsd: 0, cached: false, error: 'quota' }) };
  assert.equal((await guessGroups(erroring, 't1-item', groups, SPACE, CARDS)).error, 'quota');
  let calls = 0;
  const counting: LlmLike = { call: async () => (calls++, { text: '[]', costUsd: 0, cached: false }) };
  await guessGroups(counting, 't1-item', [], SPACE, CARDS);
  assert.equal(calls, 0, 'no group, no call');
});
