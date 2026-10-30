// The model credit on openChat's paths (OpenSpec api-key-credit D2), structurally — like tasks.wiring.test.ts:
// openChat runs over a real sandbox driver, so what is pinned here is that every path hands on the
// installation's credit, and the pieces it hands it to are tested over fakes (project.test.ts seedClaudeAuth,
// claudeSession.test.ts "credit —"). A path that dropped it would silently seed or spawn on a stale credit.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('./tasks.ts', import.meta.url), 'utf8');

test('openChat — the credit file is written from cfg.credit at preparation, on a warm turn and before a new session; never a token field', () => {
  const seeds = src.match(/seedClaudeAuth\(sandbox, [^)]*\)/g) ?? [];
  assert.equal(seeds.length, 3, 'prepareChat, the warm-session re-seed, the (re)open');
  for (const s of seeds) assert.equal(s, 'seedClaudeAuth(sandbox, cfg.credit)');
  assert.doesNotMatch(src, /claudeOauthToken/);
});

test('openChat — both sessions carry the credit kind: a fresh spawn builds its prefix from it, a reattach checks its process against it', () => {
  const blocks = src.split('new ClaudeSession(sandbox, {').slice(1).map((b) => b.slice(0, b.indexOf('});')));
  assert.equal(blocks.length, 2, 'a fresh spawn and a reattach');
  for (const b of blocks) assert.match(b, /\bcredit: cfg\.credit\.kind,/);
});
