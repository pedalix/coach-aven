import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildIndex, linkedFiles, personalData, sha256 } from './index.js';

const T0 = new Date('2026-05-01T08:00:00.000Z');
const T1 = new Date('2026-05-02T08:00:00.000Z');

// An invented project's memory: a ski-pass shop with tickets GLACIER-n.
const FILES: Record<string, string> = {
  'MEMORY.md': '# Index\n- [Voucher counted twice](glacier-12.md) — March report\n- [Pricing](pricing.md)\n- [Gone](gone.md)\n',
  'glacier-12.md': '---\nname: Voucher counted twice\nkind: investigation\nstatus: open\nticket: GLACIER-12\n---\nSeen in the March export.\n',
  'pricing.md': '---\nname: How lift passes are priced\nkind: domain\nmetadata:\n  modified: 2026-02-10T09:00:00.000Z\n---\nDay pass, season pass.\n',
  'old-note.md': 'No frontmatter. Ask anna.keller@skipass.example or +41 79 555 01 23.\n',
  'notes.txt': 'not a record',
};

test('buildIndex — every record with its kind, status and ticket; MEMORY.md and non-records are not records', () => {
  const idx = buildIndex(FILES, T0);
  assert.deepEqual(idx.records.map((r) => r.name), ['glacier-12.md', 'old-note.md', 'pricing.md']);
  const [inv, old, dom] = idx.records;
  assert.deepEqual(
    { kind: inv.kind, status: inv.status, ticket: inv.ticket, title: inv.title },
    { kind: 'investigation', status: 'open', ticket: 'GLACIER-12', title: 'Voucher counted twice' },
  );
  assert.equal(dom.kind, 'domain');
  assert.equal(old.kind, undefined);
  assert.deepEqual(idx.linked, ['glacier-12.md', 'gone.md', 'pricing.md']);
  assert.equal(inv.hash, sha256(FILES['glacier-12.md']));
});

test('buildIndex — first seen is the host\'s first look, or the record\'s own earlier stamp', () => {
  const idx = buildIndex(FILES, T0);
  const by = Object.fromEntries(idx.records.map((r) => [r.name, r]));
  assert.equal(by['glacier-12.md'].firstSeen, T0.toISOString());
  assert.equal(by['pricing.md'].firstSeen, '2026-02-10T09:00:00.000Z');
});

test('buildIndex — a rebuild keeps both dates of an unchanged record and moves lastChange of a changed one', () => {
  const first = buildIndex(FILES, T0);
  const next = buildIndex({ ...FILES, 'glacier-12.md': FILES['glacier-12.md'].replace('status: open', 'status: fixed') }, T1, first);
  const by = Object.fromEntries(next.records.map((r) => [r.name, r]));
  assert.equal(by['glacier-12.md'].firstSeen, T0.toISOString());
  assert.equal(by['glacier-12.md'].lastChange, T1.toISOString());
  assert.equal(by['glacier-12.md'].status, 'fixed');
  assert.equal(by['old-note.md'].lastChange, T0.toISOString());
});

test('personalData — counts, never the text; order ids, dates and amounts are not phone numbers', () => {
  assert.deepEqual(personalData('anna.keller@skipass.example, b@skipass.example, +41 79 555 01 23'), { email: 2, phone: 1 });
  assert.deepEqual(personalData('call +41 (79) 555-01-23'), { phone: 1 });
  assert.equal(personalData('order 2026110312345, on 2026-11-03 12:30:00, CHF 1 250.00, +5 items, id 0012345678901'), undefined);
  const idx = buildIndex(FILES, T0);
  assert.deepEqual(idx.records.find((r) => r.name === 'old-note.md')?.personal, { email: 1, phone: 1 });
  assert.ok(!JSON.stringify(idx).includes('anna.keller'));
});

test('linkedFiles — local .md links only', () => {
  assert.deepEqual(linkedFiles('[a](a.md) [b](./b.md) [web](https://docs.example/x.md) [c](c.md#part) [img](p.png)'), ['a.md', 'b.md']);
});
