// The chat-driver boundary as a rule (OpenSpec chat-driver-interface, design D4): only the
// Slack driver may import the Slack SDK. Everything else talks to ChatDriver — a new chat
// platform is a new directory under src/chat/, not an edit across the core.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const SRC = new URL('../', import.meta.url).pathname;

function tsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return name === 'fixtures' ? [] : tsFiles(p);
    return p.endsWith('.ts') ? [p] : [];
  });
}

test('only src/chat/slack/ imports the Slack SDK', () => {
  const offenders = tsFiles(SRC)
    .map((p) => relative(SRC, p))
    .filter((rel) => !rel.startsWith('chat/slack/'))
    .filter((rel) => /from ['"]@slack\//.test(readFileSync(join(SRC, rel), 'utf8')));
  assert.deepEqual(offenders, []);
});
