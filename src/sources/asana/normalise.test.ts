import { test } from 'node:test';
import assert from 'node:assert/strict';
import { commentsFromStories, involvesMe, normaliseAsanaTask } from './normalise.js';

test('involvesMe: assigned to me, or me among the followers (what an @mention makes), by gid or e-mail', () => {
  const me = { gid: '1167899671459952', email: 'owen@example.com' };
  assert.equal(involvesMe({ assignee: { gid: '1167899671459952', name: 'Owen Hale' } }, me), true);
  assert.equal(involvesMe({ assignee: { gid: '7520977444547', name: 'Rowan Mills' }, followers: [{ gid: '7520977444547' }, { gid: '1167899671459952' }] }, me), true);
  assert.equal(involvesMe({ assignee: null, followers: [{ gid: '1', email: 'OWEN@example.com' }] }, { email: 'owen@example.com' }), true);
  assert.equal(involvesMe({ assignee: { gid: '7520977444547' }, followers: [{ gid: '7520977444547' }] }, me), false);
  assert.equal(involvesMe({ assignee: null }, me), false);
  assert.equal(involvesMe({ assignee: { gid: '1167899671459952' } }, {}), false, 'an unresolved me matches nothing');
});

test('Asana task + stories → task', () => {
  const comments = commentsFromStories([
    { gid: 's1', type: 'comment', resource_subtype: 'comment_added', text: 'Can you check billing alerts?', created_at: '2026-10-05T14:00:00.000Z', created_by: { gid: '7520977444547', name: 'Rowan Mills' } },
    { gid: 's2', type: 'system', resource_subtype: 'assigned', text: 'assigned to you', created_at: '2026-10-05T14:01:00.000Z' },
  ]);
  const t = normaliseAsanaTask(
    {
      gid: '1216659284629384',
      name: 'AWS billing alerts expanded and hard limits',
      notes: 'Budgets + anomaly detection',
      completed: false,
      assignee: { gid: '1167899671459952', name: 'Owen Hale', email: 'owen@example.com' },
      created_by: { gid: '7520977444547', name: 'Rowan Mills' },
      due_on: '2026-10-09',
      created_at: '2026-09-30T10:00:00.000Z',
      modified_at: '2026-10-06T14:30:40.186Z',
      memberships: [{ project: { name: 'CartGenie dev board' }, section: { name: 'Internal review / QA' } }],
      permalink_url: 'https://app.asana.com/1/7520977444554/project/1208573315693393/task/1216659284629384',
      tags: [],
    },
    '7520977444554',
    comments,
  );
  assert.equal(t.status, 'Internal review / QA');
  assert.equal(t.statusCategory, 'doing');
  assert.equal(t.assignee, 'owen@example.com');
  assert.equal(t.reporter, 'asana:7520977444547');
  assert.equal(t.due, '2026-10-09');
  assert.equal(t.project, 'CartGenie dev board');
  assert.equal(t.comments.length, 1);
  assert.equal(t.comments[0]!.text, 'Can you check billing alerts?');
});

test('completed task is done', () => {
  const t = normaliseAsanaTask({ gid: '1', name: 'x', completed: true, memberships: [{ section: { name: 'Ready to Code' } }] }, 'w');
  assert.equal(t.status, 'Completed');
  assert.equal(t.statusCategory, 'done');
});
