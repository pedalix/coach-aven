// The shared halves of messaging (OpenSpec `agent-messaging`, task 1.4): protocol.ts and a2a.ts are
// what the hub — a Cloudflare Worker — shares with the bot, so they import nothing from `node:`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('protocol.ts and a2a.ts import nothing from node:', () => {
  for (const f of ['protocol.ts', 'a2a.ts']) {
    const text = readFileSync(new URL(`./${f}`, import.meta.url), 'utf8');
    const imports = [...text.matchAll(/^import\s[^'"]*['"]([^'"]+)['"]/gm)].map((m) => m[1]!);
    assert.deepEqual(imports.filter((i) => i.startsWith('node:') || !i.startsWith('./')), [], `${f} imports only its siblings`);
  }
});
