/**
 * Incremental, read-only puller: every conversation the user is a member of, in every stored
 * workspace of one project, → normalised JSONL. Entry point `pullSlack(ctx, opts)`; each run
 * only fetches what is new.
 *
 * Output under `<ctx.outDir>/slack/`:
 *   slack.messages.jsonl   one MessageRecord per line, append-only, oldest-first within a run
 *   slack.files.jsonl      one FileRecord per attachment (metadata only)
 *   slack.cursor.json      per workspace / per conversation: last ts seen + watched threads
 *   slack.users.json       users.list cache per workspace (names for ids; refreshed daily)
 *
 * Strategy (and why):
 *  - users.conversations (Tier 3) is the membership-scoped primitive — exactly "what the user
 *    sees", including archived channels and Slack Connect channels they are in.
 *    https://docs.slack.dev/reference/methods/users.conversations
 *  - conversations.history with `oldest=<last ts>` (exclusive) per conversation; pages are
 *    newest-first, so we collect a conversation, sort, then write — the cursor only advances
 *    after the write, so a crash re-reads at most one conversation (dedupe on `id` downstream).
 *    https://docs.slack.dev/reference/methods/conversations.history
 *  - Thread replies are NOT in history. Parents with replies go into a watch list; every run
 *    calls conversations.replies with `oldest=<last reply ts>` for parents younger than the
 *    thread window. That is the dominant cost (one call per live thread per run), which is
 *    why the window is bounded. https://docs.slack.dev/reference/methods/conversations.replies
 *  - Polling is the source of truth; Socket Mode (if ever added) is only a latency optimisation
 *    with no replay.
 *  - Edits and deletes: history is re-read from `now − edit window` (default 48 h) instead of from
 *    `last_ts`, and the cursor keeps `recent` = {ts → edited.ts} for that window. A message that was
 *    in `recent` but is gone from the fetch → tombstone `{deleted:true}`; one whose edited.ts moved →
 *    the record is re-emitted. Readers compact by id (last record wins, tombstone wins). This is what
 *    makes "pasted the password, deleted it a minute later" leave no copy on disk. The window bounds
 *    the cost: one history page per conversation per run regardless.
 *  - Socket Mode payloads with subtype message_deleted / message_changed are mapped by
 *    `toRecords()` below to the same tombstone / replacement shapes, so the two paths converge.
 *  - Per-conversation refusals (channel_not_found for the Slackbot DM, not_in_channel, …) are
 *    skipped and reported; auth errors propagate — a dead token is a workspace-level fact.
 *  - Rate limits are per method per workspace per app: the client paces 1 req/s per method
 *    and honours 429 Retry-After. https://docs.slack.dev/apis/web-api/rate-limits
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { loadStore, saveStore, SlackClient, SlackApiError, SlackAuthError, type WorkspaceRecord, type TokenStore } from './client.js';
import {
  compareTs,
  isThreadParent,
  normaliseFiles,
  normaliseMessage,
  sortByTs,
  type RawConversation,
  type RawMessage,
  type RawUser,
  type WorkspaceContext,
} from './normalise.js';
import { scrubForWrite, type SinkOptions } from '../common/sink.js';
import type { PullContext, PullSummary } from '../types.js';

// ---------------------------------------------------------------------------------------
// Cursor + caches on disk
// ---------------------------------------------------------------------------------------

interface ThreadCursor {
  /** Last reply ts written; next replies call uses it as `oldest` (exclusive). */
  last_reply_ts: string;
  /** First 200 chars of the parent, so replies get a `subject` without re-fetching the parent. */
  parent_text: string;
}

interface ConversationCursor {
  /** Newest message ts written. Next history call uses it as `oldest` (exclusive). */
  last_ts: string;
  /** Archived conversations never change: synced once, then skipped (saves one call per run each). */
  archived_done?: boolean;
  /** Parent ts → thread state, pruned once the parent is older than the thread window. */
  threads: Record<string, ThreadCursor>;
  /** ts → `edited.ts` ('' when never edited) for messages inside the edit window — deletion/edit detection. */
  recent?: Record<string, string>;
}

/** A deleted message leaves this behind in messages.jsonl; readers drop the id. */
interface SlackTombstone {
  source: 'slack';
  account: string;
  id: string;
  deleted: true;
}

interface WorkspaceCursor {
  conversations: Record<string, ConversationCursor>;
}

interface Cursor {
  version: 1;
  workspaces: Record<string, WorkspaceCursor>;
}

interface UsersCache {
  [team_id: string]: { fetched_at: string; users: RawUser[] };
}

async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8')) as T;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return fallback;
    throw err;
  }
}

/** tmp + rename: a cron run killed mid-write must not leave a half cursor (that would re-pull or, worse, skip). */
async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`);
  await fs.rename(tmp, file);
}

async function appendJsonl(file: string, rows: unknown[]): Promise<void> {
  if (!rows.length) return;
  await fs.appendFile(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
}

// ---------------------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------------------

export interface SlackPullOptions {
  /** Team ids (T…) to pull; every stored workspace when empty. */
  workspaces?: string[];
  /** ISO date overriding the per-workspace backfill_days for first-time conversations. */
  since?: string;
  /** Poll thread replies (default true). */
  threads?: boolean;
  threadWindowDays?: number;
  /** Only list what the token sees; write nothing. */
  list?: boolean;
  refreshUsers?: boolean;
  /** Hours of history re-read each run to catch edits and deletions. 0 disables. Default 48. */
  editWindowHours?: number;
}

interface Options {
  workspaces: string[];
  since?: string;
  threads: boolean;
  threadWindowDays: number;
  list: boolean;
  refreshUsers: boolean;
  editWindowHours: number;
}

/** Slack ts for "now minus N days" — the `oldest` of a first backfill. */
function tsDaysAgo(days: number): string {
  return (Math.floor(Date.now() / 1000) - days * 86400).toFixed(6);
}

function tsHoursAgo(hours: number): string {
  return (Math.floor(Date.now() / 1000) - hours * 3600).toFixed(6);
}

function isoToTs(iso: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) throw new Error(`--since must be an ISO date, got ${iso}`);
  return (ms / 1000).toFixed(6);
}

// ---------------------------------------------------------------------------------------
// Per-workspace sync
// ---------------------------------------------------------------------------------------

/** Per-conversation API answers that mean "not readable for this token", never "token dead". */
const SKIPPABLE_CODES = new Set(['channel_not_found', 'not_in_channel', 'is_archived', 'method_not_supported_for_channel_type']);

interface Stats {
  conversations: number;
  tombstones: number;
  messages: number;
  replies: number;
  files: number;
  calls: number;
  limited: string[];
  /** Conversations skipped because Slack refused their history (e.g. the Slackbot DM → channel_not_found). */
  skipped: string[];
}

class WorkspaceSync {
  private stats: Stats = { conversations: 0, tombstones: 0, messages: 0, replies: 0, files: 0, calls: 0, limited: [], skipped: [] };
  private ctx!: WorkspaceContext;
  private usersRefreshedThisRun = false;

  constructor(
    private readonly client: SlackClient,
    private readonly opts: Options,
    private readonly cursor: WorkspaceCursor,
    private readonly usersCache: UsersCache,
    private readonly files: { messages: string; files: string; cursor: string; users: string },
    private readonly persistCursor: () => Promise<void>,
    private readonly log: (m: string) => void,
    private readonly sink: SinkOptions,
  ) {}

  get ws(): WorkspaceRecord {
    return this.client.ws;
  }

  async run(): Promise<Stats> {
    await this.client.ensureFresh();
    await this.loadUsers(this.opts.refreshUsers);
    const convs = await this.listConversations();
    if (this.opts.list) {
      for (const c of convs) this.log(`  ${c.id}  ${kind(c).padEnd(8)} ${c.is_archived ? '[archived] ' : ''}${label(c)}`);
      return this.stats;
    }
    for (const conv of convs) {
      try {
        await this.syncConversation(conv);
      } catch (err) {
        // One conversation Slack will not serve must not abort the other 130. Seen live: the Slackbot DM
        // (D…, user USLACKBOT) answers conversations.history with channel_not_found for a user token.
        // Auth errors propagate — a dead token is a workspace-level fact, not a per-conversation one.
        if (err instanceof SlackApiError && SKIPPABLE_CODES.has(err.code)) {
          this.stats.skipped.push(`${label(conv)} (${err.code})`);
          this.log(`  [${this.ws.team}] ${label(conv)}: skipped — ${err.method} ${err.code}`);
          continue;
        }
        throw err;
      }
    }
    this.pruneThreads();
    await this.persistCursor();
    return this.stats;
  }

  /**
   * users.list: Tier 2, ≤200 per page recommended. Cached for 24 h; refreshed early at most
   * once per run when a message references an unknown user (new colleague, Slack Connect guest).
   * https://docs.slack.dev/reference/methods/users.list
   */
  private async loadUsers(force: boolean): Promise<void> {
    const cached = this.usersCache[this.ws.team_id];
    const stale = !cached || Date.now() - Date.parse(cached.fetched_at) > 24 * 3600 * 1000;
    if (cached && !stale && !force) {
      this.setUsers(cached.users);
      return;
    }
    const users: RawUser[] = [];
    for await (const page of this.client.paginate('users.list', { limit: 200 })) {
      this.stats.calls++;
      users.push(...((page.members as RawUser[]) ?? []));
    }
    this.usersCache[this.ws.team_id] = { fetched_at: new Date().toISOString(), users };
    await writeJsonAtomic(this.files.users, this.usersCache);
    this.setUsers(users);
    this.log(`  [${this.ws.team}] users: ${users.length}`);
  }

  private setUsers(users: RawUser[]): void {
    this.ctx = { team_id: this.ws.team_id, url: this.ws.url, self_user_id: this.ws.user_id, users: new Map(users.map((u) => [u.id, u])) };
  }

  private async ensureUsersKnown(msgs: RawMessage[]): Promise<void> {
    if (this.usersRefreshedThisRun) return;
    if (msgs.some((m) => m.user && !this.ctx.users.has(m.user))) {
      this.usersRefreshedThisRun = true;
      await this.loadUsers(true);
    }
  }

  private async listConversations(): Promise<RawConversation[]> {
    const out: RawConversation[] = [];
    for await (const page of this.client.paginate('users.conversations', {
      types: 'public_channel,private_channel,mpim,im',
      exclude_archived: false,
      limit: 999,
    })) {
      this.stats.calls++;
      out.push(...((page.channels as RawConversation[]) ?? []));
    }
    this.log(`  [${this.ws.team}] conversations: ${out.length}`);
    return out;
  }

  private async syncConversation(conv: RawConversation): Promise<void> {
    const cur = this.cursor.conversations[conv.id] ?? { last_ts: '', threads: {} };
    if (conv.is_archived && cur.archived_done) return;
    this.stats.conversations++;

    // First contact: bound the backfill. `--since` wins; otherwise the per-workspace policy.
    // Later runs: start at `last_ts` OR the edit window, whichever is older, so recent edits and
    // deletions are observed (see header). Archived conversations cannot change → no window.
    const windowOldest = this.opts.editWindowHours > 0 && !conv.is_archived ? tsHoursAgo(this.opts.editWindowHours) : '';
    const firstContact = !cur.last_ts;
    const oldest = firstContact
      ? this.opts.since ? isoToTs(this.opts.since) : tsDaysAgo(this.ws.backfill_days)
      : windowOldest && compareTs(windowOldest, cur.last_ts) < 0 ? windowOldest : cur.last_ts;
    const raw: RawMessage[] = [];
    for await (const page of this.client.paginate('conversations.history', { channel: conv.id, oldest, limit: 999 })) {
      this.stats.calls++;
      raw.push(...((page.messages as RawMessage[]) ?? []));
      // Free-plan truncation: Slack says so explicitly; surface it once per conversation.
      if (page.is_limited && !this.stats.limited.includes(conv.id)) this.stats.limited.push(conv.id);
    }
    await this.ensureUsersKnown(raw);

    const msgs = sortByTs(raw);
    const records: Array<ReturnType<typeof scrubForWrite> | SlackTombstone> = [];
    const fileRecords = [];
    const recent = cur.recent ?? {};
    const seen: Record<string, string> = {};
    for (const m of msgs) {
      const editedTs = m.edited?.ts ?? '';
      const reRead = !firstContact && compareTs(m.ts, cur.last_ts) <= 0;
      if (reRead) {
        // Already written in an earlier run. Re-emit only when it changed; if it predates `recent`
        // tracking (not in the map) we cannot tell, so leave it alone rather than duplicate.
        const known = recent[m.ts];
        if (known === undefined || known === editedTs) {
          if (compareTs(m.ts, windowOldest || '0') >= 0) seen[m.ts] = editedTs;
          continue;
        }
      }
      for (const out of toRecords(m, conv, this.ctx)) {
        if ('deleted' in out) records.push(out);
        else records.push(scrubForWrite(out, this.sink));
      }
      fileRecords.push(...normaliseFiles(m, conv, this.ctx));
      if (compareTs(m.ts, windowOldest || '0') >= 0) seen[m.ts] = editedTs;
      if (isThreadParent(m) && !cur.threads[m.ts]) {
        // New thread: replies from the parent itself (exclusive), i.e. everything.
        cur.threads[m.ts] = { last_reply_ts: m.ts, parent_text: (m.text ?? '').slice(0, 200) };
      }
    }
    // Deletions: tracked inside the window last run, absent from this fetch → tombstone.
    if (windowOldest) {
      for (const ts of Object.keys(recent)) {
        if (compareTs(ts, windowOldest) >= 0 && !(ts in seen)) {
          records.push({ source: 'slack', account: this.ws.team_id, id: `${conv.id}:${ts}`, deleted: true });
          this.stats.tombstones++;
        }
      }
      cur.recent = seen;
    } else delete cur.recent;
    await appendJsonl(this.files.messages, records);
    await appendJsonl(this.files.files, fileRecords);
    this.stats.messages += records.length;
    this.stats.files += fileRecords.length;
    const last = msgs.at(-1)?.ts;
    if (last && compareTs(last, cur.last_ts || '0') > 0) cur.last_ts = last;
    if (conv.is_archived) cur.archived_done = true;
    this.cursor.conversations[conv.id] = cur;

    if (this.opts.threads) await this.syncThreads(conv, cur);
    // Checkpoint after every conversation so an interrupted run resumes here, not at the top.
    await this.persistCursor();
    if (records.length) this.log(`  [${this.ws.team}] ${label(conv)}: +${records.length}`);
  }

  /**
   * Replies for every watched parent inside the window. `oldest` = last reply we wrote, so a
   * quiet thread costs one small call and a busy one pages. The parent comes back as the
   * first item of conversations.replies regardless of `oldest`; filter it by ts.
   */
  private async syncThreads(conv: RawConversation, cur: ConversationCursor): Promise<void> {
    const windowStart = tsDaysAgo(this.opts.threadWindowDays);
    for (const [parentTs, t] of Object.entries(cur.threads)) {
      if (compareTs(parentTs, windowStart) < 0) continue;
      const raw: RawMessage[] = [];
      for await (const page of this.client.paginate('conversations.replies', { channel: conv.id, ts: parentTs, oldest: t.last_reply_ts, limit: 999 })) {
        this.stats.calls++;
        raw.push(...((page.messages as RawMessage[]) ?? []));
      }
      const replies = sortByTs(raw.filter((m) => m.ts !== parentTs && compareTs(m.ts, t.last_reply_ts) > 0));
      if (!replies.length) continue;
      await this.ensureUsersKnown(replies);
      const records = [];
      const fileRecords = [];
      for (const m of replies) {
        const rec = normaliseMessage(m, conv, this.ctx, { parentText: t.parent_text });
        if (rec) records.push(scrubForWrite(rec, this.sink));
        fileRecords.push(...normaliseFiles(m, conv, this.ctx));
      }
      await appendJsonl(this.files.messages, records);
      await appendJsonl(this.files.files, fileRecords);
      this.stats.replies += records.length;
      this.stats.files += fileRecords.length;
      t.last_reply_ts = replies.at(-1)!.ts;
    }
  }

  /** Threads older than the window stop being polled. Replies to them after that are only visible via a `--since` re-pull or Socket Mode. */
  private pruneThreads(): void {
    const windowStart = tsDaysAgo(this.opts.threadWindowDays);
    for (const cur of Object.values(this.cursor.conversations)) {
      for (const parentTs of Object.keys(cur.threads)) if (compareTs(parentTs, windowStart) < 0) delete cur.threads[parentTs];
    }
  }
}

/**
 * One raw message → records to append. History never carries these subtypes, but Socket Mode
 * does: `message_deleted` (deleted_ts) → tombstone; `message_changed` (`message` = new content,
 * `previous_message` = old) → the new content as a normal record, which readers treat as a
 * replacement because the id (channel:ts) is the same.
 */
function toRecords(m: RawMessage, conv: RawConversation, ctx: WorkspaceContext): Array<NonNullable<ReturnType<typeof normaliseMessage>> | SlackTombstone> {
  const ev = m as RawMessage & { deleted_ts?: string; message?: RawMessage };
  if (m.subtype === 'message_deleted' && ev.deleted_ts) return [{ source: 'slack', account: ctx.team_id, id: `${conv.id}:${ev.deleted_ts}`, deleted: true }];
  const target = m.subtype === 'message_changed' && ev.message ? ev.message : m;
  const rec = normaliseMessage(target, conv, ctx);
  return rec ? [rec] : [];
}

function kind(c: RawConversation): string {
  return c.is_im ? 'im' : c.is_mpim ? 'mpim' : c.is_private ? 'private' : 'public';
}

/** Log label only; records use `containerLabel()` from normalise.ts, which resolves names. */
function label(c: RawConversation): string {
  return c.is_im ? `dm ${c.user ?? c.id}` : c.is_mpim ? `mpim ${c.id}` : `#${c.name ?? c.id}`;
}

// ---------------------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------------------

export async function pullSlack(pctx: PullContext, o: SlackPullOptions = {}): Promise<PullSummary> {
  const startedAt = new Date().toISOString();
  const opts: Options = {
    workspaces: o.workspaces ?? [],
    ...(o.since ? { since: o.since } : {}),
    threads: o.threads ?? true,
    threadWindowDays: o.threadWindowDays ?? 30,
    list: o.list ?? false,
    refreshUsers: o.refreshUsers ?? false,
    editWindowHours: o.editWindowHours ?? 48,
  };
  const log = pctx.log;
  const dir = path.join(pctx.outDir, 'slack');
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const files = {
    messages: path.join(dir, 'slack.messages.jsonl'),
    files: path.join(dir, 'slack.files.jsonl'),
    cursor: path.join(dir, 'slack.cursor.json'),
    users: path.join(dir, 'slack.users.json'),
  };
  const store: TokenStore = await loadStore(pctx.tokenPath);
  const cursor = await readJson<Cursor>(files.cursor, { version: 1, workspaces: {} });
  const usersCache = await readJson<UsersCache>(files.users, {});
  const sink: SinkOptions = { log, warned: { vault: false }, ...(pctx.vault ? { vault: pctx.vault } : {}) };
  const summary: PullSummary = { kind: 'slack', ok: true, reauth: false, counts: {}, errors: [], startedAt, finishedAt: startedAt };

  const wanted = new Set(opts.workspaces);
  const targets = Object.values(store.workspaces).filter((w) => !wanted.size || wanted.has(w.team_id) || wanted.has(w.team));
  if (!targets.length) {
    summary.ok = false;
    summary.errors.push(opts.workspaces.length ? `no stored workspace among ${opts.workspaces.join(', ')}` : `no workspaces stored in ${pctx.tokenPath} — run: orch sources auth ${pctx.slug} slack add`);
    summary.finishedAt = new Date().toISOString();
    return summary;
  }
  for (const ws of targets) {
    log(`[${ws.team}] ${ws.team_id} as ${ws.user}`);
    const client = new SlackClient(ws, async (updated) => {
      // Rotation only: the new single-use refresh token must hit disk before any further call.
      store.workspaces[updated.team_id] = updated;
      await saveStore(store, pctx.tokenPath);
    }, log);
    const wsCursor = (cursor.workspaces[ws.team_id] ??= { conversations: {} });
    const sync = new WorkspaceSync(client, opts, wsCursor, usersCache, files, () => writeJsonAtomic(files.cursor, cursor), log, sink);
    try {
      const s = await sync.run();
      summary.counts[`${ws.team_id}/messages`] = s.messages;
      summary.counts[`${ws.team_id}/replies`] = s.replies;
      summary.counts[`${ws.team_id}/files`] = s.files;
      summary.counts[`${ws.team_id}/tombstones`] = s.tombstones;
      if (!opts.list) {
        log(`[${ws.team}] done: ${s.conversations} conversations, +${s.messages} messages (${s.tombstones} tombstones), +${s.replies} replies, +${s.files} files, ${s.calls} API calls`);
        if (s.limited.length) log(`[${ws.team}] WARNING free-plan history limit hit in ${s.limited.length} conversation(s) — older messages are not retrievable via the API`);
        if (s.skipped.length) log(`[${ws.team}] skipped ${s.skipped.length} conversation(s): ${s.skipped.join(', ')}`);
      }
    } catch (err) {
      summary.ok = false;
      // A dead token in one workspace must not stop the others; the summary tells the caller.
      if (err instanceof SlackAuthError) {
        summary.reauth = true;
        summary.errors.push(`[${ws.team}] TOKEN DEAD (${err.code}) — run: orch sources auth ${pctx.slug} slack add`);
      } else summary.errors.push(`[${ws.team}] ${err instanceof Error ? err.message : String(err)}`);
      log(summary.errors.at(-1)!);
    }
  }
  summary.finishedAt = new Date().toISOString();
  return summary;
}
