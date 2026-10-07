/**
 * Incremental, read-only puller: Microsoft Graph → normalised JSONL for one project's accounts.
 * Entry point `pullMsgraph(ctx, opts)`; the only state it needs is the token store written by
 * `auth.ts` and its own cursor file.
 *
 * Output per account under `<ctx.outDir>/msgraph/<account-slug>/`:
 *   messages.jsonl   mail + Teams chats + Teams channel posts   (MessageRecord)
 *   calendar.jsonl   calendarView occurrences                   (CalendarRecord)
 *   files.jsonl      OneDrive + SharePoint documents            (FileRecord)
 *   tombstones.jsonl ids reported deleted by a delta feed       (Tombstone)
 *   cursor.json      everything needed to continue: per-folder deltaLinks, per-chat
 *                    watermarks, per-drive deltaLinks, blocked-scope backoff, last runs.
 * Records are APPENDED; the same id may recur (edits, moves). Consumers keep the last line
 * per id and drop ids that have a tombstone after their last record.
 *
 * Why each source is read the way it is (docs cited inline):
 *  - Mail: delta is PER FOLDER (https://learn.microsoft.com/en-us/graph/delta-query-messages),
 *    so folders are enumerated every run (new folders, rules moving mail) and each keeps its
 *    own deltaLink. First sync uses `$filter=receivedDateTime ge <since>` (capped at 5,000
 *    messages/folder by Graph — a horizon, not a bug). Junk/Deleted/Drafts/Outbox are skipped.
 *  - Calendar: `/me/calendarView/delta` exists only for the PRIMARY calendar
 *    (https://learn.microsoft.com/en-us/graph/api/event-delta) and is bound to its window,
 *    so the window is re-issued when its end comes within 60 days. Other calendars are
 *    window-polled and filtered by lastModifiedDateTime.
 *  - Chats: no delegated delta or bulk route exists (those are app-only). Teams ToS allow
 *    change polling once a day UNLESS a date range is given
 *    (https://learn.microsoft.com/en-us/graph/api/resources/teams-api-overview), so every
 *    per-chat read carries `$filter=lastModifiedDateTime gt <watermark>` and chats are only
 *    opened when `/me/chats` (sorted by lastMessagePreview) shows something newer. Edits and
 *    soft-deletes of OLD messages do not move the preview; `chatsFull` (run it daily)
 *    opens every chat with its watermark filter and catches them.
 *  - Channels: delegated ChannelMessage.Read.All is admin-consent-only. The puller checks the
 *    token's `scp` claim and skips channels silently until the scope appears, then reads
 *    `/messages?$expand=replies` newest-first down to the per-channel watermark. A 403
 *    backs off for 24 h instead of hammering.
 *  - Files: driveItem delta per drive (https://learn.microsoft.com/en-us/graph/api/driveitem-delta):
 *    own OneDrive, every drive of every site from `/sites?search=*`, and each joined team's
 *    group drive. `/me/drive/sharedWithMe` and `/me/insights/*` are deprecated (dead after
 *    Nov 2026) and deliberately not used. 410 Gone → resync from scratch.
 *  - Throttling: Outlook 4 concurrent / 10k per 10 min per mailbox, Teams 1 rps per chat or
 *    channel, SharePoint resource units with Retry-After that must be honoured
 *    (https://learn.microsoft.com/en-us/graph/throttling-limits). Everything here is
 *    sequential with a 150 ms global gap and 1.1 s per chat/channel — far under the limits.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { scrubForWrite, type SinkOptions } from '../common/sink.js';
import type { MsgraphKind, PullContext, PullSummary } from '../types.js';
import { CHANNEL_SCOPE, GraphClient, GraphError, MsTokenStore, TokenError, sleep } from './client.js';
import {
  accountSlug,
  buildFolderPaths,
  eventTombstone,
  fileTombstone,
  isDeletedDriveItem,
  mailTombstone,
  normaliseChannelMessage,
  normaliseChatMessage,
  normaliseDriveItem,
  normaliseEvent,
  normaliseMailMessage,
  type AccountContext,
  type CalendarRecord,
  type DriveContext,
  type FileRecord,
  type MessageRecord,
  type RawChannel,
  type RawChat,
  type RawChatMessage,
  type RawConversationMember,
  type RawDriveItem,
  type RawEvent,
  type RawMailFolder,
  type RawMailMessage,
  type RawTeam,
  type Tombstone,
} from './normalise.js';

/** Per-run settings; replaces the former module-level argv globals so several projects can run in one process. */
interface Run {
  out: string;
  only: Set<MsgraphKind>;
  /** ISO instant: horizon for first syncs. */
  since: string;
  maxText: number;
  chatsFull: boolean;
  filesFromNow: boolean;
  log: (m: string) => void;
  vlog: (m: string) => void;
  sink: SinkOptions;
}

const DAY = 86_400_000;

// ---------------------------------------------------------------------------------------
// Cursor + output
// ---------------------------------------------------------------------------------------

interface Cursor {
  version: 1;
  account: string;
  mail: { folders: Record<string, { path: string; deltaLink?: string; synced_at?: string }>; skip_ids?: string[]; skip_resolved_at?: string };
  calendar: { primary?: { deltaLink?: string; window_start: string; window_end: string }; others: Record<string, { name: string; watermark?: string }> };
  chats: { per_chat: Record<string, { name: string; watermark?: string; members?: RawConversationMember[]; members_at?: string }> };
  channels: { blocked_until?: string; blocked_reason?: string; per_channel: Record<string, { name: string; watermark?: string }> };
  files: { drives: Record<string, { label: string; deltaLink?: string; synced_at?: string; error?: string }>; sites_scanned_at?: string };
  needs_reauth?: { at: string; error: string };
  runs: Array<{ started_at: string; finished_at: string; counts: Record<string, number>; errors: string[] }>;
}

function emptyCursor(account: string): Cursor {
  return { version: 1, account, mail: { folders: {} }, calendar: { others: {} }, chats: { per_chat: {} }, channels: { per_channel: {} }, files: { drives: {} }, runs: [] };
}

class Store {
  readonly dir: string;
  readonly cursor: Cursor;
  readonly counts: Record<string, number> = {};
  readonly errors: string[] = [];
  constructor(upn: string, private readonly run: Run) {
    this.dir = join(run.out, 'msgraph', accountSlug(upn));
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const p = join(this.dir, 'cursor.json');
    this.cursor = existsSync(p) ? (JSON.parse(readFileSync(p, 'utf8')) as Cursor) : emptyCursor(upn);
  }
  /** Atomic: a crash between data append and cursor save re-emits a few lines, never loses any. */
  save(): void {
    const p = join(this.dir, 'cursor.json');
    writeFileSync(`${p}.tmp`, JSON.stringify(this.cursor, null, 2));
    renameSync(`${p}.tmp`, p);
  }
  append(file: 'messages' | 'calendar' | 'files' | 'tombstones', records: Array<MessageRecord | CalendarRecord | FileRecord | Tombstone>): void {
    if (!records.length) return;
    // Mail, chats and channel posts all carry credentials; scrub (and vault) here so every writer
    // path is covered by one line. See docs/sources.md "Secrets".
    if (file === 'messages') records = (records as MessageRecord[]).map((r) => scrubForWrite(r, this.run.sink));
    appendFileSync(join(this.dir, `${file}.jsonl`), records.map((r) => JSON.stringify(r)).join('\n') + '\n');
    this.counts[file] = (this.counts[file] ?? 0) + records.length;
  }
  fail(what: string, e: unknown): void {
    const msg = `${what}: ${e instanceof Error ? e.message : String(e)}`;
    this.errors.push(msg);
    this.run.log(`ERROR ${msg}`);
  }
}

/** Teams limits are per chat / per channel (1 rps): remember the last call per resource key. */
const lastByKey = new Map<string, number>();
async function pace(key: string, ms = 1100): Promise<void> {
  const wait = ms - (Date.now() - (lastByKey.get(key) ?? 0));
  if (wait > 0) await sleep(wait);
  lastByKey.set(key, Date.now());
}

const maxIso = (a: string | undefined, b: string | undefined): string | undefined => (!a ? b : !b ? a : a > b ? a : b);

// ---------------------------------------------------------------------------------------
// Mail
// ---------------------------------------------------------------------------------------

const MAIL_SELECT = 'id,subject,from,sender,toRecipients,ccRecipients,bccRecipients,receivedDateTime,sentDateTime,bodyPreview,body,webLink,hasAttachments,isDraft,conversationId,internetMessageId,parentFolderId';
const MAIL_PREFER = { prefer: 'odata.maxpagesize=100, outlook.body-content-type="text"' };
const SKIP_WELL_KNOWN = ['junkemail', 'deleteditems', 'drafts', 'outbox', 'syncissues', 'conflicts', 'localfailures', 'serverfailures'];

async function listAllFolders(g: GraphClient): Promise<RawMailFolder[]> {
  const out: RawMailFolder[] = [];
  const walk = async (path: string) => {
    const page = await g.all<RawMailFolder>(`${path}?includeHiddenFolders=true&$top=200&$select=id,displayName,parentFolderId,childFolderCount,totalItemCount,isHidden`);
    for (const f of page) {
      out.push(f);
      if ((f.childFolderCount ?? 0) > 0) await walk(`/me/mailFolders/${f.id}/childFolders`);
    }
  };
  await walk('/me/mailFolders');
  return out;
}

async function pullMail(run: Run, g: GraphClient, st: Store, ctx: AccountContext): Promise<void> {
  const c = st.cursor.mail;
  // Well-known folder ids resolve via their names; cache a week (they never change, but a fresh mailbox may lack some).
  if (!c.skip_resolved_at || Date.now() - Date.parse(c.skip_resolved_at) > 7 * DAY) {
    const ids: string[] = [];
    for (const wk of SKIP_WELL_KNOWN) {
      try {
        ids.push((await g.get<{ id: string }>(`/me/mailFolders/${wk}?$select=id`)).body.id);
      } catch (e) {
        if (!(e instanceof GraphError && e.status === 404)) throw e;
      }
    }
    c.skip_ids = ids;
    c.skip_resolved_at = new Date().toISOString();
  }
  const folders = await listAllFolders(g);
  const paths = buildFolderPaths(folders);
  const skip = new Set(c.skip_ids ?? []);
  for (const f of folders) {
    if (skip.has(f.id) || skip.has(f.parentFolderId ?? '')) continue;
    const path = paths.get(f.id) ?? f.id;
    const fc = (c.folders[f.id] ??= { path });
    fc.path = path;
    if ((f.totalItemCount ?? 1) === 0 && !fc.deltaLink) continue; // nothing to sync yet; no state to keep
    const initial = `/me/mailFolders/${f.id}/messages/delta?$select=${MAIL_SELECT}&$filter=receivedDateTime ge ${run.since}`;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const it = g.pages<RawMailMessage>(fc.deltaLink ?? initial, MAIL_PREFER);
        let n = 0;
        for (;;) {
          const r = await it.next();
          if (r.done) {
            if (r.value) fc.deltaLink = r.value;
            break;
          }
          const recs: MessageRecord[] = [];
          const tombs: Tombstone[] = [];
          for (const m of r.value.value) {
            if (m['@removed']) tombs.push(mailTombstone(m, ctx));
            else {
              const rec = normaliseMailMessage(m, { id: f.id, path }, ctx, { maxText: run.maxText });
              if (rec) recs.push(rec);
            }
          }
          st.append('messages', recs);
          st.append('tombstones', tombs);
          n += recs.length;
        }
        fc.synced_at = new Date().toISOString();
        if (n) run.vlog(`mail ${path}: ${n} messages`);
        break;
      } catch (e) {
        if (e instanceof GraphError && (e.status === 410 || e.code === 'SyncStateNotFound' || e.code === 'SyncStateInvalid') && fc.deltaLink) {
          run.log(`mail ${path}: delta state expired, full resync`);
          delete fc.deltaLink;
          continue;
        }
        st.fail(`mail ${path}`, e);
        break;
      }
    }
    st.save();
  }
}

// ---------------------------------------------------------------------------------------
// Calendar
// ---------------------------------------------------------------------------------------

const CAL_PREFER = { prefer: 'outlook.timezone="UTC", outlook.body-content-type="text", odata.maxpagesize=50' };
const EVENT_SELECT = 'id,subject,start,end,isAllDay,isCancelled,organizer,attendees,webLink,onlineMeeting,location,lastModifiedDateTime,type,seriesMasterId,responseStatus';

async function pullCalendar(run: Run, g: GraphClient, st: Store, ctx: AccountContext): Promise<void> {
  const c = st.cursor.calendar;
  const now = Date.now();
  // Primary calendar: delta over a window; re-issue when the window end approaches.
  if (!c.primary?.deltaLink || Date.parse(c.primary.window_end) - now < 60 * DAY) {
    c.primary = { window_start: new Date(Math.min(now - 365 * DAY, Date.parse(run.since))).toISOString(), window_end: new Date(now + 180 * DAY).toISOString() };
    run.log(`calendar: new delta window ${c.primary.window_start.slice(0, 10)} → ${c.primary.window_end.slice(0, 10)}`);
  }
  const p = c.primary;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const it = g.pages<RawEvent>(p.deltaLink ?? `/me/calendarView/delta?startDateTime=${p.window_start}&endDateTime=${p.window_end}`, CAL_PREFER);
      for (;;) {
        const r = await it.next();
        if (r.done) {
          if (r.value) p.deltaLink = r.value;
          break;
        }
        const recs: CalendarRecord[] = [];
        const tombs: Tombstone[] = [];
        for (const ev of r.value.value) {
          if (ev['@removed']) tombs.push(eventTombstone(ev, ctx));
          else {
            const rec = normaliseEvent(ev, ctx);
            if (rec) recs.push(rec);
          }
        }
        st.append('calendar', recs);
        st.append('tombstones', tombs);
      }
      break;
    } catch (e) {
      if (e instanceof GraphError && (e.status === 410 || /SyncState/.test(e.code)) && p.deltaLink) {
        delete p.deltaLink;
        continue;
      }
      st.fail('calendar primary', e);
      break;
    }
  }
  st.save();
  // Secondary calendars (shared/added ones appear in /me/calendars): window poll, modified-since filter.
  try {
    const cals = await g.all<{ id: string; name?: string; isDefaultCalendar?: boolean }>('/me/calendars?$select=id,name,isDefaultCalendar');
    for (const cal of cals.filter((x) => !x.isDefaultCalendar)) {
      const oc = (c.others[cal.id] ??= { name: cal.name ?? cal.id });
      oc.name = cal.name ?? cal.id;
      const start = new Date(now - 90 * DAY).toISOString();
      const end = new Date(now + 180 * DAY).toISOString();
      let wm = oc.watermark;
      const recs: CalendarRecord[] = [];
      for await (const page of g.pages<RawEvent>(`/me/calendars/${cal.id}/calendarView?startDateTime=${start}&endDateTime=${end}&$top=100&$select=${EVENT_SELECT}`, CAL_PREFER)) {
        for (const ev of page.value) {
          if (oc.watermark && (ev.lastModifiedDateTime ?? '') <= oc.watermark) continue;
          const rec = normaliseEvent(ev, ctx);
          if (rec) recs.push(rec);
          wm = maxIso(wm, ev.lastModifiedDateTime);
        }
      }
      st.append('calendar', recs);
      oc.watermark = wm;
      if (recs.length) run.vlog(`calendar ${oc.name}: ${recs.length} events`);
    }
  } catch (e) {
    st.fail('calendar secondary', e);
  }
  st.save();
}

// ---------------------------------------------------------------------------------------
// Chats
// ---------------------------------------------------------------------------------------

async function pullChats(run: Run, g: GraphClient, st: Store, ctx: AccountContext): Promise<void> {
  const c = st.cursor.chats;
  const chats = await g.all<RawChat>('/me/chats?$top=50&$expand=lastMessagePreview&$orderby=lastMessagePreview/createdDateTime desc');
  let opened = 0;
  for (const chat of chats) {
    const cc = (c.per_chat[chat.id] ??= { name: chat.id });
    const previewAt = chat.lastMessagePreview?.createdDateTime ?? chat.lastUpdatedDateTime ?? '';
    // Nothing newer than what we have, and nothing in the horizon → do not open the chat (ToS + 1 rps/user on /me/chats).
    if (!run.chatsFull && previewAt && previewAt <= (cc.watermark ?? run.since)) continue;
    try {
      // Members are needed for container naming + participants; cached a week (chat lists are capped at 25 members anyway).
      if (!cc.members || !cc.members_at || Date.now() - Date.parse(cc.members_at) > 7 * DAY) {
        await pace(chat.id);
        cc.members = (await g.all<RawConversationMember>(`/me/chats/${chat.id}/members`)).map((m) => ({ displayName: m.displayName, userId: m.userId, email: m.email }));
        cc.members_at = new Date().toISOString();
      }
      const full: RawChat = { ...chat, members: cc.members };
      const wmStart = cc.watermark ?? run.since;
      let wm = cc.watermark;
      let n = 0;
      const url = `/me/chats/${chat.id}/messages?$top=50&$orderby=lastModifiedDateTime desc&$filter=lastModifiedDateTime gt ${wmStart}`;
      const it = g.pages<RawChatMessage>(url);
      for (;;) {
        await pace(chat.id);
        const r = await it.next();
        if (r.done) break;
        const recs: MessageRecord[] = [];
        for (const m of r.value.value) {
          const rec = normaliseChatMessage(m, full, ctx, { maxText: run.maxText });
          if (rec) recs.push(rec);
          wm = maxIso(wm, m.lastModifiedDateTime ?? m.createdDateTime);
        }
        st.append('messages', recs);
        n += recs.length;
        if (recs.length && !cc.name.startsWith('chat:')) cc.name = recs[0]!.container;
      }
      cc.watermark = wm ?? cc.watermark;
      opened++;
      if (n) run.vlog(`${cc.name}: ${n} messages`);
    } catch (e) {
      st.fail(`chat ${cc.name}`, e);
    }
    st.save();
  }
  run.log(`chats: ${chats.length} listed, ${opened} opened`);
}

// ---------------------------------------------------------------------------------------
// Channels (only when the token carries ChannelMessage.Read.All)
// ---------------------------------------------------------------------------------------

async function pullChannels(run: Run, g: GraphClient, st: Store, ctx: AccountContext): Promise<void> {
  const c = st.cursor.channels;
  if (c.blocked_until && Date.parse(c.blocked_until) > Date.now()) {
    run.log(`channels: skipped until ${c.blocked_until} (${c.blocked_reason})`);
    return;
  }
  if (!(await g.scopes()).includes(CHANNEL_SCOPE)) {
    run.log(`channels: token lacks ${CHANNEL_SCOPE} (needs admin consent) — skipping; run auth.ts scopes --add ${CHANNEL_SCOPE} once granted`);
    return;
  }
  const teams = await g.all<RawTeam>('/me/joinedTeams?$select=id,displayName,isArchived,tenantId');
  for (const team of teams) {
    let channels: RawChannel[];
    try {
      channels = await g.all<RawChannel>(`/teams/${team.id}/channels?$select=id,displayName,membershipType`);
    } catch (e) {
      st.fail(`team ${team.displayName}`, e);
      continue;
    }
    for (const ch of channels) {
      const key = `${team.id}/${ch.id}`;
      const cc = (c.per_channel[key] ??= { name: `team:${team.displayName}/#${ch.displayName}` });
      try {
        let wm = cc.watermark;
        let n = 0;
        const it = g.pages<RawChatMessage>(`/teams/${team.id}/channels/${ch.id}/messages?$top=50&$expand=replies`);
        outer: for (;;) {
          await pace(ch.id);
          const r = await it.next();
          if (r.done) break;
          const recs: MessageRecord[] = [];
          for (const post of r.value.value) {
            // Listing is ordered by last activity of the whole reply chain; stop once the chain is older than our watermark.
            let replies = post.replies ?? [];
            const nextReplies = (post as RawChatMessage & { 'replies@odata.nextLink'?: string })['replies@odata.nextLink'];
            if (nextReplies) replies = [...replies, ...(await g.all<RawChatMessage>(nextReplies))];
            const chainMod = replies.reduce<string | undefined>((m, x) => maxIso(m, x.lastModifiedDateTime ?? x.createdDateTime), post.lastModifiedDateTime ?? post.createdDateTime);
            if (cc.watermark && (chainMod ?? '') <= cc.watermark) break outer;
            if ((chainMod ?? '') < run.since) break outer;
            const changed = (m: RawChatMessage) => !cc.watermark || (m.lastModifiedDateTime ?? m.createdDateTime) > cc.watermark;
            if (changed(post)) {
              const rec = normaliseChannelMessage(post, team, ch, ctx, undefined, { maxText: run.maxText });
              if (rec) recs.push(rec);
            }
            for (const rep of replies) {
              if (!changed(rep)) continue;
              const rec = normaliseChannelMessage(rep, team, ch, ctx, post, { maxText: run.maxText });
              if (rec) recs.push(rec);
            }
            wm = maxIso(wm, chainMod);
          }
          st.append('messages', recs);
          n += recs.length;
        }
        cc.watermark = wm ?? cc.watermark;
        if (n) run.vlog(`${cc.name}: ${n} messages`);
      } catch (e) {
        if (e instanceof GraphError && e.status === 403) {
          c.blocked_until = new Date(Date.now() + DAY).toISOString();
          c.blocked_reason = `${e.code}: ${e.message.slice(0, 120)}`;
          st.fail(`channels (backing off 24 h; ${CHANNEL_SCOPE} consented?)`, e);
          st.save();
          return;
        }
        st.fail(cc.name, e);
      }
      st.save();
    }
  }
}

// ---------------------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------------------

const ITEM_SELECT = 'id,name,webUrl,size,lastModifiedDateTime,createdDateTime,file,folder,package,root,deleted,parentReference';

async function discoverDrives(run: Run, g: GraphClient, st: Store): Promise<void> {
  const c = st.cursor.files;
  const add = (id: string, label: string) => {
    const d = c.drives[id];
    if (!d) c.drives[id] = { label };
  };
  try {
    const me = await g.get<{ id: string }>('/me/drive?$select=id');
    add(me.body.id, 'onedrive');
  } catch (e) {
    st.fail('onedrive', e);
  }
  if (c.sites_scanned_at && Date.now() - Date.parse(c.sites_scanned_at) < DAY) return;
  try {
    for (const team of await g.all<RawTeam>('/me/joinedTeams?$select=id,displayName')) {
      try {
        const d = await g.get<{ id: string; name?: string }>(`/groups/${team.id}/drive?$select=id,name`);
        add(d.body.id, `team:${team.displayName}/${d.body.name ?? 'Documents'}`);
      } catch (e) {
        if (!(e instanceof GraphError && (e.status === 404 || e.status === 403))) throw e;
      }
    }
    // `search=*` lists every site the user can access (Sites.Read.All); trimmed by Graph to Owen's permissions.
    for (const site of await g.all<{ id: string; displayName?: string; name?: string }>('/sites?search=*&$select=id,displayName,name')) {
      try {
        for (const d of await g.all<{ id: string; name?: string; driveType?: string }>(`/sites/${site.id}/drives?$select=id,name,driveType`)) {
          add(d.id, `site:${site.displayName ?? site.name ?? site.id}/${d.name ?? 'Documents'}`);
        }
      } catch (e) {
        if (!(e instanceof GraphError && (e.status === 404 || e.status === 403))) throw e;
      }
    }
    c.sites_scanned_at = new Date().toISOString();
  } catch (e) {
    st.fail('site discovery', e);
  }
  st.save();
}

async function pullFiles(run: Run, g: GraphClient, st: Store, ctx: AccountContext): Promise<void> {
  await discoverDrives(run, g, st);
  const c = st.cursor.files;
  run.log(`files: ${Object.keys(c.drives).length} drives`);
  for (const [driveId, dc] of Object.entries(c.drives)) {
    const drive: DriveContext = { driveId, label: dc.label };
    const initial = `/drives/${driveId}/root/delta?$select=${ITEM_SELECT}${run.filesFromNow ? '&token=latest' : ''}`;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const it = g.pages<RawDriveItem>(dc.deltaLink ?? initial);
        let n = 0;
        for (;;) {
          const r = await it.next();
          if (r.done) {
            if (r.value) dc.deltaLink = r.value;
            break;
          }
          const recs: FileRecord[] = [];
          const tombs: Tombstone[] = [];
          for (const item of r.value.value) {
            if (isDeletedDriveItem(item)) tombs.push(fileTombstone(item, drive, ctx));
            else {
              const rec = normaliseDriveItem(item, drive, ctx);
              if (rec) recs.push(rec);
            }
          }
          st.append('files', recs);
          st.append('tombstones', tombs);
          n += recs.length;
        }
        dc.synced_at = new Date().toISOString();
        delete dc.error;
        if (n) run.vlog(`${dc.label}: ${n} files`);
        break;
      } catch (e) {
        if (e instanceof GraphError && e.status === 410 && dc.deltaLink) {
          // Sync state gone: Graph may hand a fresh nextLink in Location; otherwise start over.
          const loc = (e as GraphError & { location?: string }).location;
          run.log(`${dc.label}: delta state expired (${e.code}); ${loc ? 'resuming from Location' : 'full resync'}`);
          dc.deltaLink = loc;
          continue;
        }
        if (e instanceof GraphError && (e.status === 403 || e.status === 404)) dc.error = `${e.status} ${e.code}`;
        st.fail(dc.label, e);
        break;
      }
    }
    st.save();
  }
}

// ---------------------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------------------

export interface MsgraphPullOptions {
  /** Account keys (`<tenant>:<upn>`) or UPNs; every stored account when omitted. */
  accounts?: string[];
  only?: MsgraphKind[];
  /** YYYY-MM-DD horizon for first syncs (default 180 days back). */
  since?: string;
  maxText?: number;
  filesFromNow?: boolean;
  chatsFull?: boolean;
  verbose?: boolean;
}

async function pullAccount(run: Run, store: MsTokenStore, key: string, summary: PullSummary): Promise<void> {
  const acct = store.getAccount(key);
  const st = new Store(acct.upn, run);
  const started = new Date().toISOString();
  const ctx: AccountContext = { tenant_id: acct.tenant_id, upn: acct.upn, user_id: acct.user_id, display_name: acct.display_name };
  const g = new GraphClient(store, acct.key, { minIntervalMs: 150, log: run.vlog });
  run.log(`== ${acct.key} → ${st.dir}`);
  try {
    if (run.only.has('mail')) await pullMail(run, g, st, ctx);
    if (run.only.has('calendar')) await pullCalendar(run, g, st, ctx);
    if (run.only.has('chats')) await pullChats(run, g, st, ctx);
    if (run.only.has('channels')) await pullChannels(run, g, st, ctx);
    if (run.only.has('files')) await pullFiles(run, g, st, ctx);
    delete st.cursor.needs_reauth;
  } catch (e) {
    if (e instanceof TokenError && e.needsReauth) {
      // The one failure an unattended run cannot fix: record it where the operator will see it.
      st.cursor.needs_reauth = { at: new Date().toISOString(), error: `${e.error} ${e.codes.join(',')}: ${e.description.split('\n')[0]}` };
      st.fail(`NEEDS RE-BOOTSTRAP (run: orch sources auth <slug> msgraph login)`, e);
      summary.reauth = true;
    } else st.fail('run', e);
  }
  st.cursor.runs = [...st.cursor.runs.slice(-9), { started_at: started, finished_at: new Date().toISOString(), counts: st.counts, errors: st.errors }];
  st.save();
  for (const [k, v] of Object.entries(st.counts)) summary.counts[`${acct.upn}/${k}`] = v;
  for (const err of st.errors) summary.errors.push(`${acct.upn}: ${err}`);
  if (st.errors.length) summary.ok = false;
}

export async function pullMsgraph(pctx: PullContext, opts: MsgraphPullOptions = {}): Promise<PullSummary> {
  const startedAt = new Date().toISOString();
  if (opts.since && !/^\d{4}-\d{2}-\d{2}$/.test(opts.since)) throw new Error('since must be YYYY-MM-DD');
  const store = new MsTokenStore(pctx.tokenPath);
  const run: Run = {
    out: pctx.outDir,
    only: new Set(opts.only?.length ? opts.only : (['mail', 'calendar', 'chats', 'channels', 'files'] as MsgraphKind[])),
    since: new Date(opts.since ?? new Date(Date.now() - 180 * DAY).toISOString().slice(0, 10)).toISOString(),
    maxText: opts.maxText ?? 20_000,
    chatsFull: opts.chatsFull ?? false,
    filesFromNow: opts.filesFromNow ?? false,
    log: pctx.log,
    vlog: opts.verbose ? pctx.log : () => undefined,
    sink: { log: pctx.log, warned: { vault: false }, ...(pctx.vault ? { vault: pctx.vault } : {}) },
  };
  const summary: PullSummary = { kind: 'msgraph', ok: true, reauth: false, counts: {}, errors: [], startedAt, finishedAt: startedAt };
  const keys = opts.accounts?.length ? opts.accounts : Object.keys(store.read().accounts);
  if (!keys.length) {
    summary.ok = false;
    summary.errors.push(`no accounts in ${pctx.tokenPath} — run: orch sources auth ${pctx.slug} msgraph login`);
  }
  for (const k of keys) {
    try {
      await pullAccount(run, store, k, summary);
    } catch (e) {
      // getAccount() for an unknown key; everything else is caught inside pullAccount.
      summary.ok = false;
      summary.errors.push(e instanceof Error ? e.message : String(e));
      pctx.log(summary.errors.at(-1)!);
    }
  }
  summary.finishedAt = new Date().toISOString();
  return summary;
}
