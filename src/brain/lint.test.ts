import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildIndex } from './index.js';
import { TIDY_FINDINGS, tidyShare, lint, type Finding } from './lint.js';

const SEEN = new Date('2026-05-01T08:00:00.000Z');
const NOW = new Date('2026-06-15T08:00:00.000Z'); // 45 days later
const rec = (front: string, body = 'Body.\n'): string => `---\n${front}\n---\n${body}`;

const FILES: Record<string, string> = {
  'MEMORY.md': '- [a](glacier-12.md)\n- [b](glacier-12-followup.md)\n- [c](pricing.md)\n- [d](untyped.md)\n- [e](no-status.md)\n- [f](contact.md)\n- [g](gone.md)\n',
  'glacier-12.md': rec('kind: investigation\nstatus: open\nticket: GLACIER-12'),
  'glacier-12-followup.md': rec('kind: investigation\nstatus: fixed\nticket: glacier-12'),
  'pricing.md': rec('kind: domain'),
  'untyped.md': rec('name: an older note'),
  'no-status.md': rec('kind: investigation\nticket: GLACIER-20'),
  'contact.md': rec('kind: domain', 'Write to desk@skipass.example.\n'),
  'unlinked.md': rec('kind: method'),
};

const codes = (fs: Finding[], name: string): string[] => fs.filter((f) => f.records.includes(name)).map((f) => f.code).sort();

test('lint — the findings of design D6, each on the record that has it', () => {
  const fs = lint(buildIndex(FILES, SEEN), { now: NOW, resolvedTickets: ['GLACIER-12'] });
  assert.deepEqual(codes(fs, 'glacier-12.md'), ['open-stale', 'same-ticket', 'ticket-resolved']);
  assert.deepEqual(codes(fs, 'glacier-12-followup.md'), ['same-ticket']);
  assert.deepEqual(codes(fs, 'pricing.md'), []);
  assert.deepEqual(codes(fs, 'untyped.md'), ['no-kind']);
  assert.deepEqual(codes(fs, 'no-status.md'), ['no-status']);
  assert.deepEqual(codes(fs, 'contact.md'), ['personal-data']);
  assert.deepEqual(codes(fs, 'unlinked.md'), ['not-linked']);
  assert.deepEqual(codes(fs, 'gone.md'), ['no-file']);
  assert.match(fs.find((f) => f.code === 'open-stale')!.text, /`open` for 45 days/);
  // The finding names the pattern and the count, never the address.
  assert.ok(!JSON.stringify(fs).includes('desk@'));
});

test('lint — 30 days open is not stale yet; without a tracker list nothing is reported resolved', () => {
  const fs = lint(buildIndex(FILES, SEEN), { now: new Date('2026-05-31T08:00:00.000Z') });
  assert.deepEqual(codes(fs, 'glacier-12.md'), ['same-ticket']);
});

test('lint — a clean set has no findings', () => {
  const clean = { 'MEMORY.md': '[p](pricing.md)', 'pricing.md': rec('kind: domain') };
  assert.deepEqual(lint(buildIndex(clean, SEEN), { now: NOW }), []);
});

test('tidyShare — at most 15 findings, oldest first, stable', () => {
  const f = (i: number, since: string): Finding => ({ code: 'no-kind', records: [`r${i}.md`], text: `r${String(i).padStart(2, '0')}.md: no kind`, since });
  const many = Array.from({ length: 20 }, (_, i) => f(i, i < 10 ? '2026-03-01T00:00:00.000Z' : '2026-01-01T00:00:00.000Z'));
  const share = tidyShare(many);
  assert.equal(share.length, TIDY_FINDINGS);
  assert.deepEqual(share.slice(0, 10).map((x) => x.records[0]), Array.from({ length: 10 }, (_, i) => `r${i + 10}.md`));
  assert.deepEqual(share.slice(10).map((x) => x.records[0]), ['r0.md', 'r1.md', 'r2.md', 'r3.md', 'r4.md']);
  assert.deepEqual(tidyShare([...many].reverse()), share);
});
