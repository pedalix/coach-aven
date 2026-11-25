import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRecord } from './record.js';

const rec = (front: string, body = 'Body.\n'): string => `---\n${front}\n---\n${body}`;

test('parseRecord — the contract keys sit at the top level, beside what Claude Code writes', () => {
  const p = parseRecord(
    rec(
      [
        'name: GLACIER-12 voucher counted twice',
        'description: why the March report doubled',
        'kind: investigation',
        'status: answered',
        'ticket: GLACIER-12',
        'metadata:',
        '  node_type: memory',
        '  type: project',
        '  modified: 2026-03-04T10:00:00.000Z',
      ].join('\n'),
    ),
  );
  assert.deepEqual(p, {
    title: 'GLACIER-12 voucher counted twice',
    kind: 'investigation',
    status: 'answered',
    ticket: 'GLACIER-12',
    modified: '2026-03-04T10:00:00.000Z',
    body: 'Body.\n',
  });
});

test('parseRecord — a record written before the contract stays readable: no kind, nothing fails', () => {
  const p = parseRecord(rec('name: How lift passes are priced\nmetadata:\n  type: reference'));
  assert.equal(p.kind, undefined);
  assert.equal(p.status, undefined);
  assert.equal(p.title, 'How lift passes are priced');
});

test('parseRecord — a value outside the contract reads as absent; case and quotes are forgiven', () => {
  assert.equal(parseRecord(rec('kind: note')).kind, undefined);
  assert.equal(parseRecord(rec('kind: investigation\nstatus: done')).status, undefined);
  assert.equal(parseRecord(rec('kind: "Method"')).kind, 'method');
  assert.equal(parseRecord(rec("status: 'Fixed'\nkind: investigation")).status, 'fixed');
});

test('parseRecord — metadata.type is Claude Code\'s own field, never the kind', () => {
  const p = parseRecord(rec('name: x\nmetadata:\n  type: decision\n  node_type: memory'));
  assert.equal(p.kind, undefined);
});

test('parseRecord — the contract keys under metadata, where the agent also writes them, are read', () => {
  const p = parseRecord(rec('name: x\nmetadata:\n  node_type: memory\n  kind: investigation\n  status: open\n  ticket: SHOP-682\n  type: project'));
  assert.equal(p.kind, 'investigation');
  assert.equal(p.status, 'open');
  assert.equal(p.ticket, 'SHOP-682');
});

test('parseRecord — a top-level key wins over the one under metadata', () => {
  const p = parseRecord(rec('kind: method\nmetadata:\n  kind: domain\n  status: fixed'));
  assert.equal(p.kind, 'method');
  assert.equal(p.status, 'fixed');
});

test('parseRecord — no frontmatter: the whole text is the body', () => {
  assert.deepEqual(parseRecord('Just a note.\n---\nkind: domain\n'), { body: 'Just a note.\n---\nkind: domain\n' });
});
