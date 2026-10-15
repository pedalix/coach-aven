import { test } from 'node:test';
import assert from 'node:assert/strict';
import { adfToText, jiraJql, normaliseJiraIssue } from './normalise.js';

const adf = {
  type: 'doc',
  version: 1,
  content: [
    { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Context' }] },
    { type: 'paragraph', content: [{ type: 'text', text: 'Ping ' }, { type: 'mention', attrs: { id: 'abc', text: '@Tess North' } }, { type: 'text', text: ' about it.' }, { type: 'hardBreak' }, { type: 'text', text: 'Second line' }] },
    { type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'one' }] }] }, { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'two' }] }] }] },
    { type: 'paragraph', content: [{ type: 'inlineCard', attrs: { url: 'https://x.example/y' } }] },
  ],
};

test('ADF → plain text', () => {
  assert.equal(adfToText(adf), 'Context\nPing @Tess North about it.\nSecond line\n- one\n- two\nhttps://x.example/y\n');
  assert.equal(adfToText(null), '');
  assert.equal(adfToText('legacy wiki text'), 'legacy wiki text');
});

test('Jira issue → task', () => {
  const t = normaliseJiraIssue(
    {
      id: '10442',
      key: 'P1-7',
      fields: {
        summary: 'Rotate GastroDat keys',
        status: { name: 'In Review', statusCategory: { key: 'indeterminate' } },
        assignee: { accountId: '712020:abc', displayName: 'Owen', emailAddress: 'Owen.Hale@partner.example' },
        reporter: { accountId: '5b10:def', displayName: 'Tess North' },
        duedate: '2026-10-12',
        created: '2026-10-01T09:00:00.000+0200',
        updated: '2026-10-06T16:30:00.000+0200',
        project: { key: 'P1' },
        labels: ['security', 't4m'],
        description: adf,
        comment: { comments: [{ id: '1', author: { displayName: 'Cyril' }, created: '2026-10-02T10:00:00.000+0200', body: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'ok' }] }] } }] },
      },
    },
    'contoso.atlassian.net',
  );
  assert.equal(t.statusCategory, 'doing');
  assert.equal(t.assignee, 'owen.hale@partner.example');
  assert.equal(t.reporter, 'jira:5b10:def');
  assert.equal(t.updated, '2026-10-06T14:30:00.000Z');
  assert.equal(t.url, 'https://contoso.atlassian.net/browse/P1-7');
  assert.match(t.text, /^Context\nPing @Tess North/);
  assert.equal(t.comments[0]!.text, 'ok');
  assert.equal(t.comments[0]!.author, 'Cyril');
});

test('jiraJql: default involves-me, custom replaces it, updated always ANDed', () => {
  const from = new Date('2026-09-15T07:05:00Z');
  assert.equal(jiraJql(from), '((assignee = currentUser() OR reporter = currentUser() OR watcher = currentUser() OR comment ~ currentUser())) AND updated >= "2026-09-15 07:05" ORDER BY updated ASC');
  assert.equal(jiraJql(from, 'project = P1'), '(project = P1) AND updated >= "2026-09-15 07:05" ORDER BY updated ASC');
});
