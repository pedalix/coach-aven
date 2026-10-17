/**
 * Pure mapping from raw Slack Web API JSON to the source record shapes (docs/sources.md).
 *
 * Why a separate module: everything in here is testable without a token, and the puller
 * (`pull.ts`) should stay a thin loop of "page, map, append, advance cursor". Keeping the
 * mapping pure also means a scrubbed fixture of a real envelope is enough to lock the
 * behaviour down — the fixtures in `normalise.test.ts` follow the field names documented at
 * https://docs.slack.dev/reference/methods/conversations.history and
 * https://docs.slack.dev/reference/methods/users.conversations.
 *
 * No SDK on purpose: the sandbox runs with built-ins + fetch only, and the Slack message
 * object is small enough that hand-written types beat a 40 MB dependency.
 */

// ---------------------------------------------------------------------------------------
// Output shapes (shared contract with the other connectors — keep field names identical).
// ---------------------------------------------------------------------------------------

export interface MessageRecord {
  source: 'slack';
  /** Workspace team id (`T...`). Stable across renames, unlike the workspace domain. */
  account: string;
  /** Human-readable container: `#channel`, `dm:@handle`, `mpim:@a+@b` — ids live in `raw_ref`. */
  container: string;
  /** `<channel id>:<ts>` — Slack's own identity for a message is (channel, ts). */
  id: string;
  /** ISO-8601 UTC, millisecond precision (Slack `ts` is seconds with 6 decimals). */
  ts: string;
  /** Display name of the author (resolved via users.list), or the bot name, or the raw id. */
  author: string;
  /** Author + everyone the message addresses (mentions, DM counterpart, mpim members). */
  participants: string[];
  /** Slack has no subjects; only set for thread replies: `re: <first 60 chars of parent>`. */
  subject?: string;
  /** Text with `<@U..>` / `<#C..|name>` / `<url|label>` mrkdwn tokens flattened for humans. */
  text: string;
  permalink: string;
  /** `slack:<team>/<channel>/<ts>` (+ `#<thread_ts>` for replies) — enough to re-fetch the raw object. */
  raw_ref: string;
  /** Posted by an app/integration (bot_id, bot_message, or a users-map bot) — search hides these by default. */
  is_bot?: boolean;
}

export interface FileRecord {
  source: 'slack';
  account: string;
  id: string;
  name: string;
  /** Where the file surfaced: the container of the message it was attached to. */
  path: string;
  mime: string;
  modified: string;
  size: number;
  /** `permalink` of the file (the Slack UI page), not `url_private` (needs the token to open). */
  link: string;
}

// ---------------------------------------------------------------------------------------
// Raw Slack shapes — only the fields we read. Everything else is `unknown` by omission.
// ---------------------------------------------------------------------------------------

export interface RawUser {
  id: string;
  /** Legacy handle (`owen`) — still what mpim conversation names are built from. */
  name: string;
  real_name?: string;
  deleted?: boolean;
  is_bot?: boolean;
  profile?: { display_name?: string; real_name?: string };
}

export interface RawConversation {
  id: string;
  /** Channel name, or `mpdm-a--b--c-1` for mpims; absent on ims. */
  name?: string;
  is_channel?: boolean;
  is_group?: boolean;
  is_im?: boolean;
  is_mpim?: boolean;
  is_private?: boolean;
  is_archived?: boolean;
  is_ext_shared?: boolean;
  /** Only on ims: the other party. */
  user?: string;
  topic?: { value: string };
  purpose?: { value: string };
}

export interface RawFile {
  id: string;
  name?: string;
  title?: string;
  mimetype?: string;
  filetype?: string;
  size?: number;
  /** Seconds since epoch. */
  timestamp?: number;
  created?: number;
  permalink?: string;
  url_private?: string;
  /** Files whose source left the workspace / was deleted still appear as stubs. */
  mode?: string;
}

export interface RawMessage {
  type: 'message';
  subtype?: string;
  ts: string;
  user?: string;
  bot_id?: string;
  username?: string;
  bot_profile?: { name?: string };
  text?: string;
  thread_ts?: string;
  reply_count?: number;
  latest_reply?: string;
  reply_users?: string[];
  edited?: { user: string; ts: string };
  files?: RawFile[];
  /** Channel-level attachments (unfurls, legacy bot attachments) carry their own text. */
  attachments?: Array<{ title?: string; text?: string; fallback?: string }>;
  /** Message metadata (pulled with include_all_metadata): a marked post of the bot carries MARKED_EVENT. */
  metadata?: { event_type?: string };
}

/**
 * The metadata event type of the bot's posts in a conversation that holds another domain's data
 * (agent-messaging D14; chat/driver.ts MARKED_EVENT). Such a post is never ingested: the store would
 * otherwise carry that data to the project's unmarked conversations.
 */
export const MARKED_EVENT = 'aven_marked';
export const isMarked = (msg: RawMessage): boolean => msg.metadata?.event_type === MARKED_EVENT;

/** What the mapper needs to know about the workspace it is mapping for. */
export interface WorkspaceContext {
  team_id: string;
  /** `https://pedalix.slack.com/` as returned by auth.test — permalinks are built on it. */
  url: string;
  /** Owen's own user id, so DM containers are named after the *other* party. */
  self_user_id: string;
  users: Map<string, RawUser>;
}

// ---------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------

/** Slack `ts` is `<seconds>.<6-digit sequence>`; the fraction is a tiebreaker, not real µs, but it is monotonic so we keep ms. */
export function slackTsToIso(ts: string): string {
  const [sec = '0', frac = '0'] = ts.split('.');
  const ms = Number(sec) * 1000 + Math.floor(Number(`0.${frac}`) * 1000);
  return new Date(ms).toISOString();
}

/** Numeric comparison of Slack ts strings (string compare breaks across the 10-digit boundary and on fraction length). */
export function compareTs(a: string, b: string): number {
  return Number(a) - Number(b);
}

/** Display name preference: profile.display_name → real_name → handle → raw id. Matches what the Slack UI shows. */
export function userLabel(id: string, users: Map<string, RawUser>): string {
  const u = users.get(id);
  if (!u) return id;
  return u.profile?.display_name || u.real_name || u.profile?.real_name || u.name || id;
}

/** `@handle` form for container names — handles are stable and short; display names change and may contain spaces. */
export function userHandle(id: string, users: Map<string, RawUser>): string {
  const u = users.get(id);
  return u ? `@${u.name}` : id;
}

/**
 * Container label for a conversation. Why names over ids: the ledger is read by a human
 * ("what did I promise in #hcg-p5?"); the id stays in `raw_ref` for machines.
 *
 * mpim naming: Slack gives `mpdm-alice--bob--carol-1` (legacy handles joined by `--`, a
 * trailing `-<n>` disambiguator). We rebuild from that rather than paying a Tier 4
 * conversations.members call per mpim per run.
 */
export function containerLabel(conv: RawConversation, ctx: WorkspaceContext): string {
  if (conv.is_im) return `dm:${conv.user ? userHandle(conv.user, ctx.users) : conv.id}`;
  if (conv.is_mpim) {
    const handles = mpimHandles(conv.name ?? '').filter((h) => h !== selfHandle(ctx));
    return `mpim:${handles.map((h) => `@${h}`).join('+') || conv.id}`;
  }
  return `#${conv.name ?? conv.id}`;
}

function selfHandle(ctx: WorkspaceContext): string {
  return ctx.users.get(ctx.self_user_id)?.name ?? '';
}

/** `mpdm-alice--bob--carol-1` → ['alice','bob','carol']. Anything that is not that shape yields []. */
export function mpimHandles(name: string): string[] {
  const m = /^mpdm-(.+?)-\d+$/.exec(name);
  if (!m || !m[1]) return [];
  return m[1].split('--').filter(Boolean);
}

/** Members of a conversation that we can know without an extra API call (DM: both; mpim: parsed name; channel: none). */
export function knownMembers(conv: RawConversation, ctx: WorkspaceContext): string[] {
  if (conv.is_im) return [ctx.self_user_id, ...(conv.user ? [conv.user] : [])];
  if (conv.is_mpim) {
    const byHandle = new Map([...ctx.users.values()].map((u) => [u.name, u.id] as const));
    return mpimHandles(conv.name ?? '').map((h) => byHandle.get(h) ?? h);
  }
  return [];
}

/** All `<@U...>` ids in a text, in order, deduplicated. */
export function mentionedUserIds(text: string): string[] {
  const ids = new Set<string>();
  for (const m of text.matchAll(/<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/g)) ids.add(m[1]!);
  return [...ids];
}

/**
 * Flatten Slack mrkdwn tokens: https://docs.slack.dev/messaging/formatting-message-text
 *  - `<@U123>` / `<@U123|label>`   → `@Display Name`
 *  - `<#C123|general>`             → `#general`
 *  - `<!channel>` / `<!here>`      → `@channel` / `@here`
 *  - `<!subteam^S1|@eng>`          → `@eng`
 *  - `<https://x|label>`           → `label (https://x)`;  `<https://x>` → `https://x`
 *  - `&amp; &lt; &gt;`             → `& < >` (Slack escapes only these three)
 */
export function flattenText(text: string, users: Map<string, RawUser>): string {
  return text
    .replace(/<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/g, (_m, id: string) => `@${userLabel(id, users)}`)
    .replace(/<#([CG][A-Z0-9]+)\|([^>]*)>/g, (_m, _id, name: string) => `#${name}`)
    .replace(/<#([CG][A-Z0-9]+)>/g, (_m, id: string) => `#${id}`)
    .replace(/<!subteam\^[^|>]+\|([^>]*)>/g, (_m, label: string) => label)
    .replace(/<!(channel|here|everyone)(?:\|[^>]*)?>/g, (_m, kw: string) => `@${kw}`)
    .replace(/<!date\^\d+\^[^|>]*\|([^>]*)>/g, (_m, fallback: string) => fallback)
    .replace(/<((?:https?|mailto):[^|>]+)\|([^>]*)>/g, (_m, url: string, label: string) =>
      // Slack labels bare links with themselves (`<mailto:x@y|x@y>`): no point repeating.
      label === url || url === `mailto:${label}` ? label : `${label} (${url})`,
    )
    .replace(/<((?:https?|mailto):[^>]+)>/g, (_m, url: string) => url)
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

/**
 * Message subtypes that carry no human content. They still come back from history and we
 * drop them *before* writing so the ledger does not fill with "X joined #y". Kept small and
 * explicit: unknown subtypes pass through (better a stray line than a silent gap).
 * Subtype list: https://docs.slack.dev/reference/events/message
 */
export const NOISE_SUBTYPES: ReadonlySet<string> = new Set([
  'channel_join',
  'channel_leave',
  'group_join',
  'group_leave',
  'channel_topic',
  'channel_purpose',
  'channel_name',
  'channel_archive',
  'channel_unarchive',
  'bot_add',
  'bot_remove',
  'pinned_item',
  'unpinned_item',
  'tombstone',
  'joiner_notification',
  'sh_room_created',
]);

export function isNoise(msg: RawMessage): boolean {
  return msg.subtype !== undefined && NOISE_SUBTYPES.has(msg.subtype);
}

/** Thread reply = has a thread_ts that is not its own ts (parents carry thread_ts === ts). */
export function isThreadReply(msg: RawMessage): boolean {
  return msg.thread_ts !== undefined && msg.thread_ts !== msg.ts;
}

/** Parents that have replies worth fetching with conversations.replies. */
export function isThreadParent(msg: RawMessage): boolean {
  return msg.thread_ts === msg.ts && (msg.reply_count ?? 0) > 0;
}

/**
 * Permalink without calling chat.getPermalink (Tier 4, one per message — never worth it).
 * Format is the one Slack's own UI produces: `<workspace url>/archives/<channel>/p<ts sans dot>`,
 * with `?thread_ts=<parent>&cid=<channel>` for replies so the link opens the thread pane.
 */
export function permalink(url: string, channel: string, ts: string, threadTs?: string): string {
  const base = `${url.replace(/\/+$/, '')}/archives/${channel}/p${ts.replace('.', '')}`;
  return threadTs && threadTs !== ts ? `${base}?thread_ts=${threadTs}&cid=${channel}` : base;
}

export function authorLabel(msg: RawMessage, users: Map<string, RawUser>): string {
  if (msg.user) return userLabel(msg.user, users);
  // Bot messages: `bot_profile.name` is the app name; `username` is the legacy webhook name.
  return msg.bot_profile?.name || msg.username || msg.bot_id || 'unknown';
}

// ---------------------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------------------

export interface MapOptions {
  /** First ~60 chars of the parent text, when mapping a reply; becomes `subject`. */
  parentText?: string;
}

/**
 * One raw message → one MessageRecord. Returns null for noise subtypes so callers can
 * `.map().filter(Boolean)` without re-checking.
 */
export function normaliseMessage(
  msg: RawMessage,
  conv: RawConversation,
  ctx: WorkspaceContext,
  opts: MapOptions = {},
): MessageRecord | null {
  if (isNoise(msg) || isMarked(msg)) return null;

  const rawText = messageText(msg);
  const author = authorLabel(msg, ctx.users);
  const participantIds = new Set<string>();
  if (msg.user) participantIds.add(msg.user);
  for (const id of knownMembers(conv, ctx)) participantIds.add(id);
  for (const id of mentionedUserIds(rawText)) participantIds.add(id);
  for (const id of msg.reply_users ?? []) participantIds.add(id);
  const participants = [...participantIds].map((id) => userLabel(id, ctx.users));
  // A bot author is not a user id, but it is still a participant.
  if (!msg.user) participants.unshift(author);

  const reply = isThreadReply(msg);
  const record: MessageRecord = {
    source: 'slack',
    account: ctx.team_id,
    container: containerLabel(conv, ctx),
    id: `${conv.id}:${msg.ts}`,
    ts: slackTsToIso(msg.ts),
    author,
    participants: [...new Set(participants)],
    text: flattenText(rawText, ctx.users),
    permalink: permalink(ctx.url, conv.id, msg.ts, msg.thread_ts),
    raw_ref: `slack:${ctx.team_id}/${conv.id}/${msg.ts}${reply ? `#${msg.thread_ts}` : ''}`,
  };
  if (!msg.user || msg.bot_id || msg.subtype === 'bot_message' || ctx.users.get(msg.user)?.is_bot) record.is_bot = true;
  if (reply && opts.parentText) record.subject = `re: ${truncate(flattenText(opts.parentText, ctx.users), 60)}`;
  return record;
}

/** Text as a human would read it: body, then any attachment text, then file names (so a bare file share is not an empty line). */
function messageText(msg: RawMessage): string {
  const parts: string[] = [];
  if (msg.text) parts.push(msg.text);
  for (const a of msg.attachments ?? []) {
    const t = [a.title, a.text].filter(Boolean).join(': ') || a.fallback;
    if (t) parts.push(t);
  }
  if (msg.files?.length) parts.push(msg.files.map((f) => `[file: ${f.title || f.name || f.id}]`).join(' '));
  return parts.join('\n');
}

function truncate(s: string, n: number): string {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
}

/** Every file attached to a message → FileRecord. Stubs of deleted/external files (`mode: 'tombstone'|'hidden_by_limit'`) are skipped. */
export function normaliseFiles(msg: RawMessage, conv: RawConversation, ctx: WorkspaceContext): FileRecord[] {
  const out: FileRecord[] = [];
  for (const f of msg.files ?? []) {
    if (f.mode === 'tombstone' || f.mode === 'hidden_by_limit') continue;
    const seconds = f.timestamp ?? f.created;
    out.push({
      source: 'slack',
      account: ctx.team_id,
      id: f.id,
      name: f.title || f.name || f.id,
      path: containerLabel(conv, ctx),
      mime: f.mimetype || f.filetype || 'application/octet-stream',
      modified: seconds ? new Date(seconds * 1000).toISOString() : slackTsToIso(msg.ts),
      size: f.size ?? 0,
      link: f.permalink || permalink(ctx.url, conv.id, msg.ts, msg.thread_ts),
    });
  }
  return out;
}

/** Oldest-first order with a stable tiebreak — the JSONL consumer should never have to sort. */
export function sortByTs<T extends { ts: string }>(msgs: T[]): T[] {
  return [...msgs].sort((a, b) => compareTs(a.ts, b.ts));
}
