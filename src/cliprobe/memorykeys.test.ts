// The memory-keys-survive-edit scenario's reader: which frontmatter keys a printed record carries, and where.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { frontmatterKeys } from './scenarios/candidates.js';

test('frontmatterKeys — top-level keys and the ones under metadata, apart', () => {
  const text = '---\nname: Refunds\nkind: domain\nmetadata:\n  type: project\n  modified: 2000-01-01\n---\nThe shop refunds within 21 days.';
  assert.deepEqual(frontmatterKeys(text), { top: ['name', 'kind', 'metadata'], metadata: ['type', 'modified'] });
});

test('frontmatterKeys — a key nested under another block is not metadata\'s', () => {
  assert.deepEqual(frontmatterKeys('---\nother:\n  kind: domain\n---\n'), { top: ['other'], metadata: [] });
});

test('frontmatterKeys — no frontmatter', () => {
  assert.equal(frontmatterKeys('The shop refunds within 21 days.'), null);
});
