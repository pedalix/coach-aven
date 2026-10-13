/**
 * Pure mapping from raw Microsoft Graph JSON to the source record shapes (docs/sources.md).
 *
 * Why a separate module: everything here is testable without a token, so `pull.ts` stays a
 * thin loop of "page, map, append, advance cursor". The raw shapes follow the resource docs
 * (only the fields we read are typed; everything else is `unknown` by omission):
 *   - message      https://learn.microsoft.com/en-us/graph/api/resources/message
 *   - mailFolder   https://learn.microsoft.com/en-us/graph/api/resources/mailfolder
 *   - chat         https://learn.microsoft.com/en-us/graph/api/resources/chat
 *   - chatMessage  https://learn.microsoft.com/en-us/graph/api/resources/chatmessage
 *   - event        https://learn.microsoft.com/en-us/graph/api/resources/event
 *   - driveItem    https://learn.microsoft.com/en-us/graph/api/resources/driveitem
 *   - team/channel https://learn.microsoft.com/en-us/graph/api/resources/team ,
 *                  https://learn.microsoft.com/en-us/graph/api/resources/channel
 *   - Teams deep links
 *                  https://learn.microsoft.com/en-us/microsoftteams/platform/concepts/build-and-test/deep-link-teams
 *
 * No SDK on purpose: the sandbox runs with built-ins + fetch only, and the handful of
 * resources we touch are small enough that hand-written types beat the Graph SDK + Kiota.
 *
 * The three things that bite when deriving commitments from Teams, and which this module
 * handles explicitly (see the plan's risk list): bodies are HTML with Teams-specific markup
 * (`<at>`, `<attachment>`, `<emoji>`, hosted-content `<img>`), deletes are SOFT
 * (`deletedDateTime` set, body blanked), and edits only bump `lastEditedDateTime` on the same
 * message id. Records for the same `id` can therefore be emitted more than once; consumers
 * keep the LAST line per `id`.
 */

// ---------------------------------------------------------------------------------------
// Output shapes (shared contract with the other connectors — keep field names identical).
// ---------------------------------------------------------------------------------------

export interface MessageRecord {
  source: 'msgraph';
  /** The signed-in user's UPN (`owen.hale@example.com`); tenant lives in `raw_ref`. */
  account: string;
  /** `mailbox:<upn>/<Folder/Path>`, `chat:@name`, `chat:group:<topic>`, `chat:meeting:<topic>`, `team:<Team>/#<Channel>`. */
  container: string;
  /** Graph id of the item. Mail ids are opaque base64 (and change when a message moves folder). */
  id: string;
  /** ISO-8601 UTC. Mail: `receivedDateTime`; Teams: `createdDateTime`. */
  ts: string;
  /** `Name <address>` when both are known, else the display name, else the raw id. */
  author: string;
  /** Author + recipients (mail) / chat members (chats) / author + mentions (channels). De-duplicated. */
  participants: string[];
  /** Mail subject; channel post subject; `re: ...` for channel replies. Chats have none. */
  subject?: string;
  /** Plain text. HTML bodies are flattened; soft-deletes/edits are marked inline. */
  text: string;
  permalink: string;
  /** `msgraph:<tenant>/<graph path>` — enough to re-fetch the raw object with a delegated token. */
  raw_ref: string;
}

export interface FileRecord {
  source: 'msgraph';
  account: string;
  /** `<driveId>:<itemId>` — item ids are only unique within a drive. */
  id: string;
  name: string;
  /** `<drive label>:/Folder/Sub/name.ext` — drive label is `onedrive`, `site:<Site>/<Library>` or `team:<Team>/<Library>`. */
  path: string;
  mime: string;
  modified: string;
  size: number;
  /** `webUrl` — opens in the browser with Owen's own SSO, no token needed. */
  link: string;
}

/**
 * Which calendar an event was read from. Graph reports `organizer` = the mailbox owner for
 * every item in a calendar shared INTO the mailbox (a colleague's calendar, holidays, birthdays),
 * so ownership cannot be told from organizer/attendees — only from the calendar id at pull time.
 * `is_default` marks the account's own calendar.
 */
export interface CalendarInfo {
  id: string;
  name: string;
  is_default: boolean;
}

export interface CalendarRecord {
  source: 'msgraph';
  account: string;
  id: string;
  calendar: CalendarInfo;
  start: string;
  end: string;
  title: string;
  attendees: string[];
  organizer: string;
  link: string;
}

/** Tombstone for items the delta feed reports as gone; consumers drop the id. */
export interface Tombstone {
  source: 'msgraph';
  account: string;
  id: string;
  deleted: true;
  kind: 'message' | 'file' | 'calendar';
}

// ---------------------------------------------------------------------------------------
// Context — who we are pulling as. Filled by pull.ts from GET /me and the token store.
// ---------------------------------------------------------------------------------------

export interface AccountContext {
  tenant_id: string;
  upn: string;
  /** Entra object id of the user — needed to tell "me" from "them" in chat member lists. */
  user_id: string;
  display_name?: string;
}

// ---------------------------------------------------------------------------------------
// Raw Graph shapes — only the fields we read.
// ---------------------------------------------------------------------------------------

export interface RawEmailAddress {
  name?: string;
  address?: string;
}
export interface RawRecipient {
  emailAddress?: RawEmailAddress;
}
export interface RawItemBody {
  contentType?: 'text' | 'html' | string;
  content?: string;
}
export interface RawRemoved {
  '@removed'?: { reason?: string };
}

export interface RawMailMessage extends RawRemoved {
  id: string;
  receivedDateTime?: string;
  sentDateTime?: string;
  lastModifiedDateTime?: string;
  subject?: string | null;
  bodyPreview?: string;
  body?: RawItemBody;
  from?: RawRecipient | null;
  sender?: RawRecipient | null;
  toRecipients?: RawRecipient[];
  ccRecipients?: RawRecipient[];
  bccRecipients?: RawRecipient[];
  webLink?: string;
  hasAttachments?: boolean;
  isDraft?: boolean;
  conversationId?: string;
  internetMessageId?: string;
  parentFolderId?: string;
}

export interface RawMailFolder {
  id: string;
  displayName?: string;
  parentFolderId?: string | null;
  childFolderCount?: number;
  totalItemCount?: number;
  isHidden?: boolean;
}

export interface RawIdentity {
  id?: string;
  displayName?: string | null;
  userIdentityType?: string;
  tenantId?: string;
}
export interface RawChatMessageFrom {
  user?: RawIdentity | null;
  application?: RawIdentity | null;
  device?: RawIdentity | null;
}
export interface RawAttachment {
  id?: string;
  contentType?: string;
  contentUrl?: string | null;
  name?: string | null;
}
export interface RawMention {
  id?: number;
  mentionText?: string;
  mentioned?: { user?: RawIdentity | null; application?: RawIdentity | null; conversation?: RawIdentity | null } | null;
}
export interface RawChatMessage {
  id: string;
  replyToId?: string | null;
  messageType?: 'message' | 'systemEventMessage' | 'chatEvent' | 'typing' | 'unknownFutureValue' | string;
  createdDateTime: string;
  lastModifiedDateTime?: string;
  lastEditedDateTime?: string | null;
  deletedDateTime?: string | null;
  subject?: string | null;
  summary?: string | null;
  chatId?: string | null;
  webUrl?: string | null;
  channelIdentity?: { teamId?: string; channelId?: string } | null;
  from?: RawChatMessageFrom | null;
  body?: RawItemBody;
  attachments?: RawAttachment[];
  mentions?: RawMention[];
  /** Present when the channel listing used `$expand=replies`. */
  replies?: RawChatMessage[];
}
export interface RawConversationMember {
  id?: string;
  '@odata.type'?: string;
  displayName?: string | null;
  userId?: string | null;
  email?: string | null;
  roles?: string[];
}
export interface RawChat {
  id: string;
  topic?: string | null;
  chatType?: 'oneOnOne' | 'group' | 'meeting' | string;
  createdDateTime?: string;
  lastUpdatedDateTime?: string;
  webUrl?: string | null;
  tenantId?: string;
  members?: RawConversationMember[];
  lastMessagePreview?: { id?: string; createdDateTime?: string; isDeleted?: boolean } | null;
}
export interface RawTeam {
  id: string;
  displayName?: string | null;
  description?: string | null;
  isArchived?: boolean;
  tenantId?: string;
}
export interface RawChannel {
  id: string;
  displayName?: string | null;
  membershipType?: 'standard' | 'private' | 'shared' | string;
  webUrl?: string | null;
}

export interface RawDateTimeTimeZone {
  dateTime: string;
  timeZone?: string;
}
export interface RawAttendee {
  type?: string;
  status?: { response?: string; time?: string };
  emailAddress?: RawEmailAddress;
}
export interface RawEvent extends RawRemoved {
  id: string;
  subject?: string | null;
  bodyPreview?: string;
  body?: RawItemBody;
  start?: RawDateTimeTimeZone;
  end?: RawDateTimeTimeZone;
  isAllDay?: boolean;
  isCancelled?: boolean;
  organizer?: RawRecipient | null;
  attendees?: RawAttendee[];
  webLink?: string;
  onlineMeeting?: { joinUrl?: string } | null;
  location?: { displayName?: string } | null;
  lastModifiedDateTime?: string;
  type?: string;
  seriesMasterId?: string | null;
  responseStatus?: { response?: string };
}

export interface RawDriveItem extends RawRemoved {
  id: string;
  name?: string;
  webUrl?: string;
  size?: number;
  createdDateTime?: string;
  lastModifiedDateTime?: string;
  file?: { mimeType?: string } | null;
  folder?: { childCount?: number } | null;
  package?: { type?: string } | null;
  root?: Record<string, never>;
  deleted?: { state?: string } | null;
  parentReference?: { driveId?: string; driveType?: string; id?: string; path?: string; name?: string; siteId?: string };
  lastModifiedBy?: { user?: { displayName?: string; email?: string } };
}
export interface DriveContext {
  driveId: string;
  /** `onedrive`, `site:<Site display name>/<Library>`, `team:<Team>/<Library>`. */
  label: string;
}

// ---------------------------------------------------------------------------------------
// Small pure helpers
// ---------------------------------------------------------------------------------------

/** Directory-safe form of a UPN: `owen.hale@example.com` → `owen.hale_at_contoso.com`. */
export function accountSlug(upn: string): string {
  return upn.toLowerCase().replace('@', '_at_').replace(/[^a-z0-9._-]+/g, '_');
}

/** `Name <address>` / `Name` / `address` / `id` — whichever is known, most human first. */
export function personLabel(p: { name?: string | null; address?: string | null; id?: string | null } | null | undefined): string {
  if (!p) return 'unknown';
  const name = p.name?.trim();
  const addr = p.address?.trim().toLowerCase();
  if (name && addr && name.toLowerCase() !== addr) return `${name} <${addr}>`;
  return name || addr || p.id || 'unknown';
}

function recipientLabel(r: RawRecipient | null | undefined): string {
  return personLabel(r?.emailAddress);
}

function identityLabel(i: RawIdentity | null | undefined): string {
  return personLabel({ name: i?.displayName ?? undefined, id: i?.id });
}

function memberLabel(m: RawConversationMember): string {
  return personLabel({ name: m.displayName ?? undefined, address: m.email ?? undefined, id: m.userId ?? m.id });
}

/**
 * De-duplicate people labels by NAME: chat members arrive as `Name <email>` while mentions
 * arrive as bare `Name` (Teams identities carry no email), and both describe one person.
 * The richer label (with address) wins whichever order they come in.
 */
function uniq(xs: Array<string | undefined>): string[] {
  const out: string[] = [];
  const keyOf = (l: string) => l.replace(/ <[^>]+>$/, '').toLowerCase();
  for (const x of xs) {
    if (!x || x === 'unknown') continue;
    const k = keyOf(x);
    const i = out.findIndex((o) => keyOf(o) === k);
    if (i < 0) out.push(x);
    else if (x.includes(' <') && !out[i]!.includes(' <')) out[i] = x;
  }
  return out;
}

/**
 * Graph `dateTimeTimeZone` → ISO-8601. Graph emits 7 fractional digits
 * (`2026-10-07T09:00:00.0000000`) and a SEPARATE `timeZone` field. pull.ts asks for
 * `Prefer: outlook.timezone="UTC"`, so the normal path is: trim to milliseconds, append `Z`.
 * Anything else (a Windows zone name like `W. Europe Standard Time` cannot be converted
 * without a mapping table) is passed through as a floating local time with the zone in
 * brackets — visibly non-UTC rather than silently wrong.
 */
export function graphDateTimeToIso(dt: RawDateTimeTimeZone | undefined): string {
  if (!dt?.dateTime) return '';
  const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})?$/.exec(dt.dateTime);
  if (!m) return dt.dateTime;
  const base = m[1];
  const frac = (m[2] ?? '').padEnd(3, '0').slice(0, 3);
  const withMs = frac === '000' ? base : `${base}.${frac}`;
  if (m[3]) return `${withMs}${m[3] === 'Z' ? 'Z' : m[3]}`;
  const tz = (dt.timeZone ?? 'UTC').trim();
  if (/^(utc|z)$/i.test(tz)) return `${withMs}Z`;
  return `${withMs}[${tz}]`;
}

/** Graph timestamps are already ISO/UTC; this just defends against the 7-digit form. */
export function isoTs(s: string | undefined | null): string {
  if (!s) return '';
  return graphDateTimeToIso({ dateTime: s, timeZone: 'UTC' });
}

const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…',
  laquo: '«', raquo: '»', ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’', copy: '©', eacute: 'é', uuml: 'ü',
  ouml: 'ö', auml: 'ä', szlig: 'ß',
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, ent: string) => {
    if (ent[0] === '#') {
      const code = ent[1]?.toLowerCase() === 'x' ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10);
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[ent.toLowerCase()] ?? whole;
  });
}

/**
 * HTML → readable plain text. Deliberately small: enough for Outlook bodies (tables, divs,
 * quoted replies, `<style>` blocks) and Teams bodies (`<at>`, `<attachment>`, `<emoji>`,
 * hosted-content `<img>`). Not a renderer; the goal is that an LLM reading the line sees
 * what a human saw in the client, mentions included.
 */
export function htmlToText(html: string): string {
  let s = html;
  // Drop invisible blocks wholesale (mail bodies carry big <style> sheets and <head>s).
  s = s.replace(/<(style|script|head|title)\b[^>]*>[\s\S]*?<\/\1>/gi, '');
  s = s.replace(/<!--[\s\S]*?-->/g, '');
  // Teams markup first, while the tags are still intact.
  s = s.replace(/<at\b[^>]*>([\s\S]*?)<\/at>/gi, '@$1');
  s = s.replace(/<emoji\b[^>]*\balt="([^"]*)"[^>]*>(?:<\/emoji>)?/gi, '$1');
  s = s.replace(/<attachment\b[^>]*>[\s\S]*?<\/attachment>/gi, '');
  s = s.replace(/<attachment\b[^>]*\/?>/gi, '');
  s = s.replace(/<img\b[^>]*>/gi, '[image]');
  // Links: keep the label and the target when they differ (commitments often live behind "this ticket").
  s = s.replace(/<a\b[^>]*\bhref="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_m, href: string, label: string) => {
    const l = label.replace(/<[^>]+>/g, '').trim();
    const h = decodeEntities(href).trim();
    if (!l) return h;
    if (!h || l === h || h.startsWith('mailto:')) return l;
    return `${l} (${h})`;
  });
  // Block boundaries → newlines; list items → bullets; cells → tabs.
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<li\b[^>]*>/gi, '- ');
  // Only CLOSING block tags break lines: `<p>a</p><p>b</p>` → "a\nb", while `<br>` between
  // blocks (how Outlook spells a blank line) still yields a paragraph gap.
  s = s.replace(/<\/(p|div|li|tr|h[1-6]|blockquote|pre|table|ul|ol)>/gi, '\n');
  s = s.replace(/<\/t[dh]>/gi, '\t');
  s = s.replace(/<[^>]+>/g, '');
  s = decodeEntities(s);
  // Whitespace: collapse runs but keep paragraph breaks.
  s = s.replace(/ /g, ' ');
  s = s
    .split('\n')
    .map((line) => line.replace(/ {2,}/g, ' ').replace(/ ?\t ?/g, '\t').trim())
    .join('\n');
  s = s.replace(/\n{3,}/g, '\n\n').trim();
  return s;
}

/** Body → plain text whichever content type Graph sent; falls back to the preview. */
export function bodyText(body: RawItemBody | undefined, preview?: string): string {
  const content = body?.content ?? '';
  if (!content.trim()) return (preview ?? '').trim();
  return body?.contentType?.toLowerCase() === 'html' ? htmlToText(content) : content.trim();
}

export function truncate(s: string, max: number): string {
  if (max <= 0 || s.length <= max) return s;
  return `${s.slice(0, max)}\n[... truncated ${s.length - max} chars]`;
}

/**
 * Mail folder tree → `id → "Inbox/Clients/HCG"` paths. Graph only gives `parentFolderId`,
 * so paths are rebuilt by walking up; the walk is bounded to defend against cycles in
 * broken fixtures. Hidden folders keep their names — they still hold mail.
 */
export function buildFolderPaths(folders: RawMailFolder[]): Map<string, string> {
  const byId = new Map(folders.map((f) => [f.id, f]));
  const out = new Map<string, string>();
  for (const f of folders) {
    const parts: string[] = [];
    let cur: RawMailFolder | undefined = f;
    for (let i = 0; cur && i < 32; i++) {
      parts.unshift(cur.displayName?.trim() || cur.id);
      cur = cur.parentFolderId ? byId.get(cur.parentFolderId) : undefined;
    }
    out.set(f.id, parts.join('/'));
  }
  return out;
}

// ---------------------------------------------------------------------------------------
// Mail
// ---------------------------------------------------------------------------------------

export interface MailFolderInfo {
  id: string;
  /** `Inbox/Clients/HCG` */
  path: string;
}

export interface NormaliseOptions {
  /** Cap on `text` length (0 = unlimited). Mail bodies with quoted threads run to 100s of KB. */
  maxText?: number;
}

export function mailTombstone(raw: RawMailMessage, ctx: AccountContext): Tombstone {
  return { source: 'msgraph', account: ctx.upn, id: raw.id, deleted: true, kind: 'message' };
}

/**
 * Drafts are skipped (nothing was said yet). `@removed` entries are handled by the caller
 * via `mailTombstone`. `receivedDateTime` is the timeline anchor for both inbound and sent
 * mail (Exchange stamps it on sent items too, equal to the send time).
 */
export function normaliseMailMessage(
  raw: RawMailMessage,
  folder: MailFolderInfo,
  ctx: AccountContext,
  opts: NormaliseOptions = {},
): MessageRecord | null {
  if (raw['@removed'] || raw.isDraft) return null;
  const from = raw.from ?? raw.sender;
  const author = recipientLabel(from);
  const participants = uniq([
    author,
    ...(raw.toRecipients ?? []).map(recipientLabel),
    ...(raw.ccRecipients ?? []).map(recipientLabel),
    ...(raw.bccRecipients ?? []).map(recipientLabel),
  ]);
  let text = bodyText(raw.body, raw.bodyPreview);
  if (raw.hasAttachments) text = `${text}\n[has attachments]`.trim();
  return {
    source: 'msgraph',
    account: ctx.upn,
    container: `mailbox:${ctx.upn}/${folder.path}`,
    id: raw.id,
    ts: isoTs(raw.receivedDateTime ?? raw.sentDateTime),
    author,
    participants,
    subject: raw.subject?.trim() || undefined,
    text: truncate(text, opts.maxText ?? 0),
    permalink: raw.webLink ?? '',
    raw_ref: `msgraph:${ctx.tenant_id}/me/messages/${raw.id}`,
  };
}

// ---------------------------------------------------------------------------------------
// Teams chats
// ---------------------------------------------------------------------------------------

/** Members other than me, as labels. `$expand=members` returns at most 25 — fine for labels. */
export function otherMembers(chat: RawChat, ctx: AccountContext): string[] {
  return uniq((chat.members ?? []).filter((m) => m.userId !== ctx.user_id).map(memberLabel));
}

/**
 * Human container name. Teams has no stable "chat name": 1:1 chats are named after the
 * other person, group chats after their topic (or the members when untitled), meeting
 * chats after the meeting. The chat id lives in `raw_ref` for anything programmatic.
 */
export function chatContainer(chat: RawChat, ctx: AccountContext): string {
  const others = otherMembers(chat, ctx).map((l) => l.replace(/ <[^>]+>$/, ''));
  const topic = chat.topic?.trim();
  switch (chat.chatType) {
    case 'oneOnOne':
      return `chat:@${others[0] ?? (chat.members?.length ? 'me' : chat.id)}`;
    case 'meeting':
      return `chat:meeting:${topic || others.join('+') || chat.id}`;
    default:
      return `chat:group:${topic || others.join('+') || chat.id}`;
  }
}

/** Deep link to a chat message (the `webUrl` property is null on chat messages). */
export function teamsChatMessageLink(chatId: string, messageId: string): string {
  const ctx = encodeURIComponent(JSON.stringify({ contextType: 'chat' }));
  return `https://teams.microsoft.com/l/message/${encodeURIComponent(chatId)}/${messageId}?context=${ctx}`;
}

/** Deep link to a channel post or reply; mirrors the `webUrl` Graph puts on channel messages. */
export function teamsChannelMessageLink(p: {
  tenantId: string;
  teamId: string;
  channelId: string;
  messageId: string;
  parentMessageId?: string | null;
  teamName?: string | null;
  channelName?: string | null;
}): string {
  const q = new URLSearchParams();
  q.set('tenantId', p.tenantId);
  q.set('groupId', p.teamId);
  q.set('parentMessageId', p.parentMessageId || p.messageId);
  if (p.teamName) q.set('teamName', p.teamName);
  if (p.channelName) q.set('channelName', p.channelName);
  q.set('createdTime', p.messageId);
  return `https://teams.microsoft.com/l/message/${encodeURIComponent(p.channelId)}/${p.messageId}?${q.toString()}`;
}

/** Sender label; when the sender is a chat member we know their email from the member list. */
function chatMessageAuthor(raw: RawChatMessage, members: RawConversationMember[] = []): string {
  const f = raw.from;
  if (f?.user) {
    const m = f.user.id ? members.find((x) => x.userId === f.user!.id) : undefined;
    return m ? memberLabel(m) : identityLabel(f.user);
  }
  if (f?.application) return `${f.application.displayName ?? f.application.id ?? 'app'} (app)`;
  if (f?.device) return `${f.device.displayName ?? 'device'} (device)`;
  return 'system';
}

function mentionLabels(raw: RawChatMessage): string[] {
  return (raw.mentions ?? [])
    .map((m) => (m.mentioned?.user ? identityLabel(m.mentioned.user) : m.mentioned?.application ? `${m.mentioned.application.displayName ?? 'app'} (app)` : undefined))
    .filter((x): x is string => !!x);
}

/**
 * The text an LLM should see for a chat/channel message: flattened body, then attachment
 * references (file cards are `attachments[]` with a SharePoint `contentUrl`, NOT in the body),
 * then soft-delete / edit markers. Deleted messages keep their (blanked) record so the
 * consumer can retract a commitment derived from an earlier version of the same id.
 */
export function chatMessageText(raw: RawChatMessage, opts: NormaliseOptions = {}): string {
  const parts: string[] = [];
  const body = bodyText(raw.body, raw.summary ?? undefined);
  if (body) parts.push(body);
  for (const a of raw.attachments ?? []) {
    const name = a.name?.trim();
    const url = a.contentUrl?.trim();
    if (!name && !url) continue; // adaptive cards etc. with inline content only
    parts.push(`[attachment: ${name ?? ''}${name && url ? ' — ' : ''}${url ?? ''}]`);
  }
  if (raw.deletedDateTime) parts.push(`[deleted ${isoTs(raw.deletedDateTime)}]`);
  else if (raw.lastEditedDateTime) parts.push(`[edited ${isoTs(raw.lastEditedDateTime)}]`);
  return truncate(parts.join('\n').trim(), opts.maxText ?? 0);
}

/** True for the message types worth keeping: real messages, not typing/system/membership events. */
export function isContentMessage(raw: RawChatMessage): boolean {
  return (raw.messageType ?? 'message') === 'message';
}

export function normaliseChatMessage(raw: RawChatMessage, chat: RawChat, ctx: AccountContext, opts: NormaliseOptions = {}): MessageRecord | null {
  if (!isContentMessage(raw)) return null;
  const author = chatMessageAuthor(raw, chat.members);
  const members = (chat.members ?? []).map(memberLabel);
  return {
    source: 'msgraph',
    account: ctx.upn,
    container: chatContainer(chat, ctx),
    id: raw.id,
    ts: isoTs(raw.createdDateTime),
    author,
    participants: uniq([author, ...members, ...mentionLabels(raw)]),
    text: chatMessageText(raw, opts),
    permalink: raw.webUrl || teamsChatMessageLink(chat.id, raw.id),
    raw_ref: `msgraph:${ctx.tenant_id}/chats/${chat.id}/messages/${raw.id}`,
  };
}

// ---------------------------------------------------------------------------------------
// Teams channels
// ---------------------------------------------------------------------------------------

export function channelContainer(team: RawTeam, channel: RawChannel): string {
  return `team:${team.displayName?.trim() || team.id}/#${channel.displayName?.trim() || channel.id}`;
}

/**
 * Channel posts carry an optional `subject`; replies inherit `re: <parent subject or first
 * 60 chars>` so a reply line is self-describing without the parent. `parent` is the root
 * post when `raw` came from `$expand=replies` or the `/replies` endpoint.
 */
export function normaliseChannelMessage(
  raw: RawChatMessage,
  team: RawTeam,
  channel: RawChannel,
  ctx: AccountContext,
  parent?: RawChatMessage,
  opts: NormaliseOptions = {},
): MessageRecord | null {
  if (!isContentMessage(raw)) return null;
  const author = chatMessageAuthor(raw);
  let subject = raw.subject?.trim() || undefined;
  if (!subject && parent) {
    const head = parent.subject?.trim() || bodyText(parent.body, parent.summary ?? undefined).split('\n')[0] || '';
    if (head) subject = `re: ${head.length > 60 ? `${head.slice(0, 60)}…` : head}`;
  }
  const parentId = raw.replyToId || parent?.id || null;
  const permalink =
    raw.webUrl ||
    teamsChannelMessageLink({
      tenantId: ctx.tenant_id,
      teamId: team.id,
      channelId: channel.id,
      messageId: raw.id,
      parentMessageId: parentId,
      teamName: team.displayName,
      channelName: channel.displayName,
    });
  const rawPath = parentId && parentId !== raw.id
    ? `teams/${team.id}/channels/${channel.id}/messages/${parentId}/replies/${raw.id}`
    : `teams/${team.id}/channels/${channel.id}/messages/${raw.id}`;
  return {
    source: 'msgraph',
    account: ctx.upn,
    container: channelContainer(team, channel),
    id: raw.id,
    ts: isoTs(raw.createdDateTime),
    author,
    participants: uniq([author, ...mentionLabels(raw)]),
    subject,
    text: chatMessageText(raw, opts),
    permalink,
    raw_ref: `msgraph:${ctx.tenant_id}/${rawPath}`,
  };
}

// ---------------------------------------------------------------------------------------
// Calendar
// ---------------------------------------------------------------------------------------

export function eventTombstone(raw: RawEvent, ctx: AccountContext): Tombstone {
  return { source: 'msgraph', account: ctx.upn, id: raw.id, deleted: true, kind: 'calendar' };
}

/**
 * calendarView already expands recurring series into occurrences, so every record is one
 * concrete slot. Cancelled events are kept with a `[cancelled]` prefix (the slot was
 * promised once; the consumer decides). Series masters are skipped — they have no concrete
 * time and the occurrences carry the same subject/attendees. `calendar` is required: both
 * branches of the pull (primary delta, secondary window poll) know which calendar they read.
 */
export function normaliseEvent(raw: RawEvent, ctx: AccountContext, calendar: CalendarInfo): CalendarRecord | null {
  if (raw['@removed'] || raw.type === 'seriesMaster') return null;
  const title = `${raw.isCancelled ? '[cancelled] ' : ''}${raw.subject?.trim() || '(no subject)'}`;
  return {
    source: 'msgraph',
    account: ctx.upn,
    id: raw.id,
    calendar: { id: calendar.id, name: calendar.name, is_default: calendar.is_default },
    start: graphDateTimeToIso(raw.start),
    end: graphDateTimeToIso(raw.end),
    title,
    attendees: uniq((raw.attendees ?? []).map((a) => recipientLabel(a))),
    organizer: recipientLabel(raw.organizer),
    link: raw.webLink || raw.onlineMeeting?.joinUrl || '',
  };
}

// ---------------------------------------------------------------------------------------
// Files (OneDrive / SharePoint drives via delta)
// ---------------------------------------------------------------------------------------

export function isDeletedDriveItem(raw: RawDriveItem): boolean {
  return !!raw['@removed'] || !!raw.deleted;
}

export function fileTombstone(raw: RawDriveItem, drive: DriveContext, ctx: AccountContext): Tombstone {
  return { source: 'msgraph', account: ctx.upn, id: `${drive.driveId}:${raw.id}`, deleted: true, kind: 'file' };
}

/**
 * `parentReference.path` is `/drives/<id>/root:/Folder/Sub` (URL-encoded); we keep only the
 * part after `root:` so the record path is `<drive label>:/Folder/Sub/name`. Folders and the
 * root are skipped (consumers want documents); OneNote packages count as files.
 */
export function driveItemPath(raw: RawDriveItem, drive: DriveContext): string {
  const p = raw.parentReference?.path ?? '';
  const idx = p.indexOf('root:');
  let folder = idx >= 0 ? p.slice(idx + 'root:'.length) : '';
  try {
    folder = decodeURIComponent(folder);
  } catch {
    /* keep encoded */
  }
  const name = raw.name ?? raw.id;
  return `${drive.label}:${folder.replace(/\/+$/, '')}/${name}`;
}

export function normaliseDriveItem(raw: RawDriveItem, drive: DriveContext, ctx: AccountContext): FileRecord | null {
  if (isDeletedDriveItem(raw) || raw.root || (raw.folder && !raw.file && !raw.package)) return null;
  return {
    source: 'msgraph',
    account: ctx.upn,
    id: `${drive.driveId}:${raw.id}`,
    name: raw.name ?? raw.id,
    path: driveItemPath(raw, drive),
    mime: raw.file?.mimeType ?? (raw.package ? `application/x-${raw.package.type ?? 'package'}` : 'application/octet-stream'),
    modified: isoTs(raw.lastModifiedDateTime ?? raw.createdDateTime),
    size: raw.size ?? 0,
    link: raw.webUrl ?? '',
  };
}
