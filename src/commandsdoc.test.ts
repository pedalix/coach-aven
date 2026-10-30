// docs/commands.md is the Home tab's cheat-sheet rendered as markdown (src/commandsdoc.ts): a new command that
// lands in the Home tab (CLAUDE.md) and not in the page fails here. Re-render on purpose: UPDATE_SNAPSHOTS=1 npm test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { bulletToMarkdown, commandsDoc } from './commandsdoc.js';

const PAGE = new URL('../docs/commands.md', import.meta.url);

test('docs/commands.md is the rendering of the Home cheat-sheet', () => {
  const want = commandsDoc();
  if (process.env.UPDATE_SNAPSHOTS === '1') writeFileSync(PAGE, want);
  assert.equal(readFileSync(PAGE, 'utf8'), want, 'docs/commands.md is stale — run `UPDATE_SNAPSHOTS=1 npm test` and commit it');
});

test('bulletToMarkdown: mrkdwn bold becomes markdown bold, code spans and italics stay', () => {
  assert.equal(bulletToMarkdown('• *Stop me* — hit *✖ Cancel* on it.'), '- **Stop me** — hit **✖ Cancel** on it.');
  assert.equal(bulletToMarkdown('• *Usage* — `/aven usage *x*` _(operators)_'), '- **Usage** — `/aven usage *x*` _(operators)_');
});
