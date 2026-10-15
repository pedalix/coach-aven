// The per-project store: ONE SQLite file built incrementally from the raw JSONL the pullers
// append (docs/sources.md → "Store"). Why a store at all, when the raw files already exist:
// several GB of mail and chat are not something an agent can grep from a prompt — it needs
// a system of record it can QUERY (FTS5, filters by person/time/source) and a stable `ref`
// to cite. Why SQLite and not a vector DB: the research behind this (owen-ops
// docs/research-landscape.md §2) is unambiguous that GB-scale personal corpora are an
// FTS problem first; embeddings stay optional and disposable, never the source of truth.
//
// Shape:
//   raw_records   one row per raw JSONL LINE (the idempotency unit; replaying a line is a no-op)
//   messages      compacted view: last line per id wins, tombstones flip `deleted`
//   events/files  same compaction for calendar items and file metadata
//   threads       per-thread rollup, recomputed for the threads a build touched
//   people/identities/message_people   who is who, from the tenant's people file (annotations/people.json)
//   meetings/meeting_people/meetings_fts   calls from Granola / Gemini / Wispr, same compaction
//   fragments/attributions   the tenant's decisions (annotations/fragments.jsonl): which refs
//                belong to which initiative. Indexed, never inferred here.
//   sync_state    byte offset consumed per raw file (+ schema version)
//   messages_fts  external-content FTS5 over subject+text; triggers keep it in step and
//                 REMOVE deleted rows, so a message someone deleted does not survive in the
//                 index (the Slack puller's 48 h edit window exists for exactly that promise)
//
// Derived vs ingested: raw → compacted tables is incremental (byte offsets). Everything that
// depends on the TENANT's files — person resolution (author_person, *_person, message_people,
// meeting_people), people markers, fragments/attributions — is recomputed in full whenever those
// files change (fingerprint in sync_state). That is what makes a fix to people.json apply to the
// 40k messages already stored, not just to tomorrow's (the relink bug of 2026-10-08).
//
// Build = read only the new bytes of each raw file (a half-written last line stays
// unconsumed), apply inside one transaction per file chunk with the new offset, then
// `VACUUM INTO` a fresh copy under replica/ and rename it into place. The replica, not the
// live file, is what the sandbox mounts: a bind-mounted FILE would pin an inode and never
// see the swap: the bot (hostrouter.ts) and `serve` open the file per call and pick up the new one.
import { createHash } from 'node:crypto';
import { attributionRows, loadFragments, type Fragment } from './annotations.js';
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync, statSync } from 'node:fs';
import { join, relative, basename } from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { isBotAuthor, parseSlackDirectory, resolveSlackContainer, resolveSlackName, slackDirectoryText, type SlackDirectory } from './bots.js';
import { clusterMeetings, type MeetingForCall } from './calls.js';
import { identitiesOf, identityIndex, loadPeople, resolveIdentity, type Person } from './people.js';
import { ensureDir } from './paths.js';
import type { Logger } from './types.js';

// v4: messages.is_bot, meetings.call_id + calls (recorder copies grouped), Slack ids → names.
// v5: activity (+activity_fts) — local git / Claude Code work blocks (local/pull.ts).
// v6: msgraph events carry `calendar` {id, name, is_default}; lines without it (written by the
//     pre-v6 puller, which read every shared calendar untagged) are skipped, so the rebuild drops
//     a colleague's shared calendar / holidays / birthdays while the puller re-emits the own ones.
export const SCHEMA_VERSION = 6;
/** Bumped when bots.ts rules change, so every row's is_bot / Slack labels get recomputed. */
export const LABEL_RULES_VERSION = 1;
/** Where the sandbox sees the replica directory (the file inside is always `store.sqlite`). */
export const REPLICA_FILE = 'store.sqlite';

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS raw_records (
  source TEXT NOT NULL, account TEXT NOT NULL, id TEXT NOT NULL, line_hash TEXT NOT NULL,
  body TEXT NOT NULL, ingested_at TEXT NOT NULL,
  PRIMARY KEY (source, account, id, line_hash)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS messages (
  ref TEXT PRIMARY KEY, source TEXT NOT NULL, account TEXT NOT NULL, container TEXT NOT NULL DEFAULT '',
  thread_id TEXT NOT NULL, ts TEXT NOT NULL, author_person TEXT, author_raw TEXT NOT NULL DEFAULT '',
  subject TEXT NOT NULL DEFAULT '', text TEXT NOT NULL DEFAULT '', permalink TEXT NOT NULL DEFAULT '',
  raw_ref TEXT NOT NULL DEFAULT '', scrub_withheld INTEGER NOT NULL DEFAULT 0, scrub_kinds TEXT NOT NULL DEFAULT '',
  participants TEXT NOT NULL DEFAULT '[]', deleted INTEGER NOT NULL DEFAULT 0, is_bot INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS messages_ts ON messages(ts);
CREATE INDEX IF NOT EXISTS messages_thread ON messages(thread_id);
CREATE INDEX IF NOT EXISTS messages_author ON messages(author_person);
CREATE INDEX IF NOT EXISTS messages_source_ts ON messages(source, ts);
CREATE TABLE IF NOT EXISTS threads (
  thread_id TEXT PRIMARY KEY, source TEXT NOT NULL, container TEXT NOT NULL,
  first_ts TEXT NOT NULL, last_ts TEXT NOT NULL, n INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
  ref TEXT PRIMARY KEY, source TEXT NOT NULL, account TEXT NOT NULL, calendar TEXT NOT NULL DEFAULT '',
  start TEXT NOT NULL DEFAULT '', "end" TEXT NOT NULL DEFAULT '', title TEXT NOT NULL DEFAULT '',
  attendees TEXT NOT NULL DEFAULT '[]', organizer TEXT NOT NULL DEFAULT '', link TEXT NOT NULL DEFAULT '',
  deleted INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS events_start ON events(start);
CREATE TABLE IF NOT EXISTS files (
  ref TEXT PRIMARY KEY, source TEXT NOT NULL, account TEXT NOT NULL, name TEXT NOT NULL DEFAULT '',
  path TEXT NOT NULL DEFAULT '', mime TEXT NOT NULL DEFAULT '', modified TEXT NOT NULL DEFAULT '',
  size INTEGER NOT NULL DEFAULT 0, link TEXT NOT NULL DEFAULT '', deleted INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS people (
  person_id TEXT PRIMARY KEY, name TEXT NOT NULL, company TEXT,
  marker_type TEXT, marker_initiatives TEXT NOT NULL DEFAULT '[]'
);
CREATE TABLE IF NOT EXISTS identities (
  identity TEXT PRIMARY KEY, person_id TEXT NOT NULL REFERENCES people(person_id), kind TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS message_people (
  ref TEXT NOT NULL, person_id TEXT NOT NULL, role TEXT NOT NULL,
  PRIMARY KEY (ref, person_id, role)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS message_people_person ON message_people(person_id);
CREATE TABLE IF NOT EXISTS sync_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
-- Meetings (granola/gmeet/wispr) share one shape (meetings/normalise.ts). attendees and
-- next_steps are JSON arrays; attendees_text flattens attendee names for FTS.
CREATE TABLE IF NOT EXISTS meetings (
  ref TEXT PRIMARY KEY, source TEXT NOT NULL, account TEXT NOT NULL, id TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT '', start TEXT NOT NULL DEFAULT '', "end" TEXT NOT NULL DEFAULT '',
  attendees TEXT NOT NULL DEFAULT '[]', summary TEXT NOT NULL DEFAULT '', next_steps TEXT NOT NULL DEFAULT '[]',
  transcript TEXT NOT NULL DEFAULT '', url TEXT NOT NULL DEFAULT '',
  scrub_withheld INTEGER NOT NULL DEFAULT 0, scrub_kinds TEXT NOT NULL DEFAULT '', deleted INTEGER NOT NULL DEFAULT 0,
  call_id TEXT
);
CREATE INDEX IF NOT EXISTS meetings_start ON meetings(start);
CREATE INDEX IF NOT EXISTS meetings_call ON meetings(call_id);
-- One row per real call, however many recorders captured it (calls.ts). sources = JSON [{source, ref}].
CREATE TABLE IF NOT EXISTS calls (
  call_id TEXT PRIMARY KEY, start TEXT NOT NULL DEFAULT '', "end" TEXT NOT NULL DEFAULT '', title TEXT NOT NULL DEFAULT '',
  primary_ref TEXT NOT NULL, sources TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS calls_start ON calls(start);
CREATE TABLE IF NOT EXISTS meeting_people (
  ref TEXT NOT NULL, person_id TEXT NOT NULL, PRIMARY KEY (ref, person_id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS meeting_people_person ON meeting_people(person_id);
CREATE VIRTUAL TABLE IF NOT EXISTS meetings_fts USING fts5(
  title, summary, transcript, content='meetings', content_rowid='rowid',
  tokenize = 'porter unicode61 remove_diacritics 2'
);
CREATE TRIGGER IF NOT EXISTS meetings_ai AFTER INSERT ON meetings WHEN new.deleted = 0 BEGIN
  INSERT INTO meetings_fts(rowid, title, summary, transcript) VALUES (new.rowid, new.title, new.summary, new.transcript);
END;
CREATE TRIGGER IF NOT EXISTS meetings_ad AFTER DELETE ON meetings WHEN old.deleted = 0 BEGIN
  INSERT INTO meetings_fts(meetings_fts, rowid, title, summary, transcript) VALUES ('delete', old.rowid, old.title, old.summary, old.transcript);
END;
-- ONE update trigger, delete-then-insert in that order: two AFTER UPDATE triggers fire in
-- reverse creation order, so a separate "insert" trigger ran BEFORE the "delete" one and every
-- re-emitted row silently vanished from the index (found 2026-10-09). OF the indexed columns
-- + deleted only, so person recomputes (UPDATE … SET author_person) never touch the index.
CREATE TRIGGER IF NOT EXISTS meetings_au AFTER UPDATE OF title, summary, transcript, deleted ON meetings BEGIN
  INSERT INTO meetings_fts(meetings_fts, rowid, title, summary, transcript) SELECT 'delete', old.rowid, old.title, old.summary, old.transcript WHERE old.deleted = 0;
  INSERT INTO meetings_fts(rowid, title, summary, transcript) SELECT new.rowid, new.title, new.summary, new.transcript WHERE new.deleted = 0;
END;
-- Local work blocks (local/pull.ts): git commit clusters and Claude Code session clusters.
-- items = JSON [{ts, text}] (commit subjects / first prompts); items_text flattens them for FTS.
CREATE TABLE IF NOT EXISTS activity (
  ref TEXT PRIMARY KEY, source TEXT NOT NULL, account TEXT NOT NULL, id TEXT NOT NULL DEFAULT '',
  container TEXT NOT NULL DEFAULT '', start TEXT NOT NULL DEFAULT '', "end" TEXT NOT NULL DEFAULT '', minutes INTEGER NOT NULL DEFAULT 0,
  title TEXT NOT NULL DEFAULT '', items TEXT NOT NULL DEFAULT '[]', items_text TEXT NOT NULL DEFAULT '', deleted INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS activity_start ON activity(start);
CREATE INDEX IF NOT EXISTS activity_container ON activity(container);
CREATE VIRTUAL TABLE IF NOT EXISTS activity_fts USING fts5(
  title, items_text, content='activity', content_rowid='rowid',
  tokenize = 'porter unicode61 remove_diacritics 2'
);
CREATE TRIGGER IF NOT EXISTS activity_ai AFTER INSERT ON activity WHEN new.deleted = 0 BEGIN
  INSERT INTO activity_fts(rowid, title, items_text) VALUES (new.rowid, new.title, new.items_text);
END;
CREATE TRIGGER IF NOT EXISTS activity_ad AFTER DELETE ON activity WHEN old.deleted = 0 BEGIN
  INSERT INTO activity_fts(activity_fts, rowid, title, items_text) VALUES ('delete', old.rowid, old.title, old.items_text);
END;
CREATE TRIGGER IF NOT EXISTS activity_au AFTER UPDATE OF title, items_text, deleted ON activity BEGIN
  INSERT INTO activity_fts(activity_fts, rowid, title, items_text) SELECT 'delete', old.rowid, old.title, old.items_text WHERE old.deleted = 0;
  INSERT INTO activity_fts(rowid, title, items_text) SELECT new.rowid, new.title, new.items_text WHERE new.deleted = 0;
END;
-- The tenant's decisions. refs are store refs, or the account-free shorthand
-- meeting:<source>:<id> which the search tool resolves against meetings at query time.
CREATE TABLE IF NOT EXISTS fragments (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, start TEXT NOT NULL DEFAULT '', "end" TEXT NOT NULL DEFAULT '',
  refs TEXT NOT NULL DEFAULT '[]', attributions TEXT NOT NULL DEFAULT '[]', decided_by TEXT NOT NULL,
  rule_id TEXT, rationale TEXT NOT NULL DEFAULT '', decided_at TEXT NOT NULL DEFAULT '', status TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS fragments_start ON fragments(start);
CREATE TABLE IF NOT EXISTS attributions (
  ref TEXT NOT NULL, initiative TEXT NOT NULL, share REAL NOT NULL, fragment_id TEXT NOT NULL, decided_by TEXT NOT NULL,
  PRIMARY KEY (ref, initiative, fragment_id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS attributions_initiative ON attributions(initiative);
-- Task trackers (youtrack/jira/asana) share one shape (trackers/task.ts). comments is a JSON
-- array; comments_text is its flattened text, kept only so FTS can index it.
CREATE TABLE IF NOT EXISTS tasks (
  ref TEXT PRIMARY KEY, source TEXT NOT NULL, account TEXT NOT NULL, key TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT '', status_category TEXT NOT NULL DEFAULT 'todo',
  assignee_raw TEXT NOT NULL DEFAULT '', assignee_person TEXT, reporter_raw TEXT NOT NULL DEFAULT '', reporter_person TEXT,
  due TEXT NOT NULL DEFAULT '', created TEXT NOT NULL DEFAULT '', updated TEXT NOT NULL DEFAULT '',
  project TEXT NOT NULL DEFAULT '', url TEXT NOT NULL DEFAULT '', labels TEXT NOT NULL DEFAULT '[]',
  text TEXT NOT NULL DEFAULT '', comments TEXT NOT NULL DEFAULT '[]', comments_text TEXT NOT NULL DEFAULT '',
  scrub_withheld INTEGER NOT NULL DEFAULT 0, scrub_kinds TEXT NOT NULL DEFAULT '', deleted INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS tasks_updated ON tasks(updated);
CREATE INDEX IF NOT EXISTS tasks_assignee ON tasks(assignee_person);
CREATE INDEX IF NOT EXISTS tasks_due ON tasks(due);
CREATE VIRTUAL TABLE IF NOT EXISTS tasks_fts USING fts5(
  title, text, comments_text, content='tasks', content_rowid='rowid',
  tokenize = 'porter unicode61 remove_diacritics 2'
);
CREATE TRIGGER IF NOT EXISTS tasks_ai AFTER INSERT ON tasks WHEN new.deleted = 0 BEGIN
  INSERT INTO tasks_fts(rowid, title, text, comments_text) VALUES (new.rowid, new.title, new.text, new.comments_text);
END;
CREATE TRIGGER IF NOT EXISTS tasks_ad AFTER DELETE ON tasks WHEN old.deleted = 0 BEGIN
  INSERT INTO tasks_fts(tasks_fts, rowid, title, text, comments_text) VALUES ('delete', old.rowid, old.title, old.text, old.comments_text);
END;
-- ONE update trigger, delete-then-insert in that order: two AFTER UPDATE triggers fire in
-- reverse creation order, so a separate "insert" trigger ran BEFORE the "delete" one and every
-- re-emitted row silently vanished from the index (found 2026-10-09). OF the indexed columns
-- + deleted only, so person recomputes (UPDATE … SET author_person) never touch the index.
CREATE TRIGGER IF NOT EXISTS tasks_au AFTER UPDATE OF title, text, comments_text, deleted ON tasks BEGIN
  INSERT INTO tasks_fts(tasks_fts, rowid, title, text, comments_text) SELECT 'delete', old.rowid, old.title, old.text, old.comments_text WHERE old.deleted = 0;
  INSERT INTO tasks_fts(rowid, title, text, comments_text) SELECT new.rowid, new.title, new.text, new.comments_text WHERE new.deleted = 0;
END;
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  subject, text, content='messages', content_rowid='rowid',
  tokenize = 'porter unicode61 remove_diacritics 2'
);
-- External-content FTS: we must tell the index about every change ourselves. Deleted rows
-- are dropped from the index (not merely flagged) so "deleted" means gone for search too.
CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages WHEN new.deleted = 0 BEGIN
  INSERT INTO messages_fts(rowid, subject, text) VALUES (new.rowid, new.subject, new.text);
END;
CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages WHEN old.deleted = 0 BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, subject, text) VALUES ('delete', old.rowid, old.subject, old.text);
END;
-- ONE update trigger, delete-then-insert in that order: two AFTER UPDATE triggers fire in
-- reverse creation order, so a separate "insert" trigger ran BEFORE the "delete" one and every
-- re-emitted row silently vanished from the index (found 2026-10-09). OF the indexed columns
-- + deleted only, so person recomputes (UPDATE … SET author_person) never touch the index.
CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE OF subject, text, deleted ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, subject, text) SELECT 'delete', old.rowid, old.subject, old.text WHERE old.deleted = 0;
  INSERT INTO messages_fts(rowid, subject, text) SELECT new.rowid, new.subject, new.text WHERE new.deleted = 0;
END;
`;

export function openStore(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA_SQL);
  db.prepare('INSERT OR REPLACE INTO sync_state(key, value) VALUES (?, ?)').run('schema_version', String(SCHEMA_VERSION));
  return db;
}

/** Read-only handle on a replica (or any store) — `immutable=1` skips locking, which is what a ro bind mount needs. */
export function openReadOnly(path: string): DatabaseSync {
  return new DatabaseSync(`file:${path}?immutable=1`, { readOnly: true });
}

/**
 * Rows in `raw_records` — one per raw line ever ingested, inserts only, so between rebuilds the
 * count is monotonic: the empty-slot skip's fingerprint (routineguard.ts). undefined when the
 * file is missing or not a store, never a throw (the caller then fires normally).
 */
export function rawRecordCount(path: string): number | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const db = openReadOnly(path);
    try {
      return Number((db.prepare('SELECT count(*) AS n FROM raw_records').get() as { n: number }).n);
    } finally {
      db.close();
    }
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------------------
// Raw file discovery + classification. The pullers' output names are the contract
// (google/pull.ts, slack/pull.ts, msgraph/pull.ts headers) — anything else is skipped once.
// ---------------------------------------------------------------------------------------
export type RawKind = 'messages' | 'events' | 'files' | 'tombstones' | 'tasks' | 'meetings' | 'activity';

export function classifyRawFile(name: string): RawKind | undefined {
  switch (basename(name)) {
    case 'messages.jsonl':
    case 'slack.messages.jsonl':
      return 'messages';
    case 'events.jsonl':
    case 'calendar.jsonl':
      return 'events';
    case 'files.jsonl':
    case 'slack.files.jsonl':
      return 'files';
    case 'tombstones.jsonl':
      return 'tombstones';
    case 'tasks.jsonl':
      return 'tasks';
    case 'meetings.jsonl':
      return 'meetings';
    case 'activity.jsonl':
      return 'activity';
    default:
      return undefined;
  }
}

export function listRawFiles(rawDir: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && e.name.endsWith('.jsonl')) out.push(p);
    }
  };
  if (existsSync(rawDir)) walk(rawDir);
  return out.sort();
}

/**
 * Read the bytes appended since `offset`, split into complete lines. A trailing partial line
 * (puller mid-write, or a crash between write and fsync) is NOT consumed: `nextOffset` stops
 * before it, so the next build picks it up whole. A file shorter than the offset was
 * truncated/rotated → start over from 0 (reported so the operator notices).
 */
export function readNewLines(path: string, offset: number): { lines: string[]; nextOffset: number; truncated: boolean } {
  const size = statSync(path).size;
  let truncated = false;
  if (size < offset) {
    truncated = true;
    offset = 0;
  }
  if (size === offset) return { lines: [], nextOffset: offset, truncated };
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(size - offset);
    readSync(fd, buf, 0, buf.length, offset);
    const lastNl = buf.lastIndexOf(0x0a);
    if (lastNl < 0) return { lines: [], nextOffset: offset, truncated };
    const complete = buf.subarray(0, lastNl + 1);
    const lines = complete.toString('utf8').split('\n');
    lines.pop(); // the empty remainder after the final \n
    return { lines, nextOffset: offset + complete.length, truncated };
  } finally {
    closeSync(fd);
  }
}

// ---------------------------------------------------------------------------------------
// Record → row mapping. Everything is read defensively: a raw line is untrusted data from a
// puller version that may be older or newer than this code.
// ---------------------------------------------------------------------------------------
type Rec = Record<string, unknown>;
const str = (v: unknown): string => (typeof v === 'string' ? v : v === null || v === undefined ? '' : String(v));
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

export function refOf(r: Rec): string | undefined {
  const source = str(r.source);
  const account = str(r.account);
  const id = str(r.id);
  if (!source || !id) return undefined;
  return `${source}:${account}:${id}`;
}

/**
 * `events.calendar` as stored: gcal writes the calendar id (a string, kept as is); msgraph
 * writes {id, name, is_default}, stored as JSON text with that key order so the `calendar`
 * tool returns it verbatim and a reader can `JSON.parse` a value that starts with `{`.
 */
export function calendarOf(v: unknown): string {
  if (typeof v === 'string') return v;
  if (!v || typeof v !== 'object') return '';
  const o = v as Rec;
  return JSON.stringify({ id: str(o.id), name: str(o.name), is_default: o.is_default === true });
}

/** Thread identity across sources — the unit `get()` expands around a hit. */
export function threadIdOf(r: Rec, ref: string): string {
  const rawRef = str(r.raw_ref);
  const source = str(r.source);
  if (source === 'slack') {
    // slack:<team>/<channel>/<ts>#<thread_ts> for replies; parents and loose messages are their own thread.
    const m = /^slack:([^/]+)\/([^/]+)\/([^#]+)(?:#(.+))?$/.exec(rawRef);
    if (m) return `slack:${m[1]}/${m[2]}/${m[4] ?? m[3]}`;
  } else if (source === 'gmail') {
    const m = /^gmail:([^/]+)\/([^/]+)\//.exec(rawRef);
    if (m && m[2] !== '?') return `gmail:${m[1]}/${m[2]}`;
  }
  return ref;
}

export interface BuildSummary {
  files: number;
  lines: number;
  malformed: number;
  replayed: number;
  messages: number;
  events: number;
  fileRecords: number;
  tasks: number;
  meetings: number;
  /** Local work blocks (git / Claude Code). */
  activity: number;
  /** Distinct calls after grouping recorder copies (calls.ts). */
  calls: number;
  tombstones: number;
  /** msgraph calendar lines without `calendar` (pre-v6 puller), skipped. */
  legacyEvents: number;
  /** Tenant files changed → person resolution + attributions recomputed for every stored row. */
  recomputed: boolean;
  fragments: number;
  attributions: number;
  malformedFragments: number;
  truncatedFiles: string[];
  skippedFiles: string[];
  people: number;
  replica?: string;
}

export interface BuildContext {
  slug: string;
  rawDir: string;
  storePath: string;
  /** Directory the sandbox mounts; `store.sqlite` is swapped in atomically. Undefined = no replica. */
  replicaDir?: string;
  /** People/identities file; undefined or missing = no people seeding (logged). */
  peoplePath?: string;
  /** The tenant's fragments.jsonl; undefined or missing = no attributions. */
  fragmentsPath?: string;
  /**
   * Kinds whose pull completed ok in the pass this build closes, with the puller's finishedAt.
   * Written as `pulled:<kind>` scalars into sync_state (→ the replica → `stats.meta`), so a reader
   * can state the age of each source. A failing kind keeps its previous value: data age, not
   * attempt age. Omitted (CLI `build`) = leave them as they are.
   */
  pulled?: ReadonlyArray<{ kind: string; finishedAt: string }>;
  log: Logger;
  now?: () => Date;
  /** Lines per transaction. */
  chunk?: number;
}

class Statements {
  readonly rawIns: StatementSync;
  readonly msgGet: StatementSync;
  readonly msgUpsert: StatementSync;
  readonly msgTomb: StatementSync;
  readonly evUpsert: StatementSync;
  readonly evTomb: StatementSync;
  readonly fileUpsert: StatementSync;
  readonly fileTomb: StatementSync;
  readonly taskUpsert: StatementSync;
  readonly taskTomb: StatementSync;
  readonly meetUpsert: StatementSync;
  readonly meetTomb: StatementSync;
  readonly actUpsert: StatementSync;
  readonly actTomb: StatementSync;
  readonly mtpDel: StatementSync;
  readonly mtpIns: StatementSync;
  readonly mpDel: StatementSync;
  readonly mpIns: StatementSync;
  readonly threadUp: StatementSync;
  readonly threadDel: StatementSync;
  readonly syncGet: StatementSync;
  readonly syncSet: StatementSync;
  constructor(db: DatabaseSync) {
    this.rawIns = db.prepare('INSERT OR IGNORE INTO raw_records(source, account, id, line_hash, body, ingested_at) VALUES (?, ?, ?, ?, ?, ?)');
    this.msgGet = db.prepare('SELECT thread_id FROM messages WHERE ref = ?');
    this.msgUpsert = db.prepare(`INSERT INTO messages(ref, source, account, container, thread_id, ts, author_person, author_raw, subject, text, permalink, raw_ref, scrub_withheld, scrub_kinds, participants, is_bot, deleted)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
      ON CONFLICT(ref) DO UPDATE SET container=excluded.container, thread_id=excluded.thread_id, ts=excluded.ts, author_person=excluded.author_person,
        author_raw=excluded.author_raw, subject=excluded.subject, text=excluded.text, permalink=excluded.permalink, raw_ref=excluded.raw_ref,
        scrub_withheld=excluded.scrub_withheld, scrub_kinds=excluded.scrub_kinds, participants=excluded.participants, is_bot=excluded.is_bot, deleted=0`);
    // A tombstone for an unknown ref still gets a row: "deleted" is information (the id existed
    // upstream), and a later resurrecting line upserts over it.
    this.msgTomb = db.prepare(`INSERT INTO messages(ref, source, account, thread_id, ts, deleted) VALUES (?, ?, ?, ?, ?, 1)
      ON CONFLICT(ref) DO UPDATE SET deleted=1`);
    this.evUpsert = db.prepare(`INSERT INTO events(ref, source, account, calendar, start, "end", title, attendees, organizer, link, deleted) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
      ON CONFLICT(ref) DO UPDATE SET calendar=excluded.calendar, start=excluded.start, "end"=excluded."end", title=excluded.title,
        attendees=excluded.attendees, organizer=excluded.organizer, link=excluded.link, deleted=0`);
    this.evTomb = db.prepare('INSERT INTO events(ref, source, account, deleted) VALUES (?, ?, ?, 1) ON CONFLICT(ref) DO UPDATE SET deleted=1');
    this.fileUpsert = db.prepare(`INSERT INTO files(ref, source, account, name, path, mime, modified, size, link, deleted) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
      ON CONFLICT(ref) DO UPDATE SET name=excluded.name, path=excluded.path, mime=excluded.mime, modified=excluded.modified, size=excluded.size, link=excluded.link, deleted=0`);
    this.fileTomb = db.prepare('INSERT INTO files(ref, source, account, deleted) VALUES (?, ?, ?, 1) ON CONFLICT(ref) DO UPDATE SET deleted=1');
    this.taskUpsert = db.prepare(`INSERT INTO tasks(ref, source, account, key, title, status, status_category, assignee_raw, assignee_person, reporter_raw, reporter_person,
        due, created, updated, project, url, labels, text, comments, comments_text, scrub_withheld, scrub_kinds, deleted)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
      ON CONFLICT(ref) DO UPDATE SET key=excluded.key, title=excluded.title, status=excluded.status, status_category=excluded.status_category,
        assignee_raw=excluded.assignee_raw, assignee_person=excluded.assignee_person, reporter_raw=excluded.reporter_raw, reporter_person=excluded.reporter_person,
        due=excluded.due, created=excluded.created, updated=excluded.updated, project=excluded.project, url=excluded.url, labels=excluded.labels,
        text=excluded.text, comments=excluded.comments, comments_text=excluded.comments_text, scrub_withheld=excluded.scrub_withheld,
        scrub_kinds=excluded.scrub_kinds, deleted=0`);
    this.taskTomb = db.prepare('INSERT INTO tasks(ref, source, account, deleted) VALUES (?, ?, ?, 1) ON CONFLICT(ref) DO UPDATE SET deleted=1');
    this.meetUpsert = db.prepare(`INSERT INTO meetings(ref, source, account, id, title, start, "end", attendees, summary, next_steps, transcript, url, scrub_withheld, scrub_kinds, deleted)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
      ON CONFLICT(ref) DO UPDATE SET title=excluded.title, start=excluded.start, "end"=excluded."end", attendees=excluded.attendees, summary=excluded.summary,
        next_steps=excluded.next_steps, transcript=excluded.transcript, url=excluded.url, scrub_withheld=excluded.scrub_withheld, scrub_kinds=excluded.scrub_kinds, deleted=0`);
    this.actUpsert = db.prepare(`INSERT INTO activity(ref, source, account, id, container, start, "end", minutes, title, items, items_text, deleted)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
      ON CONFLICT(ref) DO UPDATE SET container=excluded.container, start=excluded.start, "end"=excluded."end", minutes=excluded.minutes,
        title=excluded.title, items=excluded.items, items_text=excluded.items_text, deleted=0`);
    this.actTomb = db.prepare('INSERT INTO activity(ref, source, account, deleted) VALUES (?, ?, ?, 1) ON CONFLICT(ref) DO UPDATE SET deleted=1');
    this.meetTomb = db.prepare('INSERT INTO meetings(ref, source, account, deleted) VALUES (?, ?, ?, 1) ON CONFLICT(ref) DO UPDATE SET deleted=1');
    this.mtpDel = db.prepare('DELETE FROM meeting_people WHERE ref = ?');
    this.mtpIns = db.prepare('INSERT OR IGNORE INTO meeting_people(ref, person_id) VALUES (?, ?)');
    this.mpDel = db.prepare('DELETE FROM message_people WHERE ref = ?');
    this.mpIns = db.prepare('INSERT OR IGNORE INTO message_people(ref, person_id, role) VALUES (?, ?, ?)');
    this.threadUp = db.prepare(`INSERT OR REPLACE INTO threads(thread_id, source, container, first_ts, last_ts, n)
      SELECT thread_id, min(source), min(container), min(ts), max(ts), count(*) FROM messages WHERE thread_id = ? AND deleted = 0 GROUP BY thread_id`);
    this.threadDel = db.prepare('DELETE FROM threads WHERE thread_id = ? AND NOT EXISTS (SELECT 1 FROM messages WHERE thread_id = threads.thread_id AND deleted = 0)');
    this.syncGet = db.prepare('SELECT value FROM sync_state WHERE key = ?');
    this.syncSet = db.prepare('INSERT OR REPLACE INTO sync_state(key, value) VALUES (?, ?)');
  }
}

export function seedPeople(db: DatabaseSync, people: readonly Person[]): Map<string, string> {
  const ids = identitiesOf(people);
  db.exec('BEGIN');
  try {
    db.exec('DELETE FROM identities; DELETE FROM people;');
    const pIns = db.prepare('INSERT INTO people(person_id, name, company, marker_type, marker_initiatives) VALUES (?, ?, ?, ?, ?)');
    const iIns = db.prepare('INSERT INTO identities(identity, person_id, kind) VALUES (?, ?, ?)');
    for (const p of people) pIns.run(p.person_id, p.name, p.company ?? null, p.marker?.type ?? null, JSON.stringify(p.marker?.initiatives ?? []));
    for (const i of ids) iIns.run(i.identity, i.person_id, i.kind);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return identityIndex(ids);
}

/** Apply one parsed raw record. Returns what kind of row it changed, for the summary. */
/** A meeting attendee as stored ({email,name}) → person, e-mail first. */
export function resolveAttendee(a: unknown, index: ReadonlyMap<string, string>): string | undefined {
  if (typeof a === 'string') return resolveIdentity(a, index);
  if (!a || typeof a !== 'object') return undefined;
  const o = a as Rec;
  return (str(o.email) && resolveIdentity(str(o.email), index)) || (str(o.name) && resolveIdentity(str(o.name), index)) || undefined;
}

function linkMessagePeople(st: Statements, ref: string, author: string, participants: readonly string[], index: ReadonlyMap<string, string>): void {
  st.mpDel.run(ref);
  const from = resolveIdentity(author, index);
  if (from) st.mpIns.run(ref, from, 'from');
  for (const p of participants) {
    const pid = resolveIdentity(p, index);
    if (pid && pid !== from) st.mpIns.run(ref, pid, 'to');
  }
}

function linkMeetingPeople(st: Statements, ref: string, attendees: readonly unknown[], index: ReadonlyMap<string, string>): void {
  st.mtpDel.run(ref);
  for (const a of attendees) {
    const pid = resolveAttendee(a, index);
    if (pid) st.mtpIns.run(ref, pid);
  }
}

/** Container / author / participants with Slack ids resolved to names, plus the bot flag (bots.ts). */
function labelled(source: string, r: Rec, dir: SlackDirectory): { container: string; author: string; participants: string[]; isBot: boolean } {
  const rawAuthor = str(r.author);
  const slack = source === 'slack';
  const author = slack ? resolveSlackName(rawAuthor, dir) : rawAuthor;
  return {
    container: slack ? resolveSlackContainer(str(r.container), dir) : str(r.container),
    author,
    participants: slack ? strs(r.participants).map((p) => resolveSlackName(p, dir)) : strs(r.participants),
    isBot: isBotAuthor(source, rawAuthor, dir, r.is_bot === true) || (author !== rawAuthor && isBotAuthor(source, author, dir)),
  };
}

function applyRecord(st: Statements, kind: RawKind, r: Rec, index: ReadonlyMap<string, string>, touched: { refs: Set<string>; threads: Set<string> }, dir: SlackDirectory = new Map()): 'message' | 'event' | 'file' | 'task' | 'meeting' | 'activity' | 'tombstone' | 'legacy' | 'skip' {
  const ref = refOf(r);
  if (!ref) return 'skip';
  const source = str(r.source);
  const account = str(r.account);
  const deleted = r.deleted === true;
  if (kind === 'activity') {
    if (deleted) {
      st.actTomb.run(ref, source, account);
      return 'tombstone';
    }
    const items = Array.isArray(r.items) ? (r.items as unknown[]).filter((x): x is Rec => !!x && typeof x === 'object') : [];
    st.actUpsert.run(
      ref, source, account, str(r.id), str(r.container), str(r.start), str(r.end), Math.max(0, Math.round(Number(r.minutes) || 0)), str(r.title),
      JSON.stringify(items.map((i) => ({ ts: str(i.ts), text: str(i.text) }))), items.map((i) => str(i.text)).join('\n'),
    );
    return 'activity';
  }
  if (kind === 'meetings') {
    if (deleted) {
      st.meetTomb.run(ref, source, account);
      st.mtpDel.run(ref);
      return 'tombstone';
    }
    const scrub = (r.scrub && typeof r.scrub === 'object' ? (r.scrub as Rec) : {}) as Rec;
    const attendees = Array.isArray(r.attendees) ? (r.attendees as unknown[]) : [];
    st.meetUpsert.run(
      ref, source, account, str(r.id), str(r.title), str(r.start), str(r.end), JSON.stringify(attendees), str(r.summary),
      JSON.stringify(strs(r.next_steps)), str(r.transcript), str(r.url), scrub.withheld === true ? 1 : 0, strs(scrub.kinds).join(','),
    );
    linkMeetingPeople(st, ref, attendees, index);
    return 'meeting';
  }
  if (kind === 'tasks') {
    if (deleted) {
      st.taskTomb.run(ref, source, account);
      return 'tombstone';
    }
    const comments = Array.isArray(r.comments) ? (r.comments as Rec[]).filter((c) => c && typeof c === 'object') : [];
    const scrub = (r.scrub && typeof r.scrub === 'object' ? (r.scrub as Rec) : {}) as Rec;
    const assignee = str(r.assignee);
    const reporter = str(r.reporter);
    st.taskUpsert.run(
      ref, source, account, str(r.key), str(r.title), str(r.status), str(r.statusCategory) || 'todo',
      assignee, resolveIdentity(assignee, index) ?? null, reporter, resolveIdentity(reporter, index) ?? null,
      str(r.due), str(r.created), str(r.updated), str(r.project), str(r.url), JSON.stringify(strs(r.labels)), str(r.text),
      JSON.stringify(comments), comments.map((c) => str(c.text)).join('\n'),
      scrub.withheld === true ? 1 : 0, strs(scrub.kinds).join(','),
    );
    return 'task';
  }
  const effective: RawKind = kind === 'tombstones' ? (r.kind === 'calendar' ? 'events' : r.kind === 'file' ? 'files' : 'messages') : kind;
  if (effective === 'messages') {
    if (deleted) {
      const existing = st.msgGet.get(ref) as { thread_id?: string } | undefined;
      const thread = existing?.thread_id ?? threadIdOf(r, ref);
      st.msgTomb.run(ref, source, account, thread, str(r.ts) || '');
      st.mpDel.run(ref);
      touched.refs.add(ref);
      touched.threads.add(thread);
      return 'tombstone';
    }
    const thread = threadIdOf(r, ref);
    const l = labelled(source, r, dir);
    const author = l.author;
    const scrub = (r.scrub && typeof r.scrub === 'object' ? (r.scrub as Rec) : {}) as Rec;
    const participants = l.participants;
    st.msgUpsert.run(
      ref, source, account, l.container, thread, str(r.ts),
      resolveIdentity(author, index) ?? null, author, str(r.subject), str(r.text), str(r.permalink), str(r.raw_ref),
      scrub.withheld === true ? 1 : 0, strs(scrub.kinds).join(','), JSON.stringify(participants), l.isBot ? 1 : 0,
    );
    linkMessagePeople(st, ref, author, participants, index);
    touched.refs.add(ref);
    touched.threads.add(thread);
    return 'message';
  }
  if (effective === 'events') {
    if (deleted) {
      st.evTomb.run(ref, source, account);
      return 'tombstone';
    }
    // Pre-v6 msgraph lines carry no calendar — and those from a shared calendar are not this
    // account's time. The v2 cursor re-emits the own calendar tagged, so nothing of value is lost.
    if (source === 'msgraph' && !r.calendar) return 'legacy';
    st.evUpsert.run(ref, source, account, calendarOf(r.calendar), str(r.start), str(r.end), str(r.title), JSON.stringify(strs(r.attendees)), str(r.organizer), str(r.link));
    return 'event';
  }
  if (deleted) {
    st.fileTomb.run(ref, source, account);
    return 'tombstone';
  }
  st.fileUpsert.run(ref, source, account, str(r.name), str(r.path), str(r.mime), str(r.modified), typeof r.size === 'number' ? r.size : 0, str(r.link));
  return 'file';
}

/** Schema version recorded in an existing store file, or undefined (no file / not a store). */
export function storedSchemaVersion(path: string): number | undefined {
  if (!existsSync(path)) return undefined;
  const db = new DatabaseSync(path);
  try {
    const row = db.prepare("SELECT value FROM sync_state WHERE key = 'schema_version'").get() as { value?: string } | undefined;
    return row?.value ? Number(row.value) : undefined;
  } catch {
    return undefined;
  } finally {
    db.close();
  }
}

/**
 * A store built by an older schema is thrown away and rebuilt from raw — raw is the source of
 * truth and a full rebuild takes seconds (84k lines ≈ 15 s), so we never write migrations.
 */
export function resetIfOldSchema(path: string, log: Logger): boolean {
  const v = storedSchemaVersion(path);
  if (v === undefined || v >= SCHEMA_VERSION) return false;
  for (const f of [path, `${path}-wal`, `${path}-shm`]) rmSync(f, { force: true });
  log(`store schema v${v} < v${SCHEMA_VERSION}: rebuilding from raw`);
  return true;
}

/** Fingerprint of everything the derived tables depend on besides raw. */
export function derivedFingerprint(peopleText: string, fragmentsText: string, slackUsersText = ''): string {
  return createHash('sha256').update(`v${SCHEMA_VERSION}.${LABEL_RULES_VERSION}\0${peopleText}\0${fragmentsText}\0${slackUsersText}`).digest('hex');
}

/**
 * Recompute every tenant-dependent column for ALL stored rows: people + identities, author /
 * assignee / reporter person, message_people, meeting_people, fragments, attributions. One
 * transaction; O(rows) in JS — fine for the tens of thousands a personal corpus has.
 */
export function recomputeDerived(db: DatabaseSync, people: readonly Person[], fragments: readonly Fragment[], dir: SlackDirectory = new Map()): { attributions: number } {
  const index = seedPeople(db, people);
  const st = new Statements(db);
  db.exec('BEGIN');
  try {
    db.exec('DELETE FROM message_people; DELETE FROM meeting_people; DELETE FROM fragments; DELETE FROM attributions;');
    // Labels come from the newest raw line per ref (the archive is the truth; the compacted row may
    // carry names resolved under an older users map), so a better users map or new bot rules fix
    // every row, not only rows ingested after the change.
    const latestRaw = db.prepare('SELECT body FROM raw_records WHERE source = ? AND account = ? AND id = ? ORDER BY ingested_at DESC LIMIT 1');
    const setRow = db.prepare('UPDATE messages SET author_person = ?, author_raw = ?, container = ?, participants = ?, is_bot = ? WHERE ref = ?');
    for (const m of db.prepare('SELECT ref, source, account, author_raw, container, participants FROM messages WHERE deleted = 0').all() as { ref: string; source: string; account: string; author_raw: string; container: string; participants: string }[]) {
      let r: Rec | undefined;
      const idPart = m.ref.startsWith(`${m.source}:${m.account}:`) ? m.ref.slice(m.source.length + m.account.length + 2) : undefined;
      if (idPart !== undefined) {
        const row = latestRaw.get(m.source, m.account, idPart) as { body?: string } | undefined;
        try {
          r = row?.body ? (JSON.parse(row.body) as Rec) : undefined;
        } catch {
          r = undefined;
        }
      }
      let parts: string[] = [];
      try {
        parts = strs(JSON.parse(m.participants || '[]'));
      } catch {
        parts = [];
      }
      const l = r ? labelled(m.source, r, dir) : { container: m.container, author: m.author_raw, participants: parts, isBot: isBotAuthor(m.source, m.author_raw, dir) };
      setRow.run(resolveIdentity(l.author, index) ?? null, l.author, l.container, JSON.stringify(l.participants), l.isBot ? 1 : 0, m.ref);
      linkMessagePeople(st, m.ref, l.author, l.participants, index);
    }
    const setTask = db.prepare('UPDATE tasks SET assignee_person = ?, reporter_person = ? WHERE ref = ?');
    for (const t of db.prepare('SELECT ref, assignee_raw, reporter_raw FROM tasks').all() as { ref: string; assignee_raw: string; reporter_raw: string }[]) {
      setTask.run(resolveIdentity(t.assignee_raw, index) ?? null, resolveIdentity(t.reporter_raw, index) ?? null, t.ref);
    }
    for (const mt of db.prepare('SELECT ref, attendees FROM meetings WHERE deleted = 0').all() as { ref: string; attendees: string }[]) {
      let att: unknown[] = [];
      try {
        att = JSON.parse(mt.attendees || '[]') as unknown[];
      } catch {
        att = [];
      }
      linkMeetingPeople(st, mt.ref, Array.isArray(att) ? att : [], index);
    }
    const fIns = db.prepare('INSERT OR REPLACE INTO fragments(id, kind, start, "end", refs, attributions, decided_by, rule_id, rationale, decided_at, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    for (const f of fragments) fIns.run(f.id, f.kind, f.start, f.end, JSON.stringify(f.refs), JSON.stringify(f.attributions), f.decided_by, f.rule_id ?? null, f.rationale ?? '', f.decided_at ?? '', f.status);
    const aIns = db.prepare('INSERT OR REPLACE INTO attributions(ref, initiative, share, fragment_id, decided_by) VALUES (?, ?, ?, ?, ?)');
    const rows = attributionRows(fragments);
    for (const a of rows) aIns.run(a.ref, a.initiative, a.share, a.fragment_id, a.decided_by);
    db.exec('COMMIT');
    return { attributions: rows.length };
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

/**
 * Group recorder copies into calls (calls.ts) and stamp meetings.call_id. Recomputed on every
 * build: a few hundred rows, and a late-arriving copy (Gemini docs land after the call) must be
 * able to join an existing call. Returns the number of calls.
 */
export function recomputeCalls(db: DatabaseSync): number {
  const rows = db.prepare('SELECT ref, source, title, start, "end" AS e, attendees, length(transcript) AS tl, length(summary) AS sl FROM meetings WHERE deleted = 0').all() as {
    ref: string; source: string; title: string; start: string; e: string; attendees: string; tl: number; sl: number;
  }[];
  const input: MeetingForCall[] = rows.map((r) => {
    let att: unknown[] = [];
    try {
      att = JSON.parse(r.attendees || '[]') as unknown[];
    } catch {
      att = [];
    }
    const names = (Array.isArray(att) ? att : []).map((a) => (typeof a === 'string' ? a : a && typeof a === 'object' ? str((a as Rec).email) || str((a as Rec).name) : '')).filter(Boolean);
    return { ref: r.ref, source: r.source, title: r.title, start: r.start, end: r.e, attendees: names, transcriptChars: r.tl, summaryChars: r.sl };
  });
  const calls = clusterMeetings(input);
  db.exec('BEGIN');
  try {
    db.exec('DELETE FROM calls; UPDATE meetings SET call_id = NULL;');
    const ins = db.prepare('INSERT INTO calls(call_id, start, "end", title, primary_ref, sources) VALUES (?, ?, ?, ?, ?, ?)');
    const stamp = db.prepare('UPDATE meetings SET call_id = ? WHERE ref = ?');
    for (const c of calls) {
      ins.run(c.call_id, c.start, c.end, c.title, c.primary_ref, JSON.stringify(c.sources));
      for (const s of c.sources) stamp.run(c.call_id, s.ref);
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return calls.length;
}

export function buildStore(ctx: BuildContext): BuildSummary {
  const now = ctx.now ?? (() => new Date());
  const chunk = ctx.chunk ?? 2000;
  resetIfOldSchema(ctx.storePath, ctx.log);
  const db = openStore(ctx.storePath);
  const sum: BuildSummary = {
    files: 0, lines: 0, malformed: 0, replayed: 0, messages: 0, events: 0, fileRecords: 0, tasks: 0, meetings: 0, activity: 0, calls: 0, tombstones: 0, legacyEvents: 0,
    recomputed: false, fragments: 0, attributions: 0, malformedFragments: 0, truncatedFiles: [], skippedFiles: [], people: 0,
  };
  try {
    // People drive identity resolution during ingest; the TABLES are (re)seeded below only when
    // the tenant files changed. A configured-but-missing file means "no people" — visible in the
    // log, never silently the previous set.
    let people: Person[] = [];
    let peopleText = '';
    if (ctx.peoplePath && existsSync(ctx.peoplePath)) {
      peopleText = readFileSync(ctx.peoplePath, 'utf8');
      people = loadPeople(ctx.peoplePath);
    } else {
      ctx.log(`people: no file at ${ctx.peoplePath ?? '(unset)'} — author/person resolution disabled`);
    }
    sum.people = people.length;
    const fragmentsText = ctx.fragmentsPath && existsSync(ctx.fragmentsPath) ? readFileSync(ctx.fragmentsPath, 'utf8') : '';
    const index: ReadonlyMap<string, string> = identityIndex(identitiesOf(people));
    const slackUsersText = slackDirectoryText(ctx.rawDir);
    const dir = parseSlackDirectory(slackUsersText);
    const st = new Statements(db);
    for (const file of listRawFiles(ctx.rawDir)) {
      const kind = classifyRawFile(file);
      const key = `offset:${relative(ctx.rawDir, file)}`;
      if (!kind) {
        sum.skippedFiles.push(relative(ctx.rawDir, file));
        continue;
      }
      const prev = Number((st.syncGet.get(key) as { value?: string } | undefined)?.value ?? '0');
      const { lines, nextOffset, truncated } = readNewLines(file, prev);
      if (truncated) sum.truncatedFiles.push(relative(ctx.rawDir, file));
      if (!lines.length && nextOffset === prev) continue;
      sum.files++;
      const ingestedAt = now().toISOString();
      let consumed = prev;
      for (let i = 0; i < lines.length; i += chunk) {
        const slice = lines.slice(i, i + chunk);
        const touched = { refs: new Set<string>(), threads: new Set<string>() };
        db.exec('BEGIN');
        try {
          for (const line of slice) {
            sum.lines++;
            consumed += Buffer.byteLength(line, 'utf8') + 1;
            if (!line.trim()) continue;
            let r: Rec;
            try {
              const parsed: unknown = JSON.parse(line);
              if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
              r = parsed as Rec;
            } catch {
              sum.malformed++;
              continue;
            }
            const ref = refOf(r);
            if (!ref) {
              sum.malformed++;
              continue;
            }
            const hash = createHash('sha256').update(line).digest('hex');
            const ins = st.rawIns.run(str(r.source), str(r.account), str(r.id), hash, line, ingestedAt);
            if (Number(ins.changes) === 0) {
              // Seen before (a crash between apply and offset save, or a copied file): the
              // compacted tables already reflect it, so do not re-apply — order matters.
              sum.replayed++;
              continue;
            }
            const what = applyRecord(st, kind, r, index, touched, dir);
            if (what === 'message') sum.messages++;
            else if (what === 'event') sum.events++;
            else if (what === 'file') sum.fileRecords++;
            else if (what === 'task') sum.tasks++;
            else if (what === 'meeting') sum.meetings++;
            else if (what === 'activity') sum.activity++;
            else if (what === 'tombstone') sum.tombstones++;
            else if (what === 'legacy') sum.legacyEvents++;
          }
          for (const t of touched.threads) {
            st.threadUp.run(t);
            st.threadDel.run(t);
          }
          // The offset moves only with the rows that produced it — same transaction.
          st.syncSet.run(key, String(i + chunk >= lines.length ? nextOffset : consumed));
          db.exec('COMMIT');
        } catch (e) {
          db.exec('ROLLBACK');
          throw e;
        }
      }
    }
    const fp = derivedFingerprint(peopleText, fragmentsText, slackUsersText);
    const prevFp = (st.syncGet.get('derived_fingerprint') as { value?: string } | undefined)?.value;
    const { fragments, malformed } = loadFragments(ctx.fragmentsPath);
    sum.fragments = fragments.length;
    sum.malformedFragments = malformed;
    if (fp !== prevFp) {
      sum.attributions = recomputeDerived(db, people, fragments, dir).attributions;
      st.syncSet.run('derived_fingerprint', fp);
      sum.recomputed = true;
    } else {
      sum.attributions = Number((db.prepare('SELECT count(*) AS n FROM attributions').get() as { n: number }).n);
    }
    sum.calls = recomputeCalls(db);
    st.syncSet.run('last_build_at', now().toISOString());
    for (const p of ctx.pulled ?? []) st.syncSet.run(`pulled:${p.kind}`, p.finishedAt);
    if (ctx.replicaDir) sum.replica = writeReplica(db, ctx.replicaDir);
  } finally {
    db.close();
  }
  return sum;
}

/**
 * Publish a consistent snapshot for the sandbox: VACUUM INTO a temp file in the replica
 * directory, then rename over `store.sqlite`. Readers that opened the old inode keep it until
 * they reopen (the MCP server reopens per call); nobody ever sees a half-written file.
 */
export function writeReplica(db: DatabaseSync, replicaDir: string): string {
  ensureDir(replicaDir);
  const target = join(replicaDir, REPLICA_FILE);
  const tmp = `${target}.tmp`;
  rmSync(tmp, { force: true });
  db.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
  renameSync(tmp, target);
  return target;
}
