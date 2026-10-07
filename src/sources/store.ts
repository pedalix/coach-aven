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
//   people/identities/message_people   who is who, reseeded from the project's people file
//   sync_state    byte offset consumed per raw file (+ schema version)
//   messages_fts  external-content FTS5 over subject+text; triggers keep it in step and
//                 REMOVE deleted rows, so a message someone deleted does not survive in the
//                 index (the Slack puller's 48 h edit window exists for exactly that promise)
//
// Build = read only the new bytes of each raw file (a half-written last line stays
// unconsumed), apply inside one transaction per file chunk with the new offset, then
// `VACUUM INTO` a fresh copy under replica/ and rename it into place. The replica, not the
// live file, is what the sandbox mounts: a bind-mounted FILE would pin an inode and never
// see the swap, so the mount is the replica DIRECTORY (sandboxopts.ts → SOURCES_MOUNT_TARGET).
import { createHash } from 'node:crypto';
import { closeSync, existsSync, openSync, readdirSync, readSync, renameSync, rmSync, statSync } from 'node:fs';
import { join, relative, basename } from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { identitiesOf, identityIndex, loadPeople, resolveIdentity, type Person } from './people.js';
import { ensureDir } from './paths.js';
import type { Logger } from './types.js';

export const SCHEMA_VERSION = 2;
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
  deleted INTEGER NOT NULL DEFAULT 0
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
  person_id TEXT PRIMARY KEY, name TEXT NOT NULL, company TEXT, default_initiative TEXT
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
CREATE TRIGGER IF NOT EXISTS tasks_au_del AFTER UPDATE ON tasks WHEN old.deleted = 0 BEGIN
  INSERT INTO tasks_fts(tasks_fts, rowid, title, text, comments_text) VALUES ('delete', old.rowid, old.title, old.text, old.comments_text);
END;
CREATE TRIGGER IF NOT EXISTS tasks_au_ins AFTER UPDATE ON tasks WHEN new.deleted = 0 BEGIN
  INSERT INTO tasks_fts(rowid, title, text, comments_text) VALUES (new.rowid, new.title, new.text, new.comments_text);
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
CREATE TRIGGER IF NOT EXISTS messages_au_del AFTER UPDATE ON messages WHEN old.deleted = 0 BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, subject, text) VALUES ('delete', old.rowid, old.subject, old.text);
END;
CREATE TRIGGER IF NOT EXISTS messages_au_ins AFTER UPDATE ON messages WHEN new.deleted = 0 BEGIN
  INSERT INTO messages_fts(rowid, subject, text) VALUES (new.rowid, new.subject, new.text);
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

// ---------------------------------------------------------------------------------------
// Raw file discovery + classification. The pullers' output names are the contract
// (google/pull.ts, slack/pull.ts, msgraph/pull.ts headers) — anything else is skipped once.
// ---------------------------------------------------------------------------------------
export type RawKind = 'messages' | 'events' | 'files' | 'tombstones' | 'tasks';

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
  tombstones: number;
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
  readonly mpDel: StatementSync;
  readonly mpIns: StatementSync;
  readonly threadUp: StatementSync;
  readonly threadDel: StatementSync;
  readonly syncGet: StatementSync;
  readonly syncSet: StatementSync;
  constructor(db: DatabaseSync) {
    this.rawIns = db.prepare('INSERT OR IGNORE INTO raw_records(source, account, id, line_hash, body, ingested_at) VALUES (?, ?, ?, ?, ?, ?)');
    this.msgGet = db.prepare('SELECT thread_id FROM messages WHERE ref = ?');
    this.msgUpsert = db.prepare(`INSERT INTO messages(ref, source, account, container, thread_id, ts, author_person, author_raw, subject, text, permalink, raw_ref, scrub_withheld, scrub_kinds, deleted)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
      ON CONFLICT(ref) DO UPDATE SET container=excluded.container, thread_id=excluded.thread_id, ts=excluded.ts, author_person=excluded.author_person,
        author_raw=excluded.author_raw, subject=excluded.subject, text=excluded.text, permalink=excluded.permalink, raw_ref=excluded.raw_ref,
        scrub_withheld=excluded.scrub_withheld, scrub_kinds=excluded.scrub_kinds, deleted=0`);
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
    const pIns = db.prepare('INSERT INTO people(person_id, name, company, default_initiative) VALUES (?, ?, ?, ?)');
    const iIns = db.prepare('INSERT INTO identities(identity, person_id, kind) VALUES (?, ?, ?)');
    for (const p of people) pIns.run(p.person_id, p.name, p.company ?? null, p.default_initiative ?? null);
    for (const i of ids) iIns.run(i.identity, i.person_id, i.kind);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return identityIndex(ids);
}

/** Apply one parsed raw record. Returns what kind of row it changed, for the summary. */
function applyRecord(st: Statements, kind: RawKind, r: Rec, index: ReadonlyMap<string, string>, touched: { refs: Set<string>; threads: Set<string> }): 'message' | 'event' | 'file' | 'task' | 'tombstone' | 'skip' {
  const ref = refOf(r);
  if (!ref) return 'skip';
  const source = str(r.source);
  const account = str(r.account);
  const deleted = r.deleted === true;
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
    const author = str(r.author);
    const scrub = (r.scrub && typeof r.scrub === 'object' ? (r.scrub as Rec) : {}) as Rec;
    st.msgUpsert.run(
      ref, source, account, str(r.container), thread, str(r.ts),
      resolveIdentity(author, index) ?? null, author, str(r.subject), str(r.text), str(r.permalink), str(r.raw_ref),
      scrub.withheld === true ? 1 : 0, strs(scrub.kinds).join(','),
    );
    st.mpDel.run(ref);
    const from = resolveIdentity(author, index);
    if (from) st.mpIns.run(ref, from, 'from');
    for (const p of strs(r.participants)) {
      const pid = resolveIdentity(p, index);
      if (pid && pid !== from) st.mpIns.run(ref, pid, 'to');
    }
    touched.refs.add(ref);
    touched.threads.add(thread);
    return 'message';
  }
  if (effective === 'events') {
    if (deleted) {
      st.evTomb.run(ref, source, account);
      return 'tombstone';
    }
    st.evUpsert.run(ref, source, account, str(r.calendar), str(r.start), str(r.end), str(r.title), JSON.stringify(strs(r.attendees)), str(r.organizer), str(r.link));
    return 'event';
  }
  if (deleted) {
    st.fileTomb.run(ref, source, account);
    return 'tombstone';
  }
  st.fileUpsert.run(ref, source, account, str(r.name), str(r.path), str(r.mime), str(r.modified), typeof r.size === 'number' ? r.size : 0, str(r.link));
  return 'file';
}

export function buildStore(ctx: BuildContext): BuildSummary {
  const now = ctx.now ?? (() => new Date());
  const chunk = ctx.chunk ?? 2000;
  const db = openStore(ctx.storePath);
  const sum: BuildSummary = { files: 0, lines: 0, malformed: 0, replayed: 0, messages: 0, events: 0, fileRecords: 0, tasks: 0, tombstones: 0, truncatedFiles: [], skippedFiles: [], people: 0 };
  try {
    let index: ReadonlyMap<string, string> = new Map();
    if (ctx.peoplePath && existsSync(ctx.peoplePath)) {
      const people = loadPeople(ctx.peoplePath);
      index = seedPeople(db, people);
      sum.people = people.length;
    } else {
      ctx.log(`people: no file at ${ctx.peoplePath ?? '(unset)'} — author/person resolution disabled`);
      // Keep whatever an earlier build seeded only if the file is merely unset; a configured
      // but missing file is a misconfiguration the operator should see, not silently reuse.
      if (ctx.peoplePath) seedPeople(db, []);
      else index = new Map((db.prepare('SELECT identity, person_id FROM identities').all() as { identity: string; person_id: string }[]).map((r) => [r.identity, r.person_id]));
    }
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
            const what = applyRecord(st, kind, r, index, touched);
            if (what === 'message') sum.messages++;
            else if (what === 'event') sum.events++;
            else if (what === 'file') sum.fileRecords++;
            else if (what === 'task') sum.tasks++;
            else if (what === 'tombstone') sum.tombstones++;
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
