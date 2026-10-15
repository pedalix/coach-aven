/**
 * Fixtures are hand-written from the REST references (field names and encodings as documented),
 * not captured from a live account — there is no token in CI, and the shapes are small.
 *   Gmail message:   https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages#Message
 *   Drive file:      https://developers.google.com/workspace/drive/api/reference/rest/v3/files#File
 *   Drive change:    https://developers.google.com/workspace/drive/api/reference/rest/v3/changes#Change
 *   Calendar event:  https://developers.google.com/workspace/calendar/api/v3/reference/events#resource
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  drivePath,
  extractText,
  gmailContainer,
  gmailTombstone,
  htmlToText,
  normaliseCalendarEvent,
  normaliseDriveChange,
  normaliseDriveFile,
  normaliseGmailMessage,
  parseAddresses,
  type DriveNode,
  type RawCalendarEvent,
  type RawDriveChange,
  type RawDriveFile,
  type RawGmailMessage,
} from './normalise.js';

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64url');
const ACCOUNT = 'owen@home.example';

// ---------------------------------------------------------------------------------------
// Gmail
// ---------------------------------------------------------------------------------------

/** multipart/mixed(multipart/alternative(text/plain, text/html), application/pdf) — the common Outlook shape. */
const gmailMixed: RawGmailMessage = {
  id: '19a1b2c3d4e5f607',
  threadId: '19a1b2c3d4e5f600',
  labelIds: ['INBOX', 'IMPORTANT', 'CATEGORY_PERSONAL', 'UNREAD'],
  snippet: 'Hi Owen, can you send the P3 estimate by Friday?',
  historyId: '8841322',
  internalDate: '1791280800000',
  sizeEstimate: 48213,
  payload: {
    partId: '',
    mimeType: 'multipart/mixed',
    filename: '',
    headers: [
      { name: 'Delivered-To', value: 'owen@home.example' },
      { name: 'From', value: '"North, Tess" <Tess.North@partner.example>' },
      { name: 'To', value: 'Owen Hale <owen@home.example>, vincent@partner.example' },
      { name: 'Cc', value: '"Lindqvist, Vincent" <vera.lindqvist@partner.example>' },
      { name: 'Subject', value: 'P3 estimate — Friday?' },
      { name: 'Date', value: 'Tue, 6 Oct 2026 12:00:00 +0200' },
      { name: 'Message-ID', value: '<AM0PR01MB1234@partner.example>' },
    ],
    body: { size: 0 },
    parts: [
      {
        partId: '0',
        mimeType: 'multipart/alternative',
        filename: '',
        headers: [{ name: 'Content-Type', value: 'multipart/alternative; boundary="000000000000abcd"' }],
        body: { size: 0 },
        parts: [
          {
            partId: '0.0',
            mimeType: 'text/plain',
            filename: '',
            headers: [{ name: 'Content-Type', value: 'text/plain; charset="UTF-8"' }, { name: 'Content-Transfer-Encoding', value: 'base64' }],
            body: { size: 61, data: b64('Hi Owen,\r\n\r\ncan you send the P3 estimate by Friday?\r\n\r\nTobin\r\n') },
          },
          {
            partId: '0.1',
            mimeType: 'text/html',
            filename: '',
            headers: [{ name: 'Content-Type', value: 'text/html; charset="UTF-8"' }],
            body: { size: 120, data: b64('<div dir="ltr">Hi Owen,<br><br>can you send the P3 estimate by Friday?<br><br>Tobin</div>') },
          },
        ],
      },
      {
        partId: '1',
        mimeType: 'application/pdf',
        filename: 'P3-brief.pdf',
        headers: [{ name: 'Content-Disposition', value: 'attachment; filename="P3-brief.pdf"' }],
        body: { attachmentId: 'ANGjdJ8…', size: 41234 },
      },
    ],
  },
};

test('gmail: multipart/mixed → plain body, e-mail participants, internalDate as ts', () => {
  const r = normaliseGmailMessage(gmailMixed, ACCOUNT);
  assert.equal(r.source, 'gmail');
  assert.equal(r.account, ACCOUNT);
  assert.equal(r.id, '19a1b2c3d4e5f607');
  assert.equal(r.container, 'inbox');
  assert.equal(r.ts, '2026-10-06T10:00:00.000Z');
  assert.equal(r.author, 'tess.north@partner.example');
  assert.deepEqual(r.participants, ['tess.north@partner.example', 'owen@home.example', 'vincent@partner.example', 'vera.lindqvist@partner.example']);
  assert.equal(r.subject, 'P3 estimate — Friday?');
  assert.equal(r.text, 'Hi Owen,\n\ncan you send the P3 estimate by Friday?\n\nTobin');
  assert.equal(r.permalink, 'https://mail.google.com/mail/?authuser=owen%40home.example#all/19a1b2c3d4e5f607');
  assert.equal(r.raw_ref, 'gmail:owen@home.example/19a1b2c3d4e5f600/19a1b2c3d4e5f607');
  assert.equal(r.deleted, undefined);
});

test('gmail: html-only message is flattened; sent mail lands in "sent" even when also in INBOX', () => {
  const htmlOnly: RawGmailMessage = {
    id: 'aa',
    threadId: 'aa',
    labelIds: ['SENT', 'INBOX'],
    internalDate: '1791280800000',
    payload: {
      mimeType: 'text/html',
      headers: [{ name: 'From', value: 'owen@home.example' }, { name: 'To', value: 'carla@bluefin.example' }, { name: 'Subject', value: 'Re: Alpco' }],
      body: { size: 1, data: b64('<html><head><style>p{color:red}</style></head><body><p>Done &amp; deployed.</p><p>See <a href="https://x">ticket</a>&nbsp;CAR-14</p></body></html>') },
    },
  };
  const r = normaliseGmailMessage(htmlOnly, ACCOUNT);
  assert.equal(r.container, 'sent');
  assert.equal(r.text, 'Done & deployed.\n\nSee ticket CAR-14');
  assert.deepEqual(r.participants, ['owen@home.example', 'carla@bluefin.example']);
});

test('gmail: metadata-only / empty body falls back to the snippet; missing From gives empty author', () => {
  const r = normaliseGmailMessage({ id: 'x', threadId: 'x', snippet: 'calendar invite', internalDate: '0', payload: { headers: [] } }, ACCOUNT);
  assert.equal(r.text, 'calendar invite');
  assert.equal(r.author, '');
  assert.equal(r.container, 'archive');
  assert.equal(r.subject, undefined);
});

test('gmail: non-UTF-8 charset is honoured when decoding the body', () => {
  const latin1 = Buffer.from('Grüezi Zürich', 'latin1').toString('base64url');
  const text = extractText({ mimeType: 'text/plain', headers: [{ name: 'Content-Type', value: 'text/plain; charset=iso-8859-1' }], body: { data: latin1 } });
  assert.equal(text, 'Grüezi Zürich');
});

test('gmail: container precedence and address parsing edge cases', () => {
  assert.equal(gmailContainer(['TRASH', 'INBOX']), 'trash');
  assert.equal(gmailContainer(['DRAFT']), 'draft');
  assert.equal(gmailContainer(['SPAM']), 'spam');
  assert.equal(gmailContainer(['CHAT']), 'chat');
  assert.equal(gmailContainer([]), 'archive');
  assert.equal(gmailContainer(undefined), 'archive');
  assert.deepEqual(parseAddresses('"Doe, Jane" <Jane.Doe@Example.com>, bob@example.com, Jane.Doe@example.com'), ['jane.doe@example.com', 'bob@example.com']);
  assert.deepEqual(parseAddresses(undefined), []);
  assert.deepEqual(parseAddresses('undisclosed-recipients:;'), []);
});

test('gmail: tombstone carries identity only', () => {
  const t = gmailTombstone('dead1', ACCOUNT, '2026-10-06T12:00:00.000Z');
  assert.equal(t.deleted, true);
  assert.equal(t.id, 'dead1');
  assert.equal(t.ts, '2026-10-06T12:00:00.000Z');
  assert.equal(t.text, '');
  assert.deepEqual(t.participants, []);
});

test('htmlToText: entities, numeric refs, block breaks, scripts dropped', () => {
  assert.equal(htmlToText('<script>x()</script>a&#8212;b&#x2014;c<br/>d<p>e</p>\n\n\n\nf'), 'a—b—c\nd\ne\n\nf');
});

// ---------------------------------------------------------------------------------------
// Drive
// ---------------------------------------------------------------------------------------

const ROOT = '0AJx1RootIdOfMyDrive';
const SHARED_DRIVE = '0AKsharedDriveLHS';
/** Folder tree as `files.list` would return it (plus what a lazy `files.get` on a parent would add). */
const tree: Record<string, DriveNode> = {
  fldProjects: { name: 'Projects', parents: [ROOT] },
  fldLHS: { name: 'HCG', parents: ['fldProjects'] },
  fldSdBriefs: { name: 'Briefs', parents: [SHARED_DRIVE], driveId: SHARED_DRIVE },
  fldShared: { name: 'Bluefin handover' /* parent not visible to this account */ },
};
const ctx = {
  lookup: (id: string) => tree[id],
  driveName: (id: string) => (id === SHARED_DRIVE ? 'HCG Engineering' : undefined),
  rootId: ROOT,
};

const driveDoc: RawDriveFile = {
  id: '1aBcDeFgHiJkLmNoPqRsTuVwXyZ',
  name: 'P3 estimate',
  mimeType: 'application/vnd.google-apps.document',
  modifiedTime: '2026-10-05T16:42:11.123Z',
  parents: ['fldLHS'],
  owners: [{ emailAddress: 'owen@home.example', displayName: 'Owen Hale' }],
  webViewLink: 'https://docs.google.com/document/d/1aBcDeFgHiJkLmNoPqRsTuVwXyZ/edit?usp=drivesdk',
  trashed: false,
  shared: true,
};

test('drive: My Drive path is walked to the root id; native doc has size 0', () => {
  const r = normaliseDriveFile(driveDoc, ACCOUNT, drivePath(driveDoc, ctx));
  assert.deepEqual(r, {
    source: 'gdrive',
    account: ACCOUNT,
    id: '1aBcDeFgHiJkLmNoPqRsTuVwXyZ',
    name: 'P3 estimate',
    path: 'My Drive/Projects/HCG/P3 estimate',
    mime: 'application/vnd.google-apps.document',
    modified: '2026-10-05T16:42:11.123Z',
    size: 0,
    link: 'https://docs.google.com/document/d/1aBcDeFgHiJkLmNoPqRsTuVwXyZ/edit?usp=drivesdk',
  });
});

test('drive: shared-drive items are rooted at "Shared drives/<name>", root-level and nested', () => {
  const nested: RawDriveFile = { id: 'f1', name: 'brief-v1.0.pdf', mimeType: 'application/pdf', parents: ['fldSdBriefs'], driveId: SHARED_DRIVE, size: '204800', modifiedTime: '2026-10-01T08:00:00.000Z' };
  assert.equal(drivePath(nested, ctx), 'Shared drives/HCG Engineering/Briefs/brief-v1.0.pdf');
  const top: RawDriveFile = { id: 'f2', name: 'README', parents: [SHARED_DRIVE], driveId: SHARED_DRIVE };
  assert.equal(drivePath(top, ctx), 'Shared drives/HCG Engineering/README');
  assert.equal(normaliseDriveFile(nested, ACCOUNT, drivePath(nested, ctx)).size, 204800);
});

test('drive: shared-with-me — loose file, folder whose parent is invisible, and unknown parent', () => {
  assert.equal(drivePath({ id: 'l', name: 'loose.xlsx' }, ctx), 'Shared with me/loose.xlsx');
  assert.equal(drivePath({ id: 'h', name: 'handover.md', parents: ['fldShared'] }, ctx), 'Shared with me/Bluefin handover/handover.md');
  assert.equal(drivePath({ id: 'u', name: 'x', parents: ['notVisible'] }, ctx), 'Shared with me/x');
});

test('drive: without rootId the "My Drive" root is recognised by name; cycles do not hang', () => {
  const looped: Record<string, DriveNode> = { a: { name: 'A', parents: ['b'] }, b: { name: 'B', parents: ['a'] }, root: { name: 'My Drive' } };
  const c2 = { lookup: (id: string) => looped[id], driveName: () => undefined };
  assert.equal(drivePath({ id: 'f', name: 'f', parents: ['a'] }, c2), 'Shared with me/B/A/f');
  assert.equal(drivePath({ id: 'f', name: 'f', parents: ['root'] }, c2), 'My Drive/f');
});

test('drive: trashed file is a tombstone with metadata; missing webViewLink gets an open?id link', () => {
  const r = normaliseDriveFile({ id: 't', name: 'old.txt', trashed: true, parents: [ROOT] }, ACCOUNT, 'My Drive/old.txt');
  assert.equal(r.deleted, true);
  assert.equal(r.link, 'https://drive.google.com/open?id=t');
  assert.equal(r.modified, '');
});

test('drive: changes.list entries — removed, modified, and drive-level changes', () => {
  const removed: RawDriveChange = { changeType: 'file', removed: true, fileId: 'gone', time: '2026-10-06T09:00:00.000Z' };
  const t = normaliseDriveChange(removed, ACCOUNT, () => 'unused');
  assert.ok(t && t.deleted && t.id === 'gone' && t.modified === '2026-10-06T09:00:00.000Z');

  const changed: RawDriveChange = { changeType: 'file', removed: false, fileId: driveDoc.id, time: '2026-10-06T09:01:00.000Z', file: driveDoc };
  const r = normaliseDriveChange(changed, ACCOUNT, (f) => drivePath(f, ctx));
  assert.equal(r?.path, 'My Drive/Projects/HCG/P3 estimate');
  assert.equal(r?.deleted, undefined);

  const driveChange: RawDriveChange = { changeType: 'drive', driveId: SHARED_DRIVE, time: '2026-10-06T09:02:00.000Z', drive: { id: SHARED_DRIVE, name: 'HCG Engineering' } };
  assert.equal(normaliseDriveChange(driveChange, ACCOUNT, () => ''), undefined);
});

// ---------------------------------------------------------------------------------------
// Calendar
// ---------------------------------------------------------------------------------------

const timedEvent: RawCalendarEvent = {
  id: '5k2j4h3g2f1d0s9a8p7o6i5u4y3t',
  status: 'confirmed',
  htmlLink: 'https://www.google.com/calendar/event?eid=NWsyajRoM2cyZjFkMHM5YThwN282aTV1NHkzdCBpdmFuQHBlZGFsaXguY29t',
  summary: 'HCG weekly',
  description: 'Agenda in Teams',
  start: { dateTime: '2026-10-07T09:00:00+02:00', timeZone: 'Europe/Zurich' },
  end: { dateTime: '2026-10-07T09:30:00+02:00', timeZone: 'Europe/Zurich' },
  iCalUID: '5k2j4h3g2f1d0s9a8p7o6i5u4y3t@google.com',
  organizer: { email: 'Tess.North@partner.example', displayName: 'Tess North' },
  creator: { email: 'tess.north@partner.example' },
  attendees: [
    { email: 'tess.north@partner.example', organizer: true, responseStatus: 'accepted' },
    { email: 'owen@home.example', self: true, responseStatus: 'accepted' },
    { email: 'room-bern-1@resource.calendar.google.com', displayName: 'Bern 1', resource: true, responseStatus: 'accepted' },
    { email: 'owen@home.example', responseStatus: 'needsAction' },
  ],
  eventType: 'default',
};

test('calendar: timed event → RFC3339 start/end, people-only attendees de-duplicated, lower-cased organizer', () => {
  const r = normaliseCalendarEvent(timedEvent, ACCOUNT, 'primary');
  assert.deepEqual(r, {
    source: 'gcal',
    account: ACCOUNT,
    id: '5k2j4h3g2f1d0s9a8p7o6i5u4y3t',
    calendar: 'primary',
    start: '2026-10-07T09:00:00+02:00',
    end: '2026-10-07T09:30:00+02:00',
    title: 'HCG weekly',
    attendees: ['tess.north@partner.example', 'owen@home.example'],
    organizer: 'tess.north@partner.example',
    link: timedEvent.htmlLink,
  });
});

test('calendar: all-day event keeps the YYYY-MM-DD encoding; untitled event has empty title', () => {
  const r = normaliseCalendarEvent({ id: 'allday', status: 'confirmed', start: { date: '2026-10-09' }, end: { date: '2026-10-10' } }, ACCOUNT, 'primary');
  assert.equal(r.start, '2026-10-09');
  assert.equal(r.end, '2026-10-10');
  assert.equal(r.title, '');
  assert.deepEqual(r.attendees, []);
  assert.equal(r.organizer, '');
});

test('calendar: cancelled recurring instance (showDeleted) is a tombstone dated by originalStartTime', () => {
  const r = normaliseCalendarEvent(
    { id: 'rec_20261014T070000Z', status: 'cancelled', recurringEventId: 'rec', originalStartTime: { dateTime: '2026-10-14T09:00:00+02:00', timeZone: 'Europe/Zurich' } },
    ACCOUNT,
    'team@group.calendar.google.com',
  );
  assert.equal(r.deleted, true);
  assert.equal(r.start, '2026-10-14T09:00:00+02:00');
  assert.equal(r.calendar, 'team@group.calendar.google.com');
});

// ---------------------------------------------------------------------------------------
// Calendar selection + event filter
// ---------------------------------------------------------------------------------------
import { calendarWindow, keepCalendarEvent, selectCalendars } from './normalise.js';

test('selectCalendars: primary only by default; opt-in by id; shared/holiday/contacts/deleted skipped', () => {
  const list = [
    { id: 'owen@home.example', primary: true, accessRole: 'owner' },
    { id: 'max.muster@home.example', summary: 'Milo', accessRole: 'reader' },
    { id: 'en.ch#holiday@group.v.calendar.google.com', summary: 'Holidays in Switzerland', accessRole: 'reader' },
    { id: 'addressbook#contacts@group.v.calendar.google.com', summary: 'Birthdays', accessRole: 'reader' },
    { id: 'team@home.example', summary: 'Team', accessRole: 'writer' },
    { id: 'old@home.example', deleted: true },
  ];
  const d = selectCalendars(list);
  assert.deepEqual(d.selected.map((c) => c.id), ['owen@home.example']);
  assert.deepEqual(d.skipped.map((c) => c.id), ['max.muster@home.example', 'en.ch#holiday@group.v.calendar.google.com', 'addressbook#contacts@group.v.calendar.google.com', 'team@home.example']);
  const o = selectCalendars(list, ['TEAM@home.example']);
  assert.deepEqual(o.selected.map((c) => c.id), ['owen@home.example', 'team@home.example']);
});

test('keepCalendarEvent: window, cancelled, declined, empty placeholder', () => {
  const now = new Date('2026-10-07T12:00:00Z');
  const w = calendarWindow(now, 400, 120);
  assert.equal(w.timeMin.slice(0, 10), '2025-09-02');
  assert.equal(w.timeMax.slice(0, 10), '2027-02-04');
  const me = { email: 'owen@home.example', self: true, responseStatus: 'accepted' };
  const base = { id: 'e1', status: 'confirmed' as const, summary: 'BLUEFIN Devs Weekly Sync', start: { dateTime: '2026-10-06T14:30:00+03:00' }, end: { dateTime: '2026-10-06T15:00:00+03:00' }, attendees: [me, { email: 'nicola@client.example' }] };
  assert.equal(keepCalendarEvent(base, w, { incremental: false }), true);
  assert.equal(keepCalendarEvent({ ...base, start: { date: '1984-05-01' } }, w, { incremental: false }), false, 'ancient recurrence');
  assert.equal(keepCalendarEvent({ ...base, start: { date: '2099-12-25' } }, w, { incremental: false }), false, 'far future');
  assert.equal(keepCalendarEvent({ ...base, start: { date: '2026-10-07' }, summary: '', attendees: [] }, w, { incremental: false }), false, 'title-less block without people');
  assert.equal(keepCalendarEvent({ ...base, summary: '', attendees: [me, { email: 'x@y.z' }] }, w, { incremental: false }), true, 'untitled but with people');
  assert.equal(keepCalendarEvent({ ...base, attendees: [{ ...me, responseStatus: 'declined' }, { email: 'x@y.z' }] }, w, { incremental: false }), false, 'declined by me');
  assert.equal(keepCalendarEvent({ id: 'e2', status: 'cancelled', recurringEventId: 'r', originalStartTime: { dateTime: '2026-10-08T10:00:00Z' } }, w, { incremental: false }), false, 'cancelled on full sync');
  assert.equal(keepCalendarEvent({ id: 'e2', status: 'cancelled', recurringEventId: 'r', originalStartTime: { dateTime: '2026-10-08T10:00:00Z' } }, w, { incremental: true }), true, 'cancelled on incremental → tombstone');
  assert.equal(keepCalendarEvent({ ...base, start: { date: '2025-09-02' } }, w, { incremental: false }), true, 'all-day on the boundary day kept');
});
