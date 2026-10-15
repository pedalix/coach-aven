import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normaliseYoutrackIssue, youtrackQuery } from './normalise.js';

const issue = {
  id: '2-1234',
  idReadable: 'CG-50',
  summary: 'Payment webhook times out',
  description: 'Payora webhook > 30s on Hillrail.',
  created: Date.UTC(2026, 8, 20),
  updated: Date.UTC(2026, 9, 5, 8, 30),
  resolved: null,
  reporter: { login: 'florin', email: 'Florin@Client.example', fullName: 'Florin' },
  project: { shortName: 'CG' },
  tags: [{ name: 'investigate' }],
  customFields: [
    { name: 'State', value: { name: 'In Progress', $type: 'StateBundleElement' } },
    { name: 'Assignee', value: { login: 'owen', fullName: 'Owen A', $type: 'User' } },
    { name: 'Due Date', value: Date.UTC(2026, 9, 10) },
    { name: 'Priority', value: { name: 'Major' } },
  ],
  comments: [
    { id: 'c1', text: 'Looking into it', created: Date.UTC(2026, 9, 1), author: { login: 'owen', email: 'owen@home.example' } },
    { id: 'c2', text: 'gone', created: Date.UTC(2026, 9, 2), deleted: true, author: { login: 'x' } },
  ],
};

test('YouTrack issue → task', () => {
  const t = normaliseYoutrackIssue(issue, 'https://bluefin-example.youtrack.cloud/');
  assert.equal(t.account, 'bluefin-example.youtrack.cloud');
  assert.equal(t.key, 'CG-50');
  assert.equal(t.status, 'In Progress');
  assert.equal(t.statusCategory, 'doing');
  assert.equal(t.assignee, 'youtrack:owen');
  assert.equal(t.reporter, 'florin@client.example');
  assert.equal(t.due, '2026-10-10');
  assert.equal(t.updated, '2026-10-05T08:30:00.000Z');
  assert.equal(t.url, 'https://bluefin-example.youtrack.cloud/issue/CG-50');
  assert.deepEqual(t.labels, ['investigate']);
  assert.equal(t.comments.length, 1);
  assert.equal(t.comments[0]!.author, 'owen@home.example');
});

test('resolved issue is done regardless of state name', () => {
  const t = normaliseYoutrackIssue({ ...issue, resolved: Date.UTC(2026, 9, 6), customFields: [{ name: 'State', value: { name: 'Verified' } }] }, 'https://bluefin-example.youtrack.cloud');
  assert.equal(t.statusCategory, 'done');
});

test('youtrackQuery scopes project, day and person', () => {
  const q = youtrackQuery('CAR', new Date('2026-09-15T13:00:00Z'), 'owen');
  assert.equal(q, 'project: {CAR} and updated: 2026-09-15 .. Today and (for: owen or reporter: owen or commenter: owen)');
  assert.equal(youtrackQuery('CG', new Date('2026-09-15T00:00:00Z')), 'project: {CG} and updated: 2026-09-15 .. Today');
});
