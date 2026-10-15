import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  accountSlug,
  buildFolderPaths,
  chatContainer,
  chatMessageText,
  decodeEntities,
  driveItemPath,
  fileTombstone,
  graphDateTimeToIso,
  htmlToText,
  isContentMessage,
  isDeletedDriveItem,
  mailTombstone,
  normaliseChannelMessage,
  normaliseChatMessage,
  normaliseDriveItem,
  normaliseEvent,
  normaliseMailMessage,
  otherMembers,
  personLabel,
  teamsChatMessageLink,
  truncate,
  type AccountContext,
  type RawChannel,
  type RawChat,
  type RawChatMessage,
  type RawDriveItem,
  type RawEvent,
  type RawMailFolder,
  type RawMailMessage,
  type RawTeam,
} from './normalise.js';

// ---------------------------------------------------------------------------------------
// Fixtures — shaped after the examples on learn.microsoft.com (message, chat, chatMessage,
// event, driveItem resource pages and their list/delta examples). Ids are synthetic but
// follow the real formats: base64-ish mail ids, `19:...@unq.gbl.spaces` chat ids,
// `19:...@thread.tacv2` channel ids, epoch-millis chat message ids, `b!...` drive ids.
// ---------------------------------------------------------------------------------------

const ctx: AccountContext = {
  tenant_id: '00000000-0000-4000-8000-000000000000',
  upn: 'owen.hale@partner.example',
  user_id: '4f3d5a1e-0b2c-4d6e-8f90-1a2b3c4d5e6f',
  display_name: 'Owen Hale',
};

const mailFolders: RawMailFolder[] = [
  { id: 'AAMkInbox', displayName: 'Inbox', parentFolderId: 'AAMkRoot', childFolderCount: 1, totalItemCount: 120 },
  { id: 'AAMkClients', displayName: 'Clients', parentFolderId: 'AAMkInbox', childFolderCount: 1 },
  { id: 'AAMkLhs', displayName: 'HCG', parentFolderId: 'AAMkClients', childFolderCount: 0 },
  { id: 'AAMkSent', displayName: 'Sent Items', parentFolderId: 'AAMkRoot', childFolderCount: 0 },
  { id: 'AAMkHidden', displayName: 'Conversation History', parentFolderId: 'AAMkRoot', isHidden: true },
];

const mail: RawMailMessage = {
  id: 'AAMkAGI2THVSAAA=',
  receivedDateTime: '2026-10-06T07:12:33Z',
  sentDateTime: '2026-10-06T07:12:30Z',
  hasAttachments: true,
  internetMessageId: '<abc123@partner.example>',
  subject: 'P5 go-live checklist',
  bodyPreview: 'Hi Owen, can you confirm the go-live checklist by Thursday?',
  parentFolderId: 'AAMkLhs',
  conversationId: 'AAQkAGI2',
  isDraft: false,
  webLink: 'https://outlook.office365.com/owa/?ItemID=AAMkAGI2THVSAAA%3D&exvsurl=1&viewmodel=ReadMessageItem',
  body: {
    contentType: 'html',
    content:
      '<html><head><style>p{margin:0}</style></head><body><div><p>Hi Owen,</p><p>can you confirm the <b>go-live checklist</b> by Thursday?&nbsp;See <a href="https://contoso.sharepoint.com/sites/P5/Shared%20Documents/checklist.xlsx">the sheet</a>.</p><br><div>Thanks,<br>Tobin</div></div></body></html>',
  },
  from: { emailAddress: { name: 'Tess North', address: 'tess.north@partner.example' } },
  sender: { emailAddress: { name: 'Tess North', address: 'tess.north@partner.example' } },
  toRecipients: [{ emailAddress: { name: 'Owen Hale', address: 'owen.hale@partner.example' } }],
  ccRecipients: [{ emailAddress: { name: 'Vera Lindqvist', address: 'vincent@partner.example' } }],
  bccRecipients: [],
};

const alice = { id: 'a1b2c3d4-0000-4000-8000-000000000001', displayName: 'Alice Example', userIdentityType: 'aadUser', tenantId: ctx.tenant_id };

const oneOnOne: RawChat = {
  id: '19:4f3d5a1e-0b2c-4d6e-8f90-1a2b3c4d5e6f_a1b2c3d4-0000-4000-8000-000000000001@unq.gbl.spaces',
  topic: null,
  chatType: 'oneOnOne',
  createdDateTime: '2026-01-10T09:00:00Z',
  lastUpdatedDateTime: '2026-10-06T08:00:00Z',
  webUrl: 'https://teams.microsoft.com/l/chat/19%3A...%40unq.gbl.spaces/0?tenantId=' + ctx.tenant_id,
  tenantId: ctx.tenant_id,
  members: [
    { '@odata.type': '#microsoft.graph.aadUserConversationMember', id: 'MCMj', roles: ['owner'], displayName: 'Owen Hale', userId: ctx.user_id, email: ctx.upn },
    { '@odata.type': '#microsoft.graph.aadUserConversationMember', id: 'MCMk', roles: ['owner'], displayName: 'Alice Example', userId: alice.id, email: 'alice@partner.example' },
  ],
  lastMessagePreview: { id: '1759737600000', createdDateTime: '2026-10-06T08:00:00Z', isDeleted: false },
};

const groupChat: RawChat = {
  id: '19:b8577ca6597a4ad5a3b9c1e2d3f4a5b6@thread.v2',
  topic: 'P5 platform',
  chatType: 'group',
  members: [
    { displayName: 'Owen Hale', userId: ctx.user_id, email: ctx.upn },
    { displayName: 'Alice Example', userId: alice.id, email: 'alice@partner.example' },
    { displayName: 'Bob Builder', userId: 'b-id', email: 'bob@partner.example' },
  ],
};

const chatMsg: RawChatMessage = {
  id: '1759737600000',
  replyToId: null,
  messageType: 'message',
  createdDateTime: '2026-10-06T08:00:00Z',
  lastModifiedDateTime: '2026-10-06T08:00:00Z',
  lastEditedDateTime: null,
  deletedDateTime: null,
  subject: null,
  summary: null,
  chatId: oneOnOne.id,
  importance: 'normal',
  webUrl: null,
  channelIdentity: null,
  from: { application: null, device: null, user: alice },
  body: {
    contentType: 'html',
    content:
      '<div><div><at id="0">Owen Hale</at> can you review the spec today? <emoji id="slightly_smiling_face" alt="🙂" title="Slightly smiling face"></emoji></div><attachment id="4cb5f5e3"></attachment><div><img src="https://graph.microsoft.com/v1.0/chats/19%3A...%40unq.gbl.spaces/messages/1759737600000/hostedContents/aWQ9/$value" width="200"></div></div>',
  },
  attachments: [{ id: '4cb5f5e3', contentType: 'reference', contentUrl: 'https://contoso.sharepoint.com/sites/P5/Shared%20Documents/spec.docx', name: 'spec.docx' }],
  mentions: [{ id: 0, mentionText: 'Owen Hale', mentioned: { user: { id: ctx.user_id, displayName: 'Owen Hale', userIdentityType: 'aadUser' } } }],
} as RawChatMessage & { importance: string };

const team: RawTeam = { id: '0c6d1b2a-7777-4f1e-9b0a-123456789abc', displayName: 'HCG Dev', description: 'Engineering', isArchived: false, tenantId: ctx.tenant_id };
const channel: RawChannel = { id: '19:abcdef0123456789abcdef0123456789@thread.tacv2', displayName: 'p5-platform', membershipType: 'standard' };

const channelPost: RawChatMessage = {
  id: '1759740000000',
  replyToId: null,
  messageType: 'message',
  createdDateTime: '2026-10-06T08:40:00Z',
  lastModifiedDateTime: '2026-10-06T09:10:00Z',
  subject: 'Release window Friday',
  webUrl:
    'https://teams.microsoft.com/l/message/19%3Aabcdef0123456789abcdef0123456789%40thread.tacv2/1759740000000?groupId=0c6d1b2a-7777-4f1e-9b0a-123456789abc&tenantId=00000000-0000-4000-8000-000000000000&createdTime=1759740000000&parentMessageId=1759740000000',
  channelIdentity: { teamId: team.id, channelId: channel.id },
  from: { user: { id: 't-id', displayName: 'Tess North', userIdentityType: 'aadUser' } },
  body: { contentType: 'html', content: '<div>We deploy Friday 18:00. <at id="0">Owen</at> owns the rollback plan.</div>' },
  mentions: [{ id: 0, mentionText: 'Owen', mentioned: { user: { id: ctx.user_id, displayName: 'Owen Hale' } } }],
  replies: [
    {
      id: '1759740600000',
      replyToId: '1759740000000',
      messageType: 'message',
      createdDateTime: '2026-10-06T08:50:00Z',
      webUrl: null,
      from: { user: { id: ctx.user_id, displayName: 'Owen Hale' } },
      body: { contentType: 'text', content: 'Ack, I will have it ready by Thursday noon.' },
    },
  ],
};

const event: RawEvent = {
  id: 'AAMkAGI2EventAAA=',
  subject: 'P5 weekly sync',
  bodyPreview: 'Agenda: go-live',
  body: { contentType: 'html', content: '<div>Agenda: go-live</div>' },
  start: { dateTime: '2026-10-07T09:00:00.0000000', timeZone: 'UTC' },
  end: { dateTime: '2026-10-07T09:30:00.0000000', timeZone: 'UTC' },
  isAllDay: false,
  isCancelled: false,
  type: 'occurrence',
  seriesMasterId: 'AAMkAGI2SeriesAAA=',
  webLink: 'https://outlook.office365.com/owa/?itemid=AAMkAGI2EventAAA%3D&exvsurl=1&path=/calendar/item',
  onlineMeeting: { joinUrl: 'https://teams.microsoft.com/l/meetup-join/19%3Ameeting_abc%40thread.v2/0' },
  location: { displayName: 'Microsoft Teams Meeting' },
  organizer: { emailAddress: { name: 'Tess North', address: 'tess.north@partner.example' } },
  attendees: [
    { type: 'required', status: { response: 'accepted', time: '2026-10-01T10:00:00Z' }, emailAddress: { name: 'Owen Hale', address: 'owen.hale@partner.example' } },
    { type: 'optional', status: { response: 'none' }, emailAddress: { name: 'Alice Example', address: 'alice@partner.example' } },
  ],
  responseStatus: { response: 'accepted' },
};

const drive = { driveId: 'b!xJ7VoZ9EDkKJ1h9bY0lQ4A', label: 'site:P5 Platform/Documents' };

const driveFile: RawDriveItem = {
  id: '01BYE5RZ6QN3ZWBTUFOFD3GSPGOHDJD36K',
  name: 'spec.docx',
  webUrl: 'https://contoso.sharepoint.com/sites/P5/Shared%20Documents/Projects/P5/spec.docx',
  size: 48213,
  createdDateTime: '2026-09-01T10:00:00Z',
  lastModifiedDateTime: '2026-10-05T16:45:12Z',
  file: { mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
  parentReference: { driveId: drive.driveId, driveType: 'documentLibrary', id: '01BYE5RZ56Y2GOVW7725BZO354PWSELRRZ', path: `/drives/${drive.driveId}/root:/Projects/P5%20Platform`, name: 'P5 Platform' },
  lastModifiedBy: { user: { displayName: 'Tess North', email: 'tess.north@partner.example' } },
};

// ---------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------

test('accountSlug is directory-safe and stable', () => {
  assert.equal(accountSlug('Owen.Hale@Partner.example'), 'owen.hale_at_partner.example');
});

test('personLabel prefers "Name <address>", degrades gracefully', () => {
  assert.equal(personLabel({ name: 'Alice', address: 'Alice@X.com' }), 'Alice <alice@x.com>');
  assert.equal(personLabel({ name: 'alice@x.com', address: 'alice@x.com' }), 'alice@x.com');
  assert.equal(personLabel({ name: '', id: 'abc' }), 'abc');
  assert.equal(personLabel(null), 'unknown');
});

test('graphDateTimeToIso trims 7-digit fractions and appends Z for UTC', () => {
  assert.equal(graphDateTimeToIso({ dateTime: '2026-10-07T09:00:00.0000000', timeZone: 'UTC' }), '2026-10-07T09:00:00Z');
  assert.equal(graphDateTimeToIso({ dateTime: '2026-10-07T09:00:00.1234567', timeZone: 'UTC' }), '2026-10-07T09:00:00.123Z');
  assert.equal(graphDateTimeToIso({ dateTime: '2026-10-07T09:00:00Z' }), '2026-10-07T09:00:00Z');
  // Non-UTC zone names are passed through visibly rather than mis-converted.
  assert.equal(graphDateTimeToIso({ dateTime: '2026-10-07T09:00:00.0000000', timeZone: 'W. Europe Standard Time' }), '2026-10-07T09:00:00[W. Europe Standard Time]');
  assert.equal(graphDateTimeToIso(undefined), '');
});

test('decodeEntities handles named, decimal and hex entities', () => {
  assert.equal(decodeEntities('a &amp; b &lt;c&gt; &#39;q&#x27; &nbsp;&unknown;'), "a & b <c> 'q'  &unknown;");
});

test('htmlToText flattens Outlook HTML: drops <style>, keeps paragraphs, links and bold text', () => {
  const t = htmlToText(mail.body!.content!);
  assert.equal(
    t,
    'Hi Owen,\ncan you confirm the go-live checklist by Thursday? See the sheet (https://contoso.sharepoint.com/sites/P5/Shared%20Documents/checklist.xlsx).\n\nThanks,\nTobin',
  );
});

test('htmlToText handles Teams markup: <at>, <emoji>, <attachment>, hosted-content <img>', () => {
  assert.equal(htmlToText(chatMsg.body!.content!), '@Owen Hale can you review the spec today? 🙂\n[image]');
});

test('htmlToText: lists become bullets, cells become tabs, mailto links keep the label', () => {
  assert.equal(htmlToText('<ul><li>one</li><li>two <a href="mailto:x@y.z">x</a></li></ul><table><tr><td>a</td><td>b</td></tr></table>'), '- one\n- two x\n\na\tb');
});

test('truncate caps text and says how much was cut', () => {
  assert.equal(truncate('abcdef', 0), 'abcdef');
  assert.equal(truncate('abcdef', 3), 'abc\n[... truncated 3 chars]');
});

test('buildFolderPaths walks parentFolderId up to the root', () => {
  const paths = buildFolderPaths(mailFolders);
  assert.equal(paths.get('AAMkLhs'), 'Inbox/Clients/HCG');
  assert.equal(paths.get('AAMkSent'), 'Sent Items');
  assert.equal(paths.get('AAMkHidden'), 'Conversation History');
});

// ---------------------------------------------------------------------------------------
// Mail
// ---------------------------------------------------------------------------------------

test('normaliseMailMessage maps a received message with attachments', () => {
  const r = normaliseMailMessage(mail, { id: 'AAMkLhs', path: 'Inbox/Clients/HCG' }, ctx);
  assert.deepEqual(r, {
    source: 'msgraph',
    account: ctx.upn,
    container: 'mailbox:owen.hale@partner.example/Inbox/Clients/HCG',
    id: 'AAMkAGI2THVSAAA=',
    ts: '2026-10-06T07:12:33Z',
    author: 'Tess North <tess.north@partner.example>',
    participants: ['Tess North <tess.north@partner.example>', 'Owen Hale <owen.hale@partner.example>', 'Vera Lindqvist <vincent@partner.example>'],
    subject: 'P5 go-live checklist',
    text:
      'Hi Owen,\ncan you confirm the go-live checklist by Thursday? See the sheet (https://contoso.sharepoint.com/sites/P5/Shared%20Documents/checklist.xlsx).\n\nThanks,\nTobin\n[has attachments]',
    permalink: mail.webLink,
    raw_ref: `msgraph:${ctx.tenant_id}/me/messages/AAMkAGI2THVSAAA=`,
  });
});

test('normaliseMailMessage: text body is used verbatim (Prefer: outlook.body-content-type="text"), maxText applies', () => {
  const r = normaliseMailMessage({ ...mail, hasAttachments: false, body: { contentType: 'text', content: 'plain body\r\nline 2' } }, { id: 'x', path: 'Inbox' }, ctx, { maxText: 10 });
  assert.equal(r?.text, 'plain body\n[... truncated 8 chars]');
});

test('normaliseMailMessage skips drafts and @removed; mailTombstone marks deletes', () => {
  assert.equal(normaliseMailMessage({ ...mail, isDraft: true }, { id: 'x', path: 'Drafts' }, ctx), null);
  const removed: RawMailMessage = { id: 'AAMkGone', '@removed': { reason: 'deleted' } };
  assert.equal(normaliseMailMessage(removed, { id: 'x', path: 'Inbox' }, ctx), null);
  assert.deepEqual(mailTombstone(removed, ctx), { source: 'msgraph', account: ctx.upn, id: 'AAMkGone', deleted: true, kind: 'message' });
});

test('normaliseMailMessage falls back to bodyPreview when the body is empty', () => {
  const r = normaliseMailMessage({ ...mail, hasAttachments: false, body: { contentType: 'html', content: '' } }, { id: 'x', path: 'Inbox' }, ctx);
  assert.equal(r?.text, mail.bodyPreview);
});

// ---------------------------------------------------------------------------------------
// Chats
// ---------------------------------------------------------------------------------------

test('chatContainer names 1:1 chats after the other member, groups after the topic', () => {
  assert.equal(chatContainer(oneOnOne, ctx), 'chat:@Alice Example');
  assert.equal(chatContainer(groupChat, ctx), 'chat:group:P5 platform');
  assert.equal(chatContainer({ ...groupChat, topic: null }, ctx), 'chat:group:Alice Example+Bob Builder');
  assert.equal(chatContainer({ ...groupChat, chatType: 'meeting', topic: 'P5 weekly sync' }, ctx), 'chat:meeting:P5 weekly sync');
  // Self-chat: the only member is me.
  assert.equal(chatContainer({ id: 'x', chatType: 'oneOnOne', members: [{ userId: ctx.user_id, displayName: 'Owen' }] }, ctx), 'chat:@me');
});

test('otherMembers excludes me by userId', () => {
  assert.deepEqual(otherMembers(groupChat, ctx), ['Alice Example <alice@partner.example>', 'Bob Builder <bob@partner.example>']);
});

test('normaliseChatMessage flattens Teams HTML, lists attachments, builds the deep link', () => {
  const r = normaliseChatMessage(chatMsg, oneOnOne, ctx);
  assert.deepEqual(r, {
    source: 'msgraph',
    account: ctx.upn,
    container: 'chat:@Alice Example',
    id: '1759737600000',
    ts: '2026-10-06T08:00:00Z',
    author: 'Alice Example <alice@partner.example>',
    participants: ['Alice Example <alice@partner.example>', 'Owen Hale <owen.hale@partner.example>'],
    text: '@Owen Hale can you review the spec today? 🙂\n[image]\n[attachment: spec.docx — https://contoso.sharepoint.com/sites/P5/Shared%20Documents/spec.docx]',
    permalink: teamsChatMessageLink(oneOnOne.id, '1759737600000'),
    raw_ref: `msgraph:${ctx.tenant_id}/chats/${oneOnOne.id}/messages/1759737600000`,
  });
  assert.ok(r!.permalink.startsWith('https://teams.microsoft.com/l/message/19%3A'));
  assert.ok(r!.permalink.endsWith('?context=%7B%22contextType%22%3A%22chat%22%7D'));
});

test('chatMessageText marks soft-deleted and edited messages inline', () => {
  assert.equal(chatMessageText({ ...chatMsg, body: { contentType: 'text', content: '' }, attachments: [], deletedDateTime: '2026-10-06T09:00:00Z' }), '[deleted 2026-10-06T09:00:00Z]');
  assert.equal(chatMessageText({ ...chatMsg, body: { contentType: 'text', content: 'fixed typo' }, attachments: [], lastEditedDateTime: '2026-10-06T09:00:00Z' }), 'fixed typo\n[edited 2026-10-06T09:00:00Z]');
});

test('system/typing messages are not content; app senders are labelled', () => {
  const sys: RawChatMessage = { ...chatMsg, messageType: 'systemEventMessage', body: { contentType: 'html', content: '<systemEventMessage/>' } };
  assert.equal(isContentMessage(sys), false);
  assert.equal(normaliseChatMessage(sys, oneOnOne, ctx), null);
  const bot = normaliseChatMessage({ ...chatMsg, from: { user: null, application: { id: 'app-1', displayName: 'Planner' } } }, groupChat, ctx);
  assert.equal(bot?.author, 'Planner (app)');
});

// ---------------------------------------------------------------------------------------
// Channels
// ---------------------------------------------------------------------------------------

test('normaliseChannelMessage keeps Graph webUrl, subject and mentions for a root post', () => {
  const r = normaliseChannelMessage(channelPost, team, channel, ctx);
  assert.equal(r?.container, 'team:HCG Dev/#p5-platform');
  assert.equal(r?.subject, 'Release window Friday');
  assert.equal(r?.text, 'We deploy Friday 18:00. @Owen owns the rollback plan.');
  assert.deepEqual(r?.participants, ['Tess North', 'Owen Hale']);
  assert.equal(r?.permalink, channelPost.webUrl);
  assert.equal(r?.raw_ref, `msgraph:${ctx.tenant_id}/teams/${team.id}/channels/${channel.id}/messages/1759740000000`);
});

test('normaliseChannelMessage: replies get "re:" subject, reply raw_ref and a synthesised deep link', () => {
  const reply = channelPost.replies![0]!;
  const r = normaliseChannelMessage(reply, team, channel, ctx, channelPost);
  assert.equal(r?.subject, 're: Release window Friday');
  assert.equal(r?.author, 'Owen Hale');
  assert.equal(r?.raw_ref, `msgraph:${ctx.tenant_id}/teams/${team.id}/channels/${channel.id}/messages/1759740000000/replies/1759740600000`);
  const u = new URL(r!.permalink);
  assert.equal(u.pathname, `/l/message/${encodeURIComponent(channel.id)}/1759740600000`);
  assert.equal(u.searchParams.get('groupId'), team.id);
  assert.equal(u.searchParams.get('parentMessageId'), '1759740000000');
  assert.equal(u.searchParams.get('tenantId'), ctx.tenant_id);
  // Parent without subject → first 60 chars of its body.
  const r2 = normaliseChannelMessage(reply, team, channel, ctx, { ...channelPost, subject: null });
  assert.equal(r2?.subject, 're: We deploy Friday 18:00. @Owen owns the rollback plan.');
});

// ---------------------------------------------------------------------------------------
// Calendar
// ---------------------------------------------------------------------------------------

const ownCalendar = { id: 'AAMkAGI2CalAAA=', name: 'Calendar', is_default: true };

test('normaliseEvent maps an occurrence with UTC times, attendees, organizer and the calendar it was read from', () => {
  assert.deepEqual(normaliseEvent(event, ctx, ownCalendar), {
    source: 'msgraph',
    account: ctx.upn,
    id: 'AAMkAGI2EventAAA=',
    calendar: { id: 'AAMkAGI2CalAAA=', name: 'Calendar', is_default: true },
    start: '2026-10-07T09:00:00Z',
    end: '2026-10-07T09:30:00Z',
    title: 'P5 weekly sync',
    attendees: ['Owen Hale <owen.hale@partner.example>', 'Alice Example <alice@partner.example>'],
    organizer: 'Tess North <tess.north@partner.example>',
    link: event.webLink,
  });
  // An item from a calendar shared INTO the mailbox: Graph reports the mailbox owner as organizer,
  // so only the calendar tag tells it apart from an own event.
  const shared = normaliseEvent({ ...event, organizer: { emailAddress: { name: 'Owen Hale', address: ctx.upn } }, attendees: [] }, ctx, { id: 'AAMkShared', name: 'Vera Lindqvist | HCG', is_default: false });
  assert.equal(shared?.organizer, 'Owen Hale <owen.hale@partner.example>');
  assert.deepEqual(shared?.calendar, { id: 'AAMkShared', name: 'Vera Lindqvist | HCG', is_default: false });
});

test('normaliseEvent: cancelled is prefixed, series masters and @removed are skipped, join URL is the fallback link', () => {
  assert.equal(normaliseEvent({ ...event, isCancelled: true }, ctx, ownCalendar)?.title, '[cancelled] P5 weekly sync');
  assert.equal(normaliseEvent({ ...event, type: 'seriesMaster' }, ctx, ownCalendar), null);
  assert.equal(normaliseEvent({ id: 'gone', '@removed': { reason: 'deleted' } }, ctx, ownCalendar), null);
  assert.equal(normaliseEvent({ ...event, webLink: undefined }, ctx, ownCalendar)?.link, event.onlineMeeting!.joinUrl);
  assert.equal(normaliseEvent({ ...event, subject: '' }, ctx, ownCalendar)?.title, '(no subject)');
});

// ---------------------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------------------

test('normaliseDriveItem maps a SharePoint document with a decoded folder path', () => {
  assert.deepEqual(normaliseDriveItem(driveFile, drive, ctx), {
    source: 'msgraph',
    account: ctx.upn,
    id: `${drive.driveId}:01BYE5RZ6QN3ZWBTUFOFD3GSPGOHDJD36K`,
    name: 'spec.docx',
    path: 'site:P5 Platform/Documents:/Projects/P5 Platform/spec.docx',
    mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    modified: '2026-10-05T16:45:12Z',
    size: 48213,
    link: driveFile.webUrl,
  });
});

test('driveItemPath: items at the root and OneDrive labels', () => {
  const od = { driveId: 'b!od', label: 'onedrive' };
  assert.equal(driveItemPath({ id: 'i', name: 'notes.md', parentReference: { driveId: 'b!od', path: '/drive/root:' } }, od), 'onedrive:/notes.md');
});

test('normaliseDriveItem skips folders, the root item and deleted items; tombstones carry the composite id', () => {
  assert.equal(normaliseDriveItem({ id: 'f', name: 'Projects', folder: { childCount: 2 }, parentReference: { driveId: drive.driveId, path: '/drives/x/root:' } }, drive, ctx), null);
  assert.equal(normaliseDriveItem({ id: 'r', name: 'root', root: {}, folder: { childCount: 9 } }, drive, ctx), null);
  const gone: RawDriveItem = { id: 'g', name: 'old.xlsx', deleted: { state: 'deleted' }, parentReference: { driveId: drive.driveId } };
  assert.equal(isDeletedDriveItem(gone), true);
  assert.equal(normaliseDriveItem(gone, drive, ctx), null);
  assert.deepEqual(fileTombstone(gone, drive, ctx), { source: 'msgraph', account: ctx.upn, id: `${drive.driveId}:g`, deleted: true, kind: 'file' });
  // OneNote notebooks are packages, not folders — keep them.
  const nb = normaliseDriveItem({ id: 'n', name: 'Notebook', package: { type: 'oneNote' }, folder: { childCount: 1 }, parentReference: { driveId: drive.driveId, path: '/drives/x/root:' } }, drive, ctx);
  assert.equal(nb?.mime, 'application/x-oneNote');
});
