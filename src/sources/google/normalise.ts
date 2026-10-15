/**
 * Pure mapping from raw Google API JSON (Gmail, Drive, Calendar) to the source record shapes (docs/sources.md).
 *
 * Why a separate module: everything here is testable without a token, so `pull.ts` stays a thin
 * loop of "page, map, append, advance cursor". The fixtures in `normalise.test.ts` follow the field
 * names in the REST references:
 *   Gmail    https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages
 *   Drive    https://developers.google.com/workspace/drive/api/reference/rest/v3/files
 *            https://developers.google.com/workspace/drive/api/reference/rest/v3/changes
 *   Calendar https://developers.google.com/workspace/calendar/api/v3/reference/events
 *
 * No SDK on purpose: the sandbox runs with Node built-ins + fetch only, and the slices of these
 * resources we read are small enough that hand-written types beat googleapis' 100 MB dependency.
 *
 * Identity convention: `author`, `participants`, `attendees`, `organizer` are lower-cased e-mail
 * addresses, never display names. E-mail is the only key that joins Gmail, Calendar, Teams/Outlook
 * and Slack profiles; display names drift ("North, Tess" vs "Tess North").
 */

// ---------------------------------------------------------------------------------------
// Output shapes (shared contract with the other connectors — keep field names identical).
// `deleted: true` is the one extension: Gmail history, Drive changes and Calendar sync all
// report removals, and a downstream ledger must be able to retract. A tombstone carries only
// identity fields; every other field is empty.
// ---------------------------------------------------------------------------------------

export interface MessageRecord {
  source: 'gmail';
  /** The mailbox address (`owen@home.example`) — also the key in the token store. */
  account: string;
  /** Mailbox folder derived from system labels: inbox | sent | draft | trash | spam | chat | archive. */
  container: string;
  /** Gmail message id (hex). Stable for the life of the message; threads live in `raw_ref`. */
  id: string;
  /** ISO-8601 UTC from `internalDate` (Gmail's own receive time, not the forgeable Date header). */
  ts: string;
  /** Sender e-mail, lower-cased. */
  author: string;
  /** Sender + To + Cc + Bcc (Bcc only on own sent mail), lower-cased, de-duplicated, in that order. */
  participants: string[];
  subject?: string;
  /** text/plain body if present, else text/html flattened, else the snippet. */
  text: string;
  permalink: string;
  /** `gmail:<account>/<threadId>/<messageId>` — enough to re-fetch the raw object. */
  raw_ref: string;
  deleted?: true;
}

export interface FileRecord {
  source: 'gdrive';
  account: string;
  id: string;
  name: string;
  /** `My Drive/a/b/name`, `Shared drives/<drive>/a/name`, or `Shared with me/…/name` (see `drivePath`). */
  path: string;
  mime: string;
  modified: string;
  /** Bytes; 0 for Google-native files (Docs/Sheets/Slides have no `size`). */
  size: number;
  link: string;
  deleted?: true;
}

export interface EventRecord {
  source: 'gcal';
  account: string;
  /** Google event id. The same invite appears in every attendee's calendar under the same id, hence `calendar`. */
  id: string;
  /** Which calendar this copy came from — needed to re-fetch and to tell "my copy" from a shared colleague's. */
  calendar: string;
  /** RFC3339 with offset for timed events, `YYYY-MM-DD` for all-day events (Google's own two encodings). */
  start: string;
  end: string;
  title: string;
  attendees: string[];
  organizer: string;
  link: string;
  deleted?: true;
}

// ---------------------------------------------------------------------------------------
// Gmail
// ---------------------------------------------------------------------------------------

export interface RawGmailHeader { name: string; value: string }
export interface RawGmailBody { attachmentId?: string; size?: number; data?: string }
export interface RawGmailPart {
  partId?: string;
  mimeType?: string;
  filename?: string;
  headers?: RawGmailHeader[];
  body?: RawGmailBody;
  parts?: RawGmailPart[];
}
/** `users.messages.get?format=full` — only the fields we read. */
export interface RawGmailMessage {
  id: string;
  threadId: string;
  labelIds?: string[];
  snippet?: string;
  historyId?: string;
  /** Epoch milliseconds as a string (int64 in JSON). */
  internalDate?: string;
  payload?: RawGmailPart;
  sizeEstimate?: number;
}

/**
 * One folder per message, by system label precedence. Gmail has labels, not folders, but for a
 * commitments ledger the question is only "did I send it, was it addressed to me, or is it noise".
 * SENT wins over INBOX because a reply you sent in a thread you also received carries both.
 */
export function gmailContainer(labelIds: readonly string[] = []): string {
  const has = (l: string) => labelIds.includes(l);
  if (has('SENT')) return 'sent';
  if (has('DRAFT')) return 'draft';
  if (has('TRASH')) return 'trash';
  if (has('SPAM')) return 'spam';
  if (has('CHAT')) return 'chat';
  if (has('INBOX')) return 'inbox';
  return 'archive';
}

/**
 * Pull every address out of an RFC 5322 address-list header. We deliberately do not parse the
 * grammar (quoted display names may contain commas and angle brackets); extracting the mailbox
 * tokens with a regex is what every mail client ends up doing for the "who" question anyway.
 */
export function parseAddresses(header: string | undefined): string[] {
  if (!header) return [];
  const found = header.match(/[A-Za-z0-9._%+'=-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g) ?? [];
  return [...new Set(found.map((a) => a.toLowerCase()))];
}

export function header(part: RawGmailPart | undefined, name: string): string | undefined {
  const want = name.toLowerCase();
  return part?.headers?.find((h) => h.name.toLowerCase() === want)?.value;
}

/** Charset from a part's own Content-Type header; Gmail returns bodies as the original bytes, base64url-encoded. */
function partCharset(part: RawGmailPart): string {
  const ct = header(part, 'Content-Type') ?? '';
  const m = /charset="?([A-Za-z0-9_.:-]+)"?/i.exec(ct);
  return m?.[1] ?? 'utf-8';
}

export function decodeBody(part: RawGmailPart): string {
  const data = part.body?.data;
  if (!data) return '';
  const bytes = Buffer.from(data, 'base64url');
  try {
    return new TextDecoder(partCharset(part)).decode(bytes);
  } catch {
    // Unknown/misspelled charset label → utf-8 is the least-wrong guess.
    return bytes.toString('utf8');
  }
}

/**
 * Minimal HTML → text: enough that an HTML-only mail (Outlook, newsletters) yields readable
 * paragraphs. Not a renderer; block elements become newlines, everything else is stripped.
 */
export function htmlToText(html: string): string {
  const entities: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  return html
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<br\s*\/?>/gi, '\n')
    // Both the opening and the closing tag of a block element break the line: `<p>a</p><p>b</p>`
    // becomes a blank-line-separated paragraph pair, and `text<p>para` does not glue together.
    .replace(/<\/?(p|div|tr|li|h[1-6]|blockquote|pre|table)(\s[^>]*)?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e: string) => {
      if (e[0] === '#') {
        const code = e[1]?.toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(code) ? String.fromCodePoint(code) : m;
      }
      return entities[e.toLowerCase()] ?? m;
    })
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Walk the MIME tree depth-first and pick the first text/plain leaf; fall back to the first
 * text/html leaf flattened. Attachments (parts with a filename / attachmentId) are never bodies.
 * Multipart containers (`multipart/alternative`, `multipart/mixed`) only recurse.
 */
export function extractText(payload: RawGmailPart | undefined): string {
  if (!payload) return '';
  let plain: string | undefined;
  let html: string | undefined;
  const walk = (p: RawGmailPart) => {
    if (plain !== undefined) return;
    const mime = (p.mimeType ?? '').toLowerCase();
    if (p.parts?.length) {
      for (const c of p.parts) walk(c);
      return;
    }
    if (p.filename || p.body?.attachmentId) return;
    if (mime === 'text/plain') plain = decodeBody(p);
    else if (mime === 'text/html' && html === undefined) html = decodeBody(p);
  };
  walk(payload);
  if (plain !== undefined) return plain.replace(/\r\n/g, '\n').trim();
  if (html !== undefined) return htmlToText(html);
  return '';
}

/** `authuser=<email>` makes the link open in the right Google account regardless of /u/N ordering. */
export function gmailPermalink(account: string, messageId: string): string {
  return `https://mail.google.com/mail/?authuser=${encodeURIComponent(account)}#all/${messageId}`;
}

export function normaliseGmailMessage(raw: RawGmailMessage, account: string): MessageRecord {
  const p = raw.payload;
  const from = parseAddresses(header(p, 'From'));
  const participants = [
    ...from,
    ...parseAddresses(header(p, 'To')),
    ...parseAddresses(header(p, 'Cc')),
    ...parseAddresses(header(p, 'Bcc')),
  ];
  const ms = Number(raw.internalDate);
  // internalDate is the authoritative timestamp; the Date header is sender-set and often wrong by hours.
  const ts = Number.isFinite(ms) && raw.internalDate ? new Date(ms).toISOString() : new Date(0).toISOString();
  const subject = header(p, 'Subject');
  const text = extractText(p) || (raw.snippet ?? '');
  return {
    source: 'gmail',
    account,
    container: gmailContainer(raw.labelIds),
    id: raw.id,
    ts,
    author: from[0] ?? '',
    participants: [...new Set(participants)],
    ...(subject !== undefined ? { subject } : {}),
    text,
    permalink: gmailPermalink(account, raw.id),
    raw_ref: `gmail:${account}/${raw.threadId}/${raw.id}`,
  };
}

/** Tombstone for a `messagesDeleted` history entry. `ts` is when we observed it (Gmail gives no deletion time). */
export function gmailTombstone(id: string, account: string, observedAt: string): MessageRecord {
  return {
    source: 'gmail',
    account,
    container: '',
    id,
    ts: observedAt,
    author: '',
    participants: [],
    text: '',
    permalink: gmailPermalink(account, id),
    raw_ref: `gmail:${account}/?/${id}`,
    deleted: true,
  };
}

// ---------------------------------------------------------------------------------------
// Drive
// ---------------------------------------------------------------------------------------

export interface RawDriveFile {
  id: string;
  name?: string;
  mimeType?: string;
  modifiedTime?: string;
  /** At most one parent since 2020 (multi-parenting was removed); still an array in the API. */
  parents?: string[];
  /** Present only for items in a shared drive. */
  driveId?: string;
  owners?: { emailAddress?: string; displayName?: string }[];
  webViewLink?: string;
  /** int64 as string; absent for Google-native files and folders. */
  size?: string;
  md5Checksum?: string;
  trashed?: boolean;
  shared?: boolean;
}

export interface RawDriveChange {
  changeType?: 'file' | 'drive';
  /** True when the file was deleted OR the user lost access — both mean "no longer visible". */
  removed?: boolean;
  fileId?: string;
  driveId?: string;
  time?: string;
  file?: RawDriveFile;
  drive?: { id?: string; name?: string };
}

/** What `drivePath` needs to know about a folder: its name and its own parent (one hop). */
export interface DriveNode { name: string; parents?: string[]; driveId?: string }

export interface DrivePathContext {
  /** Folder metadata by id, or undefined when the folder is not visible to this account (e.g. the parent of a folder shared with me). */
  lookup: (id: string) => DriveNode | undefined;
  /** Shared drive name by drive id (from `drives.list`). */
  driveName: (driveId: string) => string | undefined;
  /** The id `files.get('root')` reports for this account's My Drive root — its `name` is "My Drive" too, but the id is unambiguous. */
  rootId?: string;
}

/**
 * Build a human path by walking `parents` up to a root we recognise:
 *   - the account's My Drive root id                  → `My Drive/…`
 *   - the shared drive's root (its id == driveId)       → `Shared drives/<drive name>/…`
 *   - a folder whose parent is not visible / absent     → `Shared with me/…`
 * Shared drives are a first-class root here because `includeItemsFromAllDrives` mixes them into
 * the same listing as My Drive, and a path is the only thing that tells a reader which world a
 * file lives in. Loops are impossible in Drive, but we guard anyway (cheap, and a corrupt cache
 * must not hang the puller).
 */
export function drivePath(file: RawDriveFile, ctx: DrivePathContext): string {
  const segs: string[] = [file.name ?? file.id];
  const seen = new Set<string>();
  let parent = file.parents?.[0];
  const sharedDriveRoot = (id: string) =>
    `Shared drives/${ctx.driveName(id) ?? ctx.lookup(id)?.name ?? id}`;
  if (!parent) {
    // No parent at all: a shared drive's root-level file (parents = [driveId]) always has one, so
    // this is either a loose file shared with me, or My Drive root itself.
    return `${file.driveId ? sharedDriveRoot(file.driveId) : 'Shared with me'}/${segs.join('/')}`;
  }
  while (parent && !seen.has(parent)) {
    seen.add(parent);
    if (ctx.rootId && parent === ctx.rootId) return `My Drive/${segs.join('/')}`;
    if (file.driveId && parent === file.driveId) return `${sharedDriveRoot(file.driveId)}/${segs.join('/')}`;
    const node = ctx.lookup(parent);
    if (!node) return `Shared with me/${segs.join('/')}`;
    if (!node.parents?.length) {
      // Top of a visible chain that is neither root: a folder shared with me (My Drive root would
      // have matched `rootId`; a shared-drive root matched `driveId`). Fall back to the name test for
      // callers that did not resolve rootId.
      if (node.name === 'My Drive' && !node.driveId) return `My Drive/${segs.join('/')}`;
      if (node.driveId && parent === node.driveId) return `${sharedDriveRoot(parent)}/${segs.join('/')}`;
      segs.unshift(node.name);
      return `Shared with me/${segs.join('/')}`;
    }
    segs.unshift(node.name);
    parent = node.parents[0];
  }
  return `Shared with me/${segs.join('/')}`;
}

export function normaliseDriveFile(raw: RawDriveFile, account: string, path: string): FileRecord {
  const size = Number(raw.size);
  const rec: FileRecord = {
    source: 'gdrive',
    account,
    id: raw.id,
    name: raw.name ?? '',
    path,
    mime: raw.mimeType ?? '',
    modified: raw.modifiedTime ?? '',
    size: Number.isFinite(size) ? size : 0,
    // webViewLink is absent for some items we only have metadata access to; the open?id= form
    // always resolves (and redirects to the right editor) for anything the account can see.
    link: raw.webViewLink ?? `https://drive.google.com/open?id=${raw.id}`,
  };
  if (raw.trashed) rec.deleted = true;
  return rec;
}

export function driveTombstone(id: string, account: string, observedAt: string): FileRecord {
  return {
    source: 'gdrive',
    account,
    id,
    name: '',
    path: '',
    mime: '',
    modified: observedAt,
    size: 0,
    link: `https://drive.google.com/open?id=${id}`,
    deleted: true,
  };
}

/**
 * One `changes.list` entry → a record, or undefined for things we do not track (shared-drive
 * metadata changes, `changeType: 'drive'`). `removed` covers both deletion and lost access —
 * Drive does not distinguish, and for "what can I see" neither do we.
 */
export function normaliseDriveChange(
  raw: RawDriveChange,
  account: string,
  pathOf: (f: RawDriveFile) => string,
): FileRecord | undefined {
  if (raw.changeType === 'drive') return undefined;
  if (!raw.fileId) return undefined;
  if (raw.removed || !raw.file) return driveTombstone(raw.fileId, account, raw.time ?? new Date(0).toISOString());
  return normaliseDriveFile(raw.file, account, pathOf(raw.file));
}

// ---------------------------------------------------------------------------------------
// Calendar
// ---------------------------------------------------------------------------------------

export interface RawCalendarTime { date?: string; dateTime?: string; timeZone?: string }
export interface RawCalendarPerson { email?: string; displayName?: string; self?: boolean; organizer?: boolean; responseStatus?: string; resource?: boolean }
/** `events.list` item. A cancelled instance of a recurring event arrives with only id/status/recurringEventId/originalStartTime. */
export interface RawCalendarEvent {
  id: string;
  status?: 'confirmed' | 'tentative' | 'cancelled';
  htmlLink?: string;
  summary?: string;
  description?: string;
  start?: RawCalendarTime;
  end?: RawCalendarTime;
  attendees?: RawCalendarPerson[];
  organizer?: RawCalendarPerson;
  creator?: RawCalendarPerson;
  iCalUID?: string;
  recurringEventId?: string;
  originalStartTime?: RawCalendarTime;
  eventType?: string;
}

export function normaliseCalendarEvent(raw: RawCalendarEvent, account: string, calendarId: string): EventRecord {
  const when = (t: RawCalendarTime | undefined) => t?.dateTime ?? t?.date ?? '';
  const rec: EventRecord = {
    source: 'gcal',
    account,
    id: raw.id,
    calendar: calendarId,
    start: when(raw.start),
    end: when(raw.end),
    title: raw.summary ?? '',
    // Rooms/resources are attendees too in the API; they are not people, drop them.
    attendees: [...new Set((raw.attendees ?? []).filter((a) => !a.resource && a.email).map((a) => a.email!.toLowerCase()))],
    organizer: raw.organizer?.email?.toLowerCase() ?? '',
    link: raw.htmlLink ?? '',
  };
  // showDeleted=true (required for sync tokens) delivers cancellations as status=cancelled; a
  // cancelled recurring instance has no start/end at all — only originalStartTime.
  if (raw.status === 'cancelled') {
    rec.deleted = true;
    if (!rec.start) rec.start = when(raw.originalStartTime);
  }
  return rec;
}

// ---------------------------------------------------------------------------------------
// Calendar selection and event filtering (pure; pull.ts applies them)
// ---------------------------------------------------------------------------------------

/**
 * Which calendars to read. Default: ONLY the account's primary calendar, plus ids opted in
 * explicitly. The first live pull read every calendar the account could see and got 215k rows,
 * 201k of them title-less instances from a colleague's shared calendar (reader access) and
 * Google's holiday/birthday/contacts feeds — none of it is Owen's time or Owen's promises. An
 * opt-in list keeps the door open per calendar; the skipped ones are returned so the puller can
 * log them once and Owen can pick.
 */
export interface CalendarListEntryLike { id: string; summary?: string; deleted?: boolean; primary?: boolean; accessRole?: string }
export function selectCalendars<T extends CalendarListEntryLike>(entries: T[], include: readonly string[] = []): { selected: T[]; skipped: T[] } {
  const want = new Set(include.map((s) => s.toLowerCase()));
  const selected: T[] = [];
  const skipped: T[] = [];
  for (const c of entries) {
    if (c.deleted) continue;
    if (c.primary || want.has(c.id.toLowerCase())) selected.push(c);
    else skipped.push(c);
  }
  return { selected, skipped };
}

/** The sync window. Past 400 days covers a year of retainer reconciliation; future 120 covers planning. */
export interface CalendarWindow { timeMin: string; timeMax: string }
export function calendarWindow(now: Date, pastDays = 400, futureDays = 120): CalendarWindow {
  const day = 24 * 60 * 60 * 1000;
  return { timeMin: new Date(now.getTime() - pastDays * day).toISOString(), timeMax: new Date(now.getTime() + futureDays * day).toISOString() };
}

/**
 * Keep an event record? Applied to every item regardless of what the server returned, so the
 * rules hold even when a sync token re-plays the unbounded initial parameter set.
 *   - cancelled: dropped on a full sync (nothing to tombstone), kept on an incremental one so
 *     readers can retire the earlier copy;
 *   - declined by the account itself: not Owen's time;
 *   - start outside the window: holidays-until-2099 and 1982 recurrences;
 *   - no title AND no attendees: a placeholder block, not a meeting.
 */
export function keepCalendarEvent(raw: RawCalendarEvent, window: CalendarWindow, opts: { incremental: boolean }): boolean {
  if (raw.status === 'cancelled') return opts.incremental;
  const self = (raw.attendees ?? []).find((a) => a.self);
  if (self?.responseStatus === 'declined') return false;
  const start = raw.start?.dateTime ?? raw.start?.date ?? '';
  if (!start) return false;
  // Date-only starts sort correctly against ISO timestamps on the first 10 chars; compare on the
  // common prefix so an all-day event on the boundary day is kept.
  if (start.slice(0, 10) < window.timeMin.slice(0, 10) || start.slice(0, 10) > window.timeMax.slice(0, 10)) return false;
  const people = (raw.attendees ?? []).filter((a) => !a.resource && a.email);
  if (!(raw.summary ?? '').trim() && people.length === 0) return false;
  return true;
}
