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

test('only src/chat/teams/ imports the Teams SDK', () => {
  const offenders = tsFiles(SRC)
    .map((p) => relative(SRC, p))
    .filter((rel) => !rel.startsWith('chat/teams/'))
    .filter((rel) => /from ['"]@microsoft\/teams\./.test(readFileSync(join(SRC, rel), 'utf8')));
  assert.deepEqual(offenders, []);
});

test('only src/chat/slack/ imports the Slack SDK', () => {
  const offenders = tsFiles(SRC)
    .map((p) => relative(SRC, p))
    .filter((rel) => !rel.startsWith('chat/slack/'))
    .filter((rel) => /from ['"]@slack\//.test(readFileSync(join(SRC, rel), 'utf8')));
  assert.deepEqual(offenders, []);
});

test('only src/chat/web/oidc.ts imports openid-client, only src/chat/web/webformat.ts imports markdown-it (web-chat-driver D3/D4)', () => {
  const files = tsFiles(SRC).map((p) => relative(SRC, p));
  const oidc = files.filter((rel) => /from ['"]openid-client['"]/.test(readFileSync(join(SRC, rel), 'utf8')));
  assert.deepEqual(oidc, ['chat/web/oidc.ts']);
  const md = files.filter((rel) => /from ['"]markdown-it['"]/.test(readFileSync(join(SRC, rel), 'utf8')));
  assert.deepEqual(md, ['chat/web/webformat.ts']);
});
