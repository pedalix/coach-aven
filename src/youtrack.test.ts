import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  pickInternalGroup,
  commentUrl,
  matchesPrefix,
  dueTickets,
  attachmentUrl,
  fieldValueText,
  linkTypeLabel,
  mapIssue,
  headerExtras,
  type YouTrackIssue,
} from './youtrack.js';

const issue = (id: string): YouTrackIssue => ({
  id,
  summary: `summary ${id}`,
  description: '',
  projectShortName: id.split('-')[0],
  tags: ['AI auto review'],
  createdAt: '',
  reporter: '',
  fields: [],
  links: [],
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

test('fieldValueText: flattens every custom-field value shape', () => {
  assert.equal(fieldValueText(null), '');
  assert.equal(fieldValueText(undefined), '');
  assert.equal(fieldValueText('Critical'), 'Critical'); // plain string
  assert.equal(fieldValueText(3), '3'); // plain number (e.g. votes)
  assert.equal(fieldValueText({ name: 'Open' }), 'Open'); // enum/state/version
  assert.equal(fieldValueText({ login: 'jdoe', fullName: 'Jane Doe' }), 'Jane Doe'); // user
  assert.equal(fieldValueText({ presentation: '1w 2d' }), '1w 2d'); // period
  assert.equal(fieldValueText({ text: 'free text' }), 'free text'); // text field
  assert.equal(fieldValueText([{ name: 'web' }, { name: 'api' }]), 'web, api'); // multi-value
  assert.equal(fieldValueText({}), ''); // unset object value
});

test('linkTypeLabel: direction-aware, falls back to name then a generic label', () => {
  const lt = { name: 'Duplicate', sourceToTarget: 'duplicates', targetToSource: 'is duplicated by' };
  assert.equal(linkTypeLabel('OUTWARD', lt), 'duplicates');
  assert.equal(linkTypeLabel('BOTH', lt), 'duplicates');
  assert.equal(linkTypeLabel('INWARD', lt), 'is duplicated by');
  assert.equal(linkTypeLabel('OUTWARD', { name: 'Relates' }), 'Relates');
  assert.equal(linkTypeLabel(undefined, undefined), 'relates to');
});

test('mapIssue: maps fields (dropping unset), date custom fields, and flattens links', () => {
  const mapped = mapIssue({
    idReadable: 'GLACIER-42',
    summary: 'Voucher fails',
    created: Date.UTC(2026, 6, 1),
    reporter: { login: 'support' },
    customFields: [
      { name: 'Priority', value: { name: 'Critical' } },
      { name: 'Assignee', value: null }, // unset → dropped
      { $type: 'DateIssueCustomField', name: 'Due Date', value: Date.UTC(2026, 6, 15) },
    ],
    links: [
      {
        direction: 'OUTWARD',
        linkType: { name: 'Duplicate', sourceToTarget: 'duplicates', targetToSource: 'is duplicated by' },
        issues: [{ idReadable: 'GLACIER-30', summary: 'Old voucher bug', resolved: 1750000000000 }],
      },
      { direction: 'INWARD', linkType: { name: 'Relates' }, issues: [] }, // empty link group → nothing
    ],
  });
  assert.deepEqual(mapped.fields, [
    { name: 'Priority', value: 'Critical' },
    { name: 'Due Date', value: '2026-07-15' },
  ]);
  assert.deepEqual(mapped.links, [
    { type: 'duplicates', id: 'GLACIER-30', summary: 'Old voucher bug', resolved: true },
  ]);
  assert.equal(mapped.reporter, 'support');
  assert.equal(mapped.createdAt, '2026-07-01T00:00:00.000Z');
});

test('headerExtras: priority (red-dotted only when urgent) + coarse age', () => {
  const now = Date.parse('2026-07-07T12:00:00Z');
  const base = issue('GLACIER-1');
  assert.equal(headerExtras(base, now), ''); // nothing to show → header stays as-is
  assert.equal(
    headerExtras(
      { ...base, createdAt: '2026-07-05T12:00:00Z', fields: [{ name: 'Priority', value: 'Critical' }] },
      now,
    ),
    '🔴 Critical · 2d old',
  );
  assert.equal(
    headerExtras({ ...base, fields: [{ name: 'priority', value: 'Normal' }] }, now),
    'Normal', // any casing; calm priorities get no dot
  );
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

test('pickInternalGroup: prefers recommended Team, falls back to a single option, refuses ambiguity', () => {
  const team = { id: 'g1', name: 'caldora - Hillrail [24.335] Team' };
  const other = { id: 'g2', name: 'All Users' };
  // recommended team wins
  assert.deepEqual(pickInternalGroup([team], [other]), team);
  // no recommendation but exactly one candidate → take it (the common helpdesk shape)
  assert.deepEqual(pickInternalGroup([], [team]), team);
  // several candidates, exactly one "... Team" → take the team
  assert.deepEqual(pickInternalGroup([], [other, team]), team);
  // ambiguous (two teams / no team among several) → undefined: caller must FAIL, not post publicly
  assert.equal(pickInternalGroup([], [team, { id: 'g3', name: 'Another Team' }]), undefined);
  assert.equal(pickInternalGroup([], [other, { id: 'g4', name: 'Registered Users' }]), undefined);
  assert.equal(pickInternalGroup([], []), undefined);
});

test('commentUrl: deep-links the comment on the issue', () => {
  assert.equal(
    commentUrl('https://acmeyt.youtrack.cloud/', 'CG-50', '4-321'),
    'https://acmeyt.youtrack.cloud/issue/CG-50#focus=Comments-4-321.0-0',
  );
});
