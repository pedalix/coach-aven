import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cacheKey, parseJsonLoose, readEnvelope } from './llm.js';

test('parseJsonLoose — plain, fenced, wrapped in prose, braces inside strings', () => {
  assert.deepEqual(parseJsonLoose('{"a":1}'), { a: 1 });
  assert.deepEqual(parseJsonLoose('Here you go:\n```json\n[{"id":"x"}]\n```'), [{ id: 'x' }]);
  assert.deepEqual(parseJsonLoose('Sure. {"label":"a}b","n":2} — done'), { label: 'a}b', n: 2 });
  assert.throws(() => parseJsonLoose('no json here'));
});

test('cacheKey — stable, and sensitive to model, system and prompt', () => {
  const c = { model: 'haiku', system: 's', prompt: 'p' };
  assert.equal(cacheKey(c), cacheKey({ ...c }));
  assert.notEqual(cacheKey(c), cacheKey({ ...c, model: 'sonnet' }));
  assert.notEqual(cacheKey(c), cacheKey({ ...c, system: 's2' }));
  assert.notEqual(cacheKey(c), cacheKey({ ...c, prompt: 'p2' }));
});

test('readEnvelope — tokens summed across cache kinds; errors surfaced', () => {
  const ok = readEnvelope(
    JSON.stringify({
      result: '{"ok":true}',
      is_error: false,
      total_cost_usd: 0.0009,
      usage: { input_tokens: 2, cache_creation_input_tokens: 4344, cache_read_input_tokens: 10, output_tokens: 11 },
      modelUsage: { 'claude-haiku-5-5': {} },
    }),
  );
  assert.equal(ok.inputTokens, 4356);
  assert.equal(ok.outputTokens, 11);
  assert.equal(ok.model, 'claude-haiku-5-5');
  assert.equal(ok.error, undefined);
  const bad = readEnvelope(JSON.stringify({ result: 'Not logged in', is_error: true }));
  assert.equal(bad.error, 'Not logged in');
});
