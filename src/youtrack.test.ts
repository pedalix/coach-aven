import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchesPrefix, dueTickets, attachmentUrl, type YouTrackIssue } from './youtrack.js';

const issue = (id: string): YouTrackIssue => ({
  id,
  summary: `summary ${id}`,
  description: '',
  projectShortName: id.split('-')[0],
  tags: ['AI auto review'],
  createdAt: '',
  reporter: '',
});

test('matchesPrefix: exact prefix and id-with-number, case-insensitive', () => {
  assert.equal(matchesPrefix('GLACIER-42', ['GLACIER']), true);
  assert.equal(matchesPrefix('glacier-42', ['GLACIER']), true); // case-insensitive
  assert.equal(matchesPrefix('GLACIER-42', ['glacier']), true);
  assert.equal(matchesPrefix('VALLORA-1', ['VALLORA', 'BRS', 'LAKORA']), true);
});

test('matchesPrefix: rejects non-matching and prefix-collisions', () => {
  assert.equal(matchesPrefix('ALIGRO-7', ['GLACIER']), false);
  // "ENG" must NOT match "GLACIER-1" — we require a full segment, not a substring.
  assert.equal(matchesPrefix('GLACIER-1', ['ENG']), false);
  assert.equal(matchesPrefix('', ['GLACIER']), false);
});

test('dueTickets: returns only unseen issues matching the project prefixes', () => {
  const issues = [issue('GLACIER-1'), issue('GLACIER-2'), issue('ALIGRO-9'), issue('OTHER-3')];
  const due = dueTickets(issues, { seen: new Set(['GLACIER-1']), prefixes: ['GLACIER'] });
  assert.deepEqual(
    due.map((i) => i.id),
    ['GLACIER-2'],
  );
});

test('dueTickets: one project can carry several prefixes (caldora help-desks)', () => {
  const issues = [issue('VALLORA-1'), issue('BRS-2'), issue('LAKORA-3'), issue('GLACIER-4')];
  const due = dueTickets(issues, { seen: new Set(), prefixes: ['VALLORA', 'BRS', 'LAKORA'] });
  assert.deepEqual(
    due.map((i) => i.id),
    ['VALLORA-1', 'BRS-2', 'LAKORA-3'],
  );
});

test('dueTickets: empty prefixes selects nothing', () => {
  assert.deepEqual(dueTickets([issue('GLACIER-1')], { seen: new Set(), prefixes: [] }), []);
});

test('attachmentUrl: prefixes root-relative urls, passes absolute through', () => {
  assert.equal(
    attachmentUrl('https://yt.example.com/', '/api/files/abc?sign=xyz'),
    'https://yt.example.com/api/files/abc?sign=xyz',
  );
  // trailing slash on base + no leading slash on url still joins cleanly
  assert.equal(attachmentUrl('https://yt.example.com', 'api/files/abc'), 'https://yt.example.com/api/files/abc');
  assert.equal(
    attachmentUrl('https://yt.example.com', 'https://cdn.other/x.png'),
    'https://cdn.other/x.png',
  );
});
