import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  commentsFromWrike,
  contactIdsOf,
  dataOf,
  folderTitles,
  normaliseWrikeTask,
  permalinkKey,
  statusMap,
  updatedSince,
  wrikeCategory,
  wrikePerson,
  wrikeStamp,
  type WrikeLookups,
} from './normalise.js';

// Fixtures shaped like Wrike REST v4 answers (the `data` of each envelope); ids and people invented.
// Folder ids are 16 upper-case characters, contact ids 8, as the API writes them.
const FOLDER_CLIENT = 'IEAAB2CDI4CLNT01'; // the configured client folder
const FOLDER_SITE = 'IEAAB2CDI4SITE01'; // a subfolder: the site relaunch
const FOLDER_SEO = 'IEAAB2CDI4SEO001'; // another subfolder the same task is tagged into
const MIRA = 'KUAB2C01';
const JONAH = 'KUAB2C02';
const GONE = 'KUAB2C03'; // a deleted user: no e-mail any more

const contacts = new Map<string, Record<string, unknown> | null>([
  [MIRA, { id: MIRA, firstName: 'Mira', lastName: 'Talbot', type: 'Person', profiles: [{ accountId: 'IEAAB2CD', email: 'Mira.Talbot@studio.example', role: 'User', external: false }], primaryEmail: 'Mira.Talbot@studio.example', deleted: false }],
  [JONAH, { id: JONAH, firstName: 'Jonah', lastName: 'Pell', type: 'Person', profiles: [{ accountId: 'IEAAB2CD', email: 'jonah@harbor-bakery.example', role: 'Collaborator', external: true }], deleted: false }],
  [GONE, { id: GONE, firstName: 'Former', lastName: 'Member', type: 'Person', profiles: [], deleted: true }],
  ['KUAB2C09', null],
]);

const workflows = [
  {
    id: 'IEAAB2CDK77WF001',
    name: 'Client delivery',
    standard: false,
    hidden: false,
    customStatuses: [
      { id: 'IEAAB2CDJMAAAAA1', name: 'New', standardName: false, standard: false, group: 'Active', hidden: false },
      { id: 'IEAAB2CDJMAAAAA2', name: 'In Progress', standardName: false, standard: false, group: 'Active', hidden: false },
      { id: 'IEAAB2CDJMAAAAA3', name: 'Fixed on staging', standardName: false, standard: false, group: 'Active', hidden: false },
      { id: 'IEAAB2CDJMAAAAA4', name: 'Waiting for client', standardName: false, standard: false, group: 'Deferred', hidden: false },
      { id: 'IEAAB2CDJMAAAAA5', name: 'Live', standardName: false, standard: false, group: 'Completed', hidden: false },
      { id: 'IEAAB2CDJMAAAAA6', name: 'Dropped', standardName: false, standard: false, group: 'Cancelled', hidden: false },
    ],
  },
];

const subtree = [
  { id: FOLDER_CLIENT, title: 'Harbor Bakery', childIds: [FOLDER_SITE, FOLDER_SEO], scope: 'WsFolder' },
  { id: FOLDER_SITE, title: 'Website relaunch', childIds: [], scope: 'WsFolder' },
  { id: FOLDER_SEO, title: 'SEO', childIds: [], scope: 'WsFolder' },
];

const lookups = (): WrikeLookups => ({ host: 'www.wrike.com', contacts, statuses: statusMap(workflows), folders: folderTitles(subtree), fallbackProject: 'Harbor Bakery' });

const task = {
  id: 'IEAAB2CDKQTASK01',
  accountId: 'IEAAB2CD',
  title: 'Opening hours page shows the winter times',
  description:
    '<p>The page still shows <b>winter</b> hours.</p><ul><li>update the CMS block</li><li>clear the cache</li></ul>' +
    '<p>See <a href="https://harbor-bakery.example/hours">the live page</a> &amp; ping <a class="stream-user-id avatar" rel="@KUAB2C02">@Jonah Pell</a></p>',
  parentIds: [FOLDER_SITE, FOLDER_SEO, 'IEAAB2CDI7777777'],
  superParentIds: [],
  responsibleIds: [MIRA, JONAH],
  authorIds: [JONAH],
  status: 'Active',
  importance: 'High',
  createdDate: '2026-10-01T08:00:00Z',
  updatedDate: '2026-10-12T09:30:00Z',
  dates: { type: 'Planned', duration: 480, start: '2026-10-13T09:00:00', due: '2026-10-14T17:00:00', workOnWeekends: false },
  scope: 'WsTask',
  customStatusId: 'IEAAB2CDJMAAAAA2',
  permalink: 'https://www.wrike.com/open.htm?id=1100220033',
  priority: '1c2d3e4f00000000a0000000',
};

test('wrikeStamp drops the milliseconds Wrike rejects; updatedSince is the open range it expects', () => {
  assert.equal(wrikeStamp(new Date('2026-10-12T09:30:00.123Z')), '2026-10-12T09:30:00Z');
  assert.equal(updatedSince(new Date('2026-09-30T00:00:00.000Z')), '{"start":"2026-09-30T00:00:00Z"}');
});

test('wrikePerson: Name <email> (lower-cased), else the e-mail, else the name, else wrike:<id>', () => {
  assert.equal(wrikePerson(MIRA, contacts), 'Mira Talbot <mira.talbot@studio.example>');
  assert.equal(wrikePerson(JONAH, contacts), 'Jonah Pell <jonah@harbor-bakery.example>', 'no primaryEmail: the profile e-mail');
  assert.equal(wrikePerson(GONE, contacts), 'Former Member', 'a deleted user keeps the name');
  assert.equal(wrikePerson('KUAB2C09', contacts), 'wrike:KUAB2C09', 'asked, not found');
  assert.equal(wrikePerson('KUAB2C10', contacts), 'wrike:KUAB2C10', 'never asked');
  assert.equal(wrikePerson('', contacts), '');
  assert.equal(wrikePerson('K1', new Map([['K1', { firstName: 'Ada <ops>', lastName: '', primaryEmail: 'ada@studio.example' }]])), 'Ada ops <ada@studio.example>', 'brackets in a name cannot fake an address');
});

test('wrikeCategory: the group decides done; Deferred is open; a "done"-sounding Active status stays open', () => {
  assert.equal(wrikeCategory('Completed', 'Live'), 'done');
  assert.equal(wrikeCategory('Cancelled', 'Dropped'), 'done');
  assert.equal(wrikeCategory('Deferred', 'Waiting for client'), 'todo');
  assert.equal(wrikeCategory('Active', 'In Progress'), 'doing');
  assert.equal(wrikeCategory('Active', 'New'), 'todo');
  assert.equal(wrikeCategory('Active', 'Active'), 'todo', 'the standard workflow\'s own name');
  assert.equal(wrikeCategory('Active', 'Fixed on staging'), 'doing');
});

test('permalinkKey: the number people see in a Wrike link, else the API id', () => {
  assert.equal(permalinkKey('https://www.wrike.com/open.htm?id=1100220033', 'IEAAB2CDKQTASK01'), '1100220033');
  assert.equal(permalinkKey('', 'IEAAB2CDKQTASK01'), 'IEAAB2CDKQTASK01');
});

test('a Wrike task + comments → task: custom status, first assignee, folder as project, other folders as labels, HTML as text', () => {
  const comments = commentsFromWrike(
    [
      // Wrike lists newest first; the record keeps them oldest first.
      { id: 'IEAAB2CDIMCMNT02', authorId: MIRA, text: 'Updated the CMS block, cache next.', createdDate: '2026-10-12T09:30:00Z', updatedDate: '2026-10-12T09:30:00Z', taskId: task.id },
      { id: 'IEAAB2CDIMCMNT01', authorId: JONAH, text: '@Mira Talbot the winter hours are still up', createdDate: '2026-10-11T15:00:00Z', updatedDate: '2026-10-11T15:00:00Z', taskId: task.id },
      { id: 'IEAAB2CDIMCMNT03', authorId: JONAH, text: '   ', createdDate: '2026-10-11T16:00:00Z', updatedDate: '2026-10-11T16:00:00Z', taskId: task.id },
    ],
    contacts,
  );
  const t = normaliseWrikeTask(task, lookups(), comments);
  assert.deepEqual(
    { ...t, text: undefined, comments: undefined },
    {
      source: 'wrike',
      account: 'www.wrike.com',
      id: 'IEAAB2CDKQTASK01',
      key: '1100220033',
      title: 'Opening hours page shows the winter times',
      status: 'In Progress',
      statusCategory: 'doing',
      assignee: 'Mira Talbot <mira.talbot@studio.example>',
      reporter: 'Jonah Pell <jonah@harbor-bakery.example>',
      due: '2026-10-14',
      created: '2026-10-01T08:00:00.000Z',
      updated: '2026-10-12T09:30:00.000Z',
      project: 'Website relaunch',
      url: 'https://www.wrike.com/open.htm?id=1100220033',
      labels: ['SEO', 'importance:high'],
      text: undefined,
      comments: undefined,
    },
  );
  assert.equal(t.text, 'The page still shows winter hours.\n- update the CMS block\n- clear the cache\n\nSee the live page (https://harbor-bakery.example/hours) & ping @Jonah Pell');
  assert.deepEqual(
    t.comments.map((c) => [c.id, c.author, c.ts, c.text]),
    [
      ['IEAAB2CDIMCMNT01', 'Jonah Pell <jonah@harbor-bakery.example>', '2026-10-11T15:00:00.000Z', '@Mira Talbot the winter hours are still up'],
      ['IEAAB2CDIMCMNT02', 'Mira Talbot <mira.talbot@studio.example>', '2026-10-12T09:30:00.000Z', 'Updated the CMS block, cache next.'],
    ],
    'oldest first, an empty comment dropped',
  );
});

test('a subtask sits in no project folder: its superParentIds place it; nothing in the subtree → the configured folder', () => {
  const sub = { ...task, id: 'IEAAB2CDKQTASK02', parentIds: ['IEAAB2CDI7777777'], superParentIds: [FOLDER_SITE], importance: 'Normal', responsibleIds: [], authorIds: [], dates: { type: 'Backlog' } };
  const t = normaliseWrikeTask(sub, lookups());
  assert.equal(t.project, 'Website relaunch');
  assert.deepEqual(t.labels, [], 'Normal importance is no label');
  assert.equal(t.assignee, '');
  assert.equal(t.due, '', 'a backlog task has no due date');
  assert.equal(normaliseWrikeTask({ ...sub, superParentIds: [] }, lookups()).project, 'Harbor Bakery');
});

test('statuses: an unknown customStatusId (a hidden workflow) falls back to the standard status and its group', () => {
  const done = normaliseWrikeTask({ ...task, customStatusId: 'IEAAB2CDJMHIDDEN', status: 'Completed' }, lookups());
  assert.deepEqual([done.status, done.statusCategory], ['Completed', 'done']);
  const parked = normaliseWrikeTask({ ...task, customStatusId: 'IEAAB2CDJMAAAAA4' }, lookups());
  assert.deepEqual([parked.status, parked.statusCategory], ['Waiting for client', 'todo']);
  const live = normaliseWrikeTask({ ...task, customStatusId: 'IEAAB2CDJMAAAAA5', status: 'Completed' }, lookups());
  assert.deepEqual([live.status, live.statusCategory], ['Live', 'done']);
});

test('dataOf / contactIdsOf: the envelope\'s data; first assignee, first author and every commenter, once each', () => {
  assert.deepEqual(dataOf({ kind: 'tasks', data: [{ id: 'a' }, null, 3] }), [{ id: 'a' }]);
  assert.deepEqual(dataOf({ error: 'not_authorized' }), []);
  assert.deepEqual(contactIdsOf([task, { ...task, responsibleIds: [], authorIds: [MIRA] }], [[{ authorId: GONE }, { authorId: MIRA }]]), [MIRA, JONAH, GONE]);
});
