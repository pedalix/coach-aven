/**
 * Incremental, read-only puller for Gmail / Drive / Calendar across N Google accounts of one
 * project. Entry point: `pullGoogle(ctx, opts)` (cli.ts `orch sources pull`, later the poller).
 *
 * Output under `<ctx.outDir>/google/`: `<account>/{messages,files,events}.jsonl` (append-only,
 * one record per line, tombstones carry `deleted: true`) and `cursor.json` (per account, per
 * product). Records are idempotent on (source, account, id): the store build (PR-B) upserts, so
 * re-emitting a message that a full resync and a later history page both report is harmless.
 *
 * Incremental strategy per API, and what happens when the server forgets our cursor:
 *   Gmail    history.list from a stored historyId. "A historyId is typically valid for at least a
 *            week, but in some rare circumstances may be valid for only a few hours"; an expired one
 *            returns HTTP 404 → full resync via messages.list. Poll every few minutes, not daily.
 *            https://developers.google.com/workspace/gmail/api/guides/sync
 *   Drive    changes.list from a stored page token; "The page token doesn't expire", so a long
 *            outage never forces a Drive full resync. includeItemsFromAllDrives=true gives one feed
 *            for My Drive + every shared drive. https://developers.google.com/workspace/drive/api/reference/rest/v3/changes/list
 *   Calendar calendarList + per-calendar events with syncToken; 410 GONE → full resync of that
 *            calendar. Only the PRIMARY calendar plus explicit opt-ins are read (a colleague's
 *            shared calendar once produced 200k title-less rows), bounded to a window.
 *            https://developers.google.com/workspace/calendar/api/guides/sync
 *
 * Quota (per user, per minute): Gmail 6,000 units (messages.get = 20 → ~300/min), Drive 325,000
 * units, Calendar 600 requests. Gmail is the only one a backfill can hit, hence the small
 * concurrency pool there; everything else is paginated sequentially. Batch requests would not
 * help — the quota page charges every inner request separately.
 */
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { HttpError, ReauthRequired, Tokens, gjson, loadStore, withQuery } from './client.js';
import {
  drivePath,
  driveTombstone,
  gmailTombstone,
  calendarWindow,
  keepCalendarEvent,
  normaliseCalendarEvent,
  selectCalendars,
  type CalendarWindow,
  normaliseDriveChange,
  normaliseDriveFile,
  normaliseGmailMessage,
  type DriveNode,
  type EventRecord,
  type FileRecord,
  type MessageRecord,
  type RawCalendarEvent,
  type RawDriveChange,
  type RawDriveFile,
  type RawGmailMessage,
} from './normalise.js';
import { scrubForWrite, type SinkOptions } from '../common/sink.js';
import type { GoogleKind, PullContext, PullSummary } from '../types.js';

const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me';
const DRIVE = 'https://www.googleapis.com/drive/v3';
const CAL = 'https://www.googleapis.com/calendar/v3';
const GMAIL_GET_CONCURRENCY = 4;

// ---------------------------------------------------------------------------------------
// Cursor + output plumbing
// ---------------------------------------------------------------------------------------

interface GmailCursor { historyId: string; synced_at: string; full_at: string }
interface DriveCursor { pageToken: string; synced_at: string; full_at: string }
interface CalendarCursor { listSyncToken?: string; events: Record<string, string>; synced_at: string }
interface AccountCursor { gmail?: GmailCursor; drive?: DriveCursor; calendar?: CalendarCursor }
type Cursor = Record<string, AccountCursor>;

function readJson<T>(path: string, fallback: T): T {
  return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as T) : fallback;
}
function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n');
  renameSync(tmp, path);
}

/** Append-only JSONL writer. Synchronous writes keep record order == emission order and survive a crash mid-run (what was written is written). */
class Jsonl {
  private fd: number;
  count = 0;
  constructor(path: string, private readonly sink: SinkOptions) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.fd = openSync(path, 'a');
  }
  write(rec: MessageRecord | FileRecord | EventRecord): void {
    // Mail bodies carry credentials; scrub (and vault) at the write chokepoint so no code path can
    // forget. Tombstones have no text and pass through. See docs/sources.md "Secrets".
    if (rec.source === 'gmail' && typeof (rec as MessageRecord).text === 'string') rec = scrubForWrite(rec as MessageRecord, this.sink);
    writeSync(this.fd, JSON.stringify(rec) + '\n');
    this.count++;
  }
  close(): void { closeSync(this.fd); }
}

/** Bounded-concurrency map; order of results matches input. */
async function pmap<T, R>(items: readonly T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

interface Ctx {
  tokens: Tokens;
  outDir: string;
  since?: string;
  full: boolean;
  /** Calendar ids read in addition to the primary one. Default none. */
  calendars: string[];
  /** The event window; computed once per run so every page and every calendar agree. */
  calWindow: CalendarWindow;
  log: (line: string) => void;
  sink: SinkOptions;
  /** Calendars skipped this run, logged once each. */
  skippedLogged: Set<string>;
}

/** Puller log lines are prefixed by the caller (cli.ts / poller); keep them short and greppable. */
const fmt = (...a: unknown[]) => a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ');

// ---------------------------------------------------------------------------------------
// Gmail
// ---------------------------------------------------------------------------------------

interface GmailList { messages?: { id: string }[]; nextPageToken?: string }
interface GmailHistory {
  history?: { messagesAdded?: { message: { id: string } }[]; messagesDeleted?: { message: { id: string } }[] }[];
  nextPageToken?: string;
  historyId?: string;
}

async function fetchMessages(ctx: Ctx, account: string, ids: readonly string[], out: Jsonl): Promise<void> {
  let n = 0;
  await pmap(ids, GMAIL_GET_CONCURRENCY, async (id) => {
    try {
      const raw = await gjson<RawGmailMessage>(ctx.tokens, account, withQuery(`${GMAIL}/messages/${id}`, { format: 'full' }));
      out.write(normaliseGmailMessage(raw, account));
    } catch (e) {
      // 404: deleted between list and get. Not a tombstone — history will report the deletion, or
      // (full sync) we never knew about it. Anything else propagates.
      if (!(e instanceof HttpError && e.status === 404)) throw e;
    }
    if (++n % 500 === 0) ctx.log(fmt(`  gmail ${account}: ${n}/${ids.length} fetched`));
  });
}

async function gmailFull(ctx: Ctx, account: string, out: Jsonl): Promise<GmailCursor> {
  // Baseline BEFORE listing: anything that lands during the (hours-long) backfill is then also
  // covered by the next history.list, at the cost of a few duplicate records.
  const profile = await gjson<{ historyId: string }>(ctx.tokens, account, `${GMAIL}/profile`);
  const ids: string[] = [];
  let pageToken: string | undefined;
  do {
    const page = await gjson<GmailList>(ctx.tokens, account, withQuery(`${GMAIL}/messages`, {
      maxResults: 500,
      fields: 'nextPageToken,messages/id',
      // Gmail search syntax; after:YYYY/MM/DD bounds a backfill. Spam/trash are excluded by
      // default (includeSpamTrash=false) — noise for a commitments ledger.
      q: ctx.since ? `after:${ctx.since.replace(/-/g, '/')}` : undefined,
      pageToken,
    }));
    for (const m of page.messages ?? []) ids.push(m.id);
    pageToken = page.nextPageToken;
  } while (pageToken);
  ctx.log(fmt(`  gmail ${account}: full sync, ${ids.length} messages to fetch (~${Math.ceil(ids.length / 300)} min at the per-user quota)`));
  await fetchMessages(ctx, account, ids, out);
  const now = new Date().toISOString();
  return { historyId: profile.historyId, synced_at: now, full_at: now };
}

async function gmailIncremental(ctx: Ctx, account: string, cur: GmailCursor, out: Jsonl): Promise<GmailCursor> {
  const added = new Set<string>();
  const deleted = new Set<string>();
  let latest = cur.historyId;
  let pageToken: string | undefined;
  do {
    let page: GmailHistory;
    try {
      page = await gjson<GmailHistory>(ctx.tokens, account, withQuery(`${GMAIL}/history`, {
        startHistoryId: cur.historyId,
        historyTypes: ['messageAdded', 'messageDeleted'],
        maxResults: 500,
        pageToken,
      }));
    } catch (e) {
      // 404 = our historyId is older than what Gmail retains. The only recovery is a full listing.
      if (e instanceof HttpError && e.status === 404) {
        ctx.log(fmt(`  gmail ${account}: historyId ${cur.historyId} expired → full resync`));
        return gmailFull(ctx, account, out);
      }
      throw e;
    }
    for (const h of page.history ?? []) {
      for (const m of h.messagesAdded ?? []) added.add(m.message.id);
      for (const m of h.messagesDeleted ?? []) { deleted.add(m.message.id); added.delete(m.message.id); }
    }
    if (page.historyId) latest = page.historyId;
    pageToken = page.nextPageToken;
  } while (pageToken);
  const observed = new Date().toISOString();
  for (const id of deleted) out.write(gmailTombstone(id, account, observed));
  await fetchMessages(ctx, account, [...added], out);
  ctx.log(fmt(`  gmail ${account}: +${added.size} -${deleted.size} since ${cur.historyId} → ${latest}`));
  return { ...cur, historyId: latest, synced_at: observed };
}

// ---------------------------------------------------------------------------------------
// Drive
// ---------------------------------------------------------------------------------------

const FILE_FIELDS = 'id,name,mimeType,modifiedTime,parents,driveId,owners(emailAddress,displayName),webViewLink,size,md5Checksum,trashed,shared';
interface DriveFileList { files?: RawDriveFile[]; nextPageToken?: string }
interface DriveChangeList { changes?: RawDriveChange[]; nextPageToken?: string; newStartPageToken?: string }

/**
 * Folder knowledge for path building. Parents outside the listing (a shared folder's own parent,
 * or on incremental runs everything) are fetched lazily at 5 units each, level by level, and a
 * 404/403 is remembered as "not visible" so the walk stops at `Shared with me/`.
 */
class DriveIndex {
  nodes = new Map<string, DriveNode | null>();
  driveNames = new Map<string, string>();
  rootId?: string;
  constructor(private readonly ctx: Ctx, private readonly account: string) {}

  async init(): Promise<void> {
    this.rootId = (await gjson<{ id: string }>(this.ctx.tokens, this.account, withQuery(`${DRIVE}/files/root`, { fields: 'id' }))).id;
    let pageToken: string | undefined;
    do {
      const page = await gjson<{ drives?: { id: string; name: string }[]; nextPageToken?: string }>(
        this.ctx.tokens, this.account, withQuery(`${DRIVE}/drives`, { pageSize: 100, fields: 'nextPageToken,drives(id,name)', pageToken }));
      for (const d of page.drives ?? []) this.driveNames.set(d.id, d.name);
      pageToken = page.nextPageToken;
    } while (pageToken);
  }

  remember(f: RawDriveFile): void {
    this.nodes.set(f.id, { name: f.name ?? f.id, ...(f.parents ? { parents: f.parents } : {}), ...(f.driveId ? { driveId: f.driveId } : {}) });
  }

  /** Resolve every ancestor of `files` not yet known; bounded by tree depth (Drive caps nesting at ~100, real trees are <10). */
  async resolveAncestors(files: readonly RawDriveFile[]): Promise<void> {
    let frontier = new Set<string>();
    for (const f of files) for (const p of f.parents ?? []) frontier.add(p);
    for (let depth = 0; depth < 50 && frontier.size; depth++) {
      const unknown = [...frontier].filter((id) => !this.nodes.has(id) && id !== this.rootId && !this.driveNames.has(id));
      const fetched = await pmap(unknown, 8, async (id): Promise<[string, DriveNode | null]> => {
        try {
          const f = await gjson<RawDriveFile>(this.ctx.tokens, this.account, withQuery(`${DRIVE}/files/${id}`, { supportsAllDrives: true, fields: 'id,name,parents,driveId' }));
          return [id, { name: f.name ?? id, ...(f.parents ? { parents: f.parents } : {}), ...(f.driveId ? { driveId: f.driveId } : {}) }];
        } catch (e) {
          if (e instanceof HttpError && (e.status === 404 || e.status === 403)) return [id, null];
          throw e;
        }
      });
      frontier = new Set<string>();
      for (const [id, node] of fetched) {
        this.nodes.set(id, node);
        for (const p of node?.parents ?? []) frontier.add(p);
      }
    }
  }

  pathOf(f: RawDriveFile): string {
    return drivePath(f, {
      lookup: (id) => this.nodes.get(id) ?? undefined,
      driveName: (id) => this.driveNames.get(id),
      ...(this.rootId ? { rootId: this.rootId } : {}),
    });
  }
}

async function driveFull(ctx: Ctx, account: string, idx: DriveIndex, out: Jsonl): Promise<DriveCursor> {
  // Token BEFORE the listing, same reasoning as Gmail's historyId baseline.
  const start = await gjson<{ startPageToken: string }>(ctx.tokens, account, withQuery(`${DRIVE}/changes/startPageToken`, { supportsAllDrives: true }));
  const files: RawDriveFile[] = [];
  let pageToken: string | undefined;
  do {
    const page = await gjson<DriveFileList>(ctx.tokens, account, withQuery(`${DRIVE}/files`, {
      // allDrives = My Drive + files shared with me + every shared drive I am a member of, in one
      // corpus; restrictToMyDrive stays off so loose shared files are included.
      corpora: 'allDrives',
      includeItemsFromAllDrives: true,
      supportsAllDrives: true,
      pageSize: 1000,
      fields: `nextPageToken,files(${FILE_FIELDS})`,
      q: ctx.since ? `modifiedTime > '${ctx.since}T00:00:00'` : undefined,
      pageToken,
    }));
    for (const f of page.files ?? []) { files.push(f); idx.remember(f); }
    pageToken = page.nextPageToken;
  } while (pageToken);
  await idx.resolveAncestors(files);
  for (const f of files) out.write(normaliseDriveFile(f, account, idx.pathOf(f)));
  ctx.log(fmt(`  drive ${account}: full sync, ${files.length} files (${idx.driveNames.size} shared drives)`));
  const now = new Date().toISOString();
  return { pageToken: start.startPageToken, synced_at: now, full_at: now };
}

async function driveIncremental(ctx: Ctx, account: string, idx: DriveIndex, cur: DriveCursor, out: Jsonl): Promise<DriveCursor> {
  let pageToken: string | undefined = cur.pageToken;
  let newStart: string | undefined;
  const changes: RawDriveChange[] = [];
  while (pageToken) {
    const page: DriveChangeList = await gjson<DriveChangeList>(ctx.tokens, account, withQuery(`${DRIVE}/changes`, {
      pageToken,
      includeItemsFromAllDrives: true,
      supportsAllDrives: true,
      includeRemoved: true,
      pageSize: 1000,
      fields: `nextPageToken,newStartPageToken,changes(changeType,removed,fileId,driveId,time,file(${FILE_FIELDS}))`,
    }));
    changes.push(...(page.changes ?? []));
    pageToken = page.nextPageToken;
    if (page.newStartPageToken) newStart = page.newStartPageToken;
  }
  const live = changes.map((c) => c.file).filter((f): f is RawDriveFile => !!f);
  for (const f of live) idx.remember(f);
  await idx.resolveAncestors(live);
  let removed = 0;
  for (const c of changes) {
    const rec = normaliseDriveChange(c, account, (f) => idx.pathOf(f));
    if (!rec) continue;
    if (rec.deleted) removed++;
    out.write(rec);
  }
  ctx.log(fmt(`  drive ${account}: ${changes.length} changes (${removed} removed/trashed)`));
  // newStartPageToken is only on the last page; if we somehow got none, keep the old token (safe: re-read).
  return { ...cur, pageToken: newStart ?? cur.pageToken, synced_at: new Date().toISOString() };
}

// ---------------------------------------------------------------------------------------
// Calendar
// ---------------------------------------------------------------------------------------

interface CalListEntry { id: string; summary?: string; deleted?: boolean; accessRole?: string; primary?: boolean }
interface CalList { items?: CalListEntry[]; nextPageToken?: string; nextSyncToken?: string }
interface EventList { items?: RawCalendarEvent[]; nextPageToken?: string; nextSyncToken?: string }

async function syncCalendarList(ctx: Ctx, account: string, cur: CalendarCursor): Promise<CalendarCursor> {
  const run = async (syncToken: string | undefined): Promise<CalendarCursor> => {
    const events = { ...cur.events };
    let pageToken: string | undefined;
    let next: string | undefined;
    do {
      const page = await gjson<CalList>(ctx.tokens, account, withQuery(`${CAL}/users/me/calendarList`, {
        // With syncToken, showDeleted/showHidden must not be false and minAccessRole is forbidden —
        // so we use the same (permissive) set on the initial call too.
        maxResults: 250, showDeleted: true, showHidden: true, syncToken, pageToken,
      }));
      // Primary + opted-in only (selectCalendars); everything else is logged once per run so a
      // calendar can be opted in later with --calendars. Deleted or de-selected ids leave the
      // cursor map, so their sync tokens are not replayed.
      const { selected, skipped } = selectCalendars(page.items ?? [], ctx.calendars);
      for (const c of page.items ?? []) if (!selected.includes(c)) delete events[c.id];
      for (const c of selected) if (!(c.id in events)) events[c.id] = '';
      for (const c of skipped) if (!ctx.skippedLogged.has(c.id)) { ctx.skippedLogged.add(c.id); ctx.log(fmt(`  calendar ${account}: skipping ${c.id}${c.summary ? ` (${c.summary})` : ''} [${c.accessRole ?? '?'}] — opt in with --calendars`)); }
      pageToken = page.nextPageToken;
      if (page.nextSyncToken) next = page.nextSyncToken;
    } while (pageToken);
    return { ...cur, events, ...(next ? { listSyncToken: next } : {}) };
  };
  try {
    return await run(cur.listSyncToken);
  } catch (e) {
    if (e instanceof HttpError && e.status === 410 && cur.listSyncToken) {
      ctx.log(fmt(`  calendar ${account}: calendarList sync token expired → full list`));
      return run(undefined);
    }
    throw e;
  }
}

/** One calendar: drain pages from `syncToken` (or everything), write records, return the new token. 410 → full. */
async function syncEvents(ctx: Ctx, account: string, calendarId: string, syncToken: string, out: Jsonl): Promise<string> {
  const run = async (token: string | undefined): Promise<string> => {
    let pageToken: string | undefined;
    let next: string | undefined;
    let n = 0;
    do {
      const page = await gjson<EventList>(ctx.tokens, account, withQuery(`${CAL}/calendars/${encodeURIComponent(calendarId)}/events`, {
        // Identical parameter set on every page: the sync token binds to it. timeMin/timeMax are
        // only legal on the INITIAL request (the token then remembers the window); keepCalendarEvent
        // re-applies the window client-side on every run regardless.
        singleEvents: true, showDeleted: true, maxResults: 2500, syncToken: token || undefined, pageToken,
        ...(token ? {} : { timeMin: ctx.calWindow.timeMin, timeMax: ctx.calWindow.timeMax }),
      }));
      for (const ev of page.items ?? []) {
        if (!keepCalendarEvent(ev, ctx.calWindow, { incremental: Boolean(token) })) continue;
        out.write(normaliseCalendarEvent(ev, account, calendarId)); n++;
      }
      pageToken = page.nextPageToken;
      if (page.nextSyncToken) next = page.nextSyncToken;
    } while (pageToken);
    if (n) ctx.log(fmt(`  calendar ${account}: ${calendarId} ${token ? '+' : 'full '}${n} events`));
    return next ?? token ?? '';
  };
  try {
    return await run(syncToken);
  } catch (e) {
    if (e instanceof HttpError && e.status === 410 && syncToken) {
      ctx.log(fmt(`  calendar ${account}: sync token for ${calendarId} expired → full resync`));
      return run(undefined);
    }
    throw e;
  }
}

async function pullCalendar(ctx: Ctx, account: string, cur: CalendarCursor | undefined, out: Jsonl): Promise<CalendarCursor> {
  const base: CalendarCursor = ctx.full || !cur ? { events: {}, synced_at: '' } : cur;
  const next = await syncCalendarList(ctx, account, base);
  for (const [calId, token] of Object.entries(next.events)) {
    next.events[calId] = await syncEvents(ctx, account, calId, token, out);
  }
  next.synced_at = new Date().toISOString();
  return next;
}

// ---------------------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------------------

export interface GooglePullOptions {
  /** Accounts to pull (lower-cased e-mails); every stored account when omitted. */
  accounts?: string[];
  /** Products to pull; default all three. */
  kinds?: GoogleKind[];
  /** YYYY-MM-DD lower bound for the FIRST backfill of Gmail/Drive. */
  since?: string;
  /** Ignore cursors and resync everything (duplicates are idempotent downstream). */
  full?: boolean;
  /** Calendar ids read in addition to the primary one. */
  calendars?: string[];
  calPastDays?: number;
  calFutureDays?: number;
  now?: Date;
}

/**
 * Pull every requested product for every requested account of one project. Never throws for a
 * per-account/per-product failure — those land in the summary (`ok=false`, `errors`), and a dead
 * credential sets `reauth` so the caller alerts instead of retrying. Throws only for operator
 * mistakes (bad `since`).
 */
export async function pullGoogle(pctx: PullContext, opts: GooglePullOptions = {}): Promise<PullSummary> {
  const startedAt = new Date().toISOString();
  if (opts.since && !/^\d{4}-\d{2}-\d{2}$/.test(opts.since)) throw new Error('since must be YYYY-MM-DD');
  const store = loadStore(pctx.tokenPath);
  const accounts = (opts.accounts?.length ? opts.accounts : Object.keys(store.accounts)).map((a) => a.toLowerCase());
  const kinds: GoogleKind[] = opts.kinds?.length ? opts.kinds : ['gmail', 'drive', 'calendar'];
  const warned = { vault: false };
  const ctx: Ctx = {
    tokens: new Tokens(store),
    outDir: pctx.outDir,
    full: opts.full === true,
    ...(opts.since ? { since: opts.since } : {}),
    calendars: opts.calendars ?? [],
    calWindow: calendarWindow(opts.now ?? new Date(), opts.calPastDays ?? 400, opts.calFutureDays ?? 120),
    log: pctx.log,
    sink: { log: pctx.log, warned, ...(pctx.vault ? { vault: pctx.vault } : {}) },
    skippedLogged: new Set(),
  };

  const cursorPath = join(ctx.outDir, 'google', 'cursor.json');
  const cursor = readJson<Cursor>(cursorPath, {});
  const summary: PullSummary = { kind: 'google', ok: true, reauth: false, counts: {}, errors: [], startedAt, finishedAt: startedAt };

  for (const account of accounts) {
    if (!store.accounts[account]) {
      summary.errors.push(`${account}: no credentials in ${pctx.tokenPath} — run: orch sources auth ${pctx.slug} google login --account ${account}`);
      summary.ok = false;
      continue;
    }
    const cur: AccountCursor = cursor[account] ?? {};
    for (const kind of kinds) {
      const file = { gmail: 'messages', drive: 'files', calendar: 'events' }[kind];
      const out = new Jsonl(join(ctx.outDir, 'google', account, `${file}.jsonl`), ctx.sink);
      const t0 = Date.now();
      try {
        if (kind === 'gmail') {
          cur.gmail = cur.gmail && !ctx.full ? await gmailIncremental(ctx, account, cur.gmail, out) : await gmailFull(ctx, account, out);
        } else if (kind === 'drive') {
          const idx = new DriveIndex(ctx, account);
          await idx.init();
          cur.drive = cur.drive && !ctx.full ? await driveIncremental(ctx, account, idx, cur.drive, out) : await driveFull(ctx, account, idx, out);
        } else {
          cur.calendar = await pullCalendar(ctx, account, cur.calendar, out);
        }
        // Persist the cursor only after the product drained cleanly: a crash mid-product re-reads
        // the same window next run (duplicates are idempotent; gaps are not).
        cursor[account] = cur;
        writeJsonAtomic(cursorPath, cursor);
        summary.counts[`${account}/${kind}`] = out.count;
        ctx.log(`${account}/${kind}: ${out.count} records in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
      } catch (e) {
        summary.ok = false;
        if (e instanceof ReauthRequired) {
          summary.reauth = true;
          summary.errors.push(`REAUTH ${e.message}`);
          ctx.log(`REAUTH ${e.message}`);
          break; // every product of this account needs the same fix
        }
        summary.errors.push(`${account}/${kind}: ${(e as Error).message}`);
        ctx.log(`${account}/${kind}: FAILED ${(e as Error).message}`);
      } finally {
        out.close();
      }
    }
  }
  summary.finishedAt = new Date().toISOString();
  return summary;
}
