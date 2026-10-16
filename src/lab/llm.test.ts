import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cacheKey, LlmRunner, parseJsonLoose, readEnvelope } from './llm.js';

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

test('the child runs in its isolated config dir with CLAUDE.md loading off — nothing of the checkout rides along', async () => {
  // A stand-in `claude` on PATH that answers with where it ran and what it was told about CLAUDE.md files.
  const bin = mkdtempSync(join(tmpdir(), 'lab-llm-bin-'));
  const fake = join(bin, 'claude');
  writeFileSync(fake, '#!/usr/bin/env bash\ncat > /dev/null\nprintf \'{"result":"%s|%s|%s","is_error":false,"total_cost_usd":0,"usage":{"input_tokens":1,"output_tokens":1}}\' "$(pwd -P)" "${CLAUDE_CODE_DISABLE_CLAUDE_MDS:-}" "${CLAUDE_CONFIG_DIR:-}"\n');
  chmodSync(fake, 0o755);
  const lab = mkdtempSync(join(tmpdir(), 'lab-llm-'));
  const configDir = join(lab, '.claude-cfg');
  const path = process.env.PATH;
  process.env.PATH = `${bin}:${path ?? ''}`;
  try {
    const runner = new LlmRunner({ cacheFile: join(lab, 'cache', 'calls.jsonl'), configDir, token: 'test-token', retries: 0 });
    const r = await runner.call({ model: 'haiku', system: 's', prompt: 'p' });
    assert.equal(r.error, undefined);
    assert.equal(r.text, `${realpathSync(configDir)}|1|${configDir}`);
  } finally {
    process.env.PATH = path;
  }
});
