#!/usr/bin/env node
// `sources` — the MCP stdio server the sandbox agent uses to query a project's read-only,
// scrubbed source replica (docs/sources.md → "Search tool").
//
// Why a hand-written .mjs and not TypeScript: this file RUNS INSIDE THE SANDBOX on the image's
// Node (22 on the plain image), so it must be a single dependency-free file we can COPY into the
// image and upload into warm sandboxes (project.ts provisionTooling). There is no bundler in the
// toolchain and no reason to add one for ~300 lines; the orchestrator's TypeScript tests import
// this very file (sources-mcp.d.mts declares the exports), so the query builders have ONE source
// of truth and the protocol is exercised end to end by spawning this script.
//
// Protocol: newline-delimited JSON-RPC 2.0 over stdio, the subset Claude Code's MCP client needs
// (initialize, notifications/initialized, ping, tools/list, tools/call). Unknown methods get
// -32601, malformed input -32700/-32600 — never a crash: a dead server would silently remove the
// tools for the rest of the session.
//
// Data: `node:sqlite` (bundled SQLite with FTS5; stable on Node 24, experimental-but-present on
// Node 22 — the ExperimentalWarning is suppressed below). The replica at /data/sources/store.sqlite
// is swapped atomically by the orchestrator after every build (VACUUM INTO + rename), so the DB is
// (re)opened PER CALL: a long-lived handle would pin the old inode forever. The mount is read-only;
// we also open read-only so a misconfigured rw mount changes nothing.

import { DatabaseSync } from 'node:sqlite';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';

export const DEFAULT_DB_PATH = '/data/sources/store.sqlite';
export const SERVER_NAME = 'sources';
export const SERVER_VERSION = '1.2.0';
// Task-tracker sources live in their own table (`tasks`); everything else is a message.
export const TRACKER_SOURCES = ['youtrack', 'jira', 'asana'];
// Meeting recorders live in `meetings`.
export const MEETING_SOURCES = ['granola', 'gmeet', 'wispr'];

// Initiative filter: the tenant's decisions (attributions), never people. A prefix matches its
// sub-initiatives ("hcg/simplify" covers "hcg/simplify/p1-t4m-security"). Meetings may be
// attributed by the account-free shorthand meeting:<source>:<id>, so meetings match either form.
export function initiativeClause(refExpr, initiative, meetingShorthand) {
  const alt = meetingShorthand ? ` OR a.ref = ${meetingShorthand}` : '';
  return {
    sql: `EXISTS (SELECT 1 FROM attributions a WHERE (a.ref = ${refExpr}${alt}) AND (a.initiative = ? OR a.initiative LIKE ?))`,
    params: [String(initiative), `${String(initiative)}/%`],
  };
}
// The newest spec revision we implement; if the client proposes an older one we echo theirs
// (the subset we speak is identical across 2024-11-05 … 2025-06-18).
export const PROTOCOL_VERSION = '2025-06-18';

// ── pure query builders (unit-tested from src/sources/mcp-server.test.ts) ───────────────

// FTS5 MATCH has its own grammar (AND/OR/NOT, NEAR, column filters, `*`, quotes). User text
// goes in as a sequence of QUOTED phrases joined by implicit AND, so nothing the model (or a
// Slack message it copied) types can change the query's shape or error out. A trailing `*`
// on a token keeps prefix matching, the one operator worth exposing.
export function sanitizeFtsQuery(input) {
  const tokens = String(input ?? '')
    .split(/\s+/)
    .map((t) => t.trim())
    .filter(Boolean)
    .map((t) => {
      const prefix = t.endsWith('*');
      // Strip everything that is FTS syntax or noise; keep letters (any script), digits, and
      // the in-word punctuation that appears in emails/handles/paths.
      const core = (prefix ? t.slice(0, -1) : t).replace(/["^*():{}]/g, '').replace(/^[-+]+/, '');
      if (!core) return '';
      return `"${core.replace(/"/g, '""')}"${prefix ? '*' : ''}`;
    })
    .filter(Boolean);
  return tokens.join(' ');
}

const ISO_RE = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;
export function normalizeTime(v, edge) {
  if (v === undefined || v === null || v === '') return undefined;
  const s = String(v).trim();
  if (!ISO_RE.test(s)) throw new Error(`${edge}: expected an ISO date or datetime, got ${JSON.stringify(s)}`);
  // A bare date means the whole day: `until: 2026-10-07` should include that day's messages.
  if (s.length === 10) return edge === 'until' ? `${s}T23:59:59.999Z` : `${s}T00:00:00Z`;
  return s;
}

// Build the SELECT for `search`. Returns { sql, params, mode } where mode is 'fts' (ranked by
// bm25) or 'recent' (no query → newest first with the same filters). Person/initiative filters
// resolve to person_id lists OUTSIDE this function (needs a DB), passed in as `personIds`.
export function buildSearchSql(f) {
  const where = ['m.deleted = 0'];
  const params = [];
  if (f.since) {
    where.push('m.ts >= ?');
    params.push(f.since);
  }
  if (f.until) {
    where.push('m.ts <= ?');
    params.push(f.until);
  }
  if (f.source) {
    where.push('m.source = ?');
    params.push(f.source);
  }
  if (f.personIds && f.personIds.length) {
    const ph = f.personIds.map(() => '?').join(',');
    where.push(
      `(m.author_person IN (${ph}) OR EXISTS (SELECT 1 FROM message_people mp WHERE mp.ref = m.ref AND mp.person_id IN (${ph})))`,
    );
    params.push(...f.personIds, ...f.personIds);
  }
  if (f.initiative) {
    const c = initiativeClause('m.ref', f.initiative);
    where.push(c.sql);
    params.push(...c.params);
  }
  const limit = Math.max(1, Math.min(100, Number(f.limit) || 20));
  const cols =
    'm.ref, m.source, m.account, m.container, m.thread_id, m.ts, m.author_person, m.author_raw, m.subject, m.permalink, m.scrub_withheld, m.scrub_kinds';
  if (f.match) {
    return {
      mode: 'fts',
      sql:
        `SELECT ${cols}, snippet(messages_fts, 1, '«', '»', '…', 14) AS snippet, bm25(messages_fts) AS rank ` +
        `FROM messages_fts JOIN messages m ON m.rowid = messages_fts.rowid ` +
        `WHERE messages_fts MATCH ? AND ${where.join(' AND ')} ORDER BY rank LIMIT ?`,
      params: [f.match, ...params, limit],
    };
  }
  return {
    mode: 'recent',
    sql:
      `SELECT ${cols}, substr(m.text, 1, 200) AS snippet, 0 AS rank FROM messages m ` +
      `WHERE ${where.join(' AND ')} ORDER BY m.ts DESC LIMIT ?`,
    params: [...params, limit],
  };
}

// Same contract as buildSearchSql, over `tasks` (trackers). Person filters match assignee or
// reporter. Rows come back in the message-hit column names so results merge into one list.
export function buildTaskSearchSql(f) {
  const where = ['t.deleted = 0'];
  const params = [];
  if (f.since) {
    where.push('t.updated >= ?');
    params.push(f.since);
  }
  if (f.until) {
    where.push('t.updated <= ?');
    params.push(f.until);
  }
  if (f.source) {
    where.push('t.source = ?');
    params.push(f.source);
  }
  if (f.personIds && f.personIds.length) {
    const ph = f.personIds.map(() => '?').join(',');
    where.push(`(t.assignee_person IN (${ph}) OR t.reporter_person IN (${ph}))`);
    params.push(...f.personIds, ...f.personIds);
  }
  if (f.initiative) {
    const c = initiativeClause('t.ref', f.initiative);
    where.push(c.sql);
    params.push(...c.params);
  }
  const limit = Math.max(1, Math.min(100, Number(f.limit) || 20));
  const cols =
    "t.ref, t.source, t.account, t.project AS container, t.ref AS thread_id, t.updated AS ts, t.assignee_person AS author_person, " +
    "t.assignee_raw AS author_raw, (t.key || ' ' || t.title) AS subject, t.url AS permalink, t.scrub_withheld, t.scrub_kinds, t.status, t.status_category";
  if (f.match) {
    return {
      mode: 'fts',
      sql:
        `SELECT ${cols}, snippet(tasks_fts, -1, '«', '»', '…', 14) AS snippet, bm25(tasks_fts) AS rank ` +
        `FROM tasks_fts JOIN tasks t ON t.rowid = tasks_fts.rowid WHERE tasks_fts MATCH ? AND ${where.join(' AND ')} ORDER BY rank LIMIT ?`,
      params: [f.match, ...params, limit],
    };
  }
  return {
    mode: 'recent',
    sql: `SELECT ${cols}, substr(t.text, 1, 200) AS snippet, 0 AS rank FROM tasks t WHERE ${where.join(' AND ')} ORDER BY t.updated DESC LIMIT ?`,
    params: [...params, limit],
  };
}

// Same contract over `meetings` (title/summary/transcript FTS); person = an attendee.
export function buildMeetingSearchSql(f) {
  const where = ['mt.deleted = 0'];
  const params = [];
  if (f.since) {
    where.push('mt.start >= ?');
    params.push(f.since);
  }
  if (f.until) {
    where.push('mt.start <= ?');
    params.push(f.until);
  }
  if (f.source) {
    where.push('mt.source = ?');
    params.push(f.source);
  }
  if (f.personIds && f.personIds.length) {
    const ph = f.personIds.map(() => '?').join(',');
    where.push(`EXISTS (SELECT 1 FROM meeting_people mp WHERE mp.ref = mt.ref AND mp.person_id IN (${ph}))`);
    params.push(...f.personIds);
  }
  if (f.initiative) {
    const c = initiativeClause('mt.ref', f.initiative, "'meeting:' || mt.source || ':' || mt.id");
    where.push(c.sql);
    params.push(...c.params);
  }
  const limit = Math.max(1, Math.min(100, Number(f.limit) || 20));
  const cols = "mt.ref, mt.source, mt.account, '' AS container, mt.ref AS thread_id, mt.start AS ts, '' AS author_person, '' AS author_raw, mt.title AS subject, mt.url AS permalink, mt.scrub_withheld, mt.scrub_kinds";
  if (f.match) {
    return {
      mode: 'fts',
      sql:
        `SELECT ${cols}, snippet(meetings_fts, -1, '«', '»', '…', 14) AS snippet, bm25(meetings_fts) AS rank ` +
        `FROM meetings_fts JOIN meetings mt ON mt.rowid = meetings_fts.rowid WHERE meetings_fts MATCH ? AND ${where.join(' AND ')} ORDER BY rank LIMIT ?`,
      params: [f.match, ...params, limit],
    };
  }
  return {
    mode: 'recent',
    sql: `SELECT ${cols}, substr(mt.summary, 1, 200) AS snippet, 0 AS rank FROM meetings mt WHERE ${where.join(' AND ')} ORDER BY mt.start DESC LIMIT ?`,
    params: [...params, limit],
  };
}

// `meetings` tool: calls in a time window, newest first, optionally with one person.
export function buildMeetingsListSql(f) {
  const where = ['mt.deleted = 0'];
  const params = [];
  if (f.since) {
    where.push('mt.start >= ?');
    params.push(f.since);
  }
  if (f.until) {
    where.push('mt.start <= ?');
    params.push(f.until);
  }
  if (f.personIds && f.personIds.length) {
    const ph = f.personIds.map(() => '?').join(',');
    where.push(`EXISTS (SELECT 1 FROM meeting_people mp WHERE mp.ref = mt.ref AND mp.person_id IN (${ph}))`);
    params.push(...f.personIds);
  }
  if (f.source) {
    where.push('mt.source = ?');
    params.push(f.source);
  }
  const limit = Math.max(1, Math.min(200, Number(f.limit) || 50));
  return {
    sql:
      'SELECT mt.ref, mt.source, mt.id, mt.title, mt.start, mt."end", mt.attendees, mt.next_steps, mt.url, length(mt.transcript) AS transcript_chars, mt.scrub_withheld ' +
      `FROM meetings mt WHERE ${where.join(' AND ')} ORDER BY mt.start DESC LIMIT ?`,
    params: [...params, limit],
  };
}

// `fragments` tool: the tenant's attribution decisions in a window.
export function buildFragmentsSql(f) {
  const where = ['1 = 1'];
  const params = [];
  if (f.since) {
    where.push('f.start >= ?');
    params.push(f.since);
  }
  if (f.until) {
    where.push('f.start <= ?');
    params.push(f.until);
  }
  if (f.status) {
    where.push('f.status = ?');
    params.push(String(f.status));
  }
  if (f.initiative) {
    where.push('EXISTS (SELECT 1 FROM attributions a WHERE a.fragment_id = f.id AND (a.initiative = ? OR a.initiative LIKE ?))');
    params.push(String(f.initiative), `${String(f.initiative)}/%`);
  }
  const limit = Math.max(1, Math.min(500, Number(f.limit) || 100));
  return {
    sql: `SELECT f.* FROM fragments f WHERE ${where.join(' AND ')} ORDER BY f.start DESC LIMIT ?`,
    params: [...params, limit],
  };
}

// `tasks` tool: the "what is on me / what burns" view. Open tasks only unless status says
// otherwise; due-dated ones first (soonest), then most recently updated.
export function buildTasksListSql(f) {
  const where = ['t.deleted = 0'];
  const params = [];
  const st = f.status ? String(f.status).toLowerCase() : 'open';
  if (st === 'open') where.push("t.status_category != 'done'");
  else if (['todo', 'doing', 'done'].includes(st)) {
    where.push('t.status_category = ?');
    params.push(st);
  } else if (st !== 'any') {
    where.push('lower(t.status) = ?');
    params.push(st);
  }
  if (f.personIds && f.personIds.length) {
    const ph = f.personIds.map(() => '?').join(',');
    where.push(`t.assignee_person IN (${ph})`);
    params.push(...f.personIds);
  } else if (f.assigneeRaw) {
    where.push('lower(t.assignee_raw) LIKE ?');
    params.push(`%${String(f.assigneeRaw).toLowerCase()}%`);
  }
  if (f.dueBefore) {
    where.push("t.due != '' AND t.due <= ?");
    params.push(f.dueBefore);
  }
  if (f.project) {
    where.push('(lower(t.project) = lower(?) OR lower(t.key) LIKE lower(?))');
    params.push(String(f.project), `${String(f.project)}-%`);
  }
  if (f.source) {
    where.push('t.source = ?');
    params.push(f.source);
  }
  if (f.updatedSince) {
    where.push('t.updated >= ?');
    params.push(f.updatedSince);
  }
  const limit = Math.max(1, Math.min(200, Number(f.limit) || 50));
  return {
    sql:
      'SELECT t.ref, t.source, t.key, t.title, t.status, t.status_category, t.assignee_person, t.assignee_raw, t.due, t.updated, t.project, t.url ' +
      `FROM tasks t WHERE ${where.join(' AND ')} ORDER BY (t.due = '') ASC, t.due ASC, t.updated DESC LIMIT ?`,
    params: [...params, limit],
  };
}

export const TOOLS = [
  {
    name: 'search',
    description:
      'Full-text search over the project\'s read-only, scrubbed replica of connected mail, chat and calendar ' +
      '(FTS5, ranked). Returns refs + snippets; call `get` for a full message. Filters: since/until (ISO date or ' +
      'datetime), source (gmail|slack|msgraph|youtrack|jira|asana|granola|gmeet|wispr|…), person (email, slack id, or a name fragment), ' +
      'initiative (only what the tenant has attributed). Tracker tickets carry `kind: "task"`, recorded calls `kind: "meeting"`. ' +
      'With an empty query it lists the newest messages matching the filters. Cite the `permalink` of anything you quote.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Words or phrases; a trailing * does prefix matching' },
        since: { type: 'string' },
        until: { type: 'string' },
        source: { type: 'string' },
        person: { type: 'string' },
        initiative: { type: 'string', description: 'Initiative id or prefix; filters by the tenant\'s attribution decisions' },
        limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
      },
    },
  },
  {
    name: 'get',
    description:
      'One message by ref (from `search`), with its thread neighbours (up to 5 before and after) and scrub ' +
      'metadata. `[REDACTED:…]` tags and `[BODY WITHHELD…]` markers are deliberate: the secret was removed ' +
      'before it reached you — never ask for the value or try to reconstruct it.',
    inputSchema: { type: 'object', properties: { ref: { type: 'string' } }, required: ['ref'] },
  },
  {
    name: 'tasks',
    description:
      'Tracker tickets (YouTrack, Jira, Asana) as a work list — "what is on me", "what is overdue". Defaults to OPEN ' +
      'tasks (status category todo/doing), soonest due first. Filters: assignee (email, login, or name — resolved via ' +
      'people), status (open|todo|doing|done|any|<exact status name>), dueBefore (ISO date), project (key prefix or ' +
      'project name), source, updatedSince. Use `get` with a ref for description and comments.',
    inputSchema: {
      type: 'object',
      properties: {
        assignee: { type: 'string' },
        status: { type: 'string' },
        dueBefore: { type: 'string' },
        project: { type: 'string' },
        source: { type: 'string' },
        updatedSince: { type: 'string' },
        limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
      },
    },
  },
  {
    name: 'meetings',
    description:
      'Recorded calls (Granola, Gemini in Meet, Wispr) in a time window, newest first: title, start/end, attendees, next steps, ' +
      'transcript size. Filters: since/until, person (an attendee), source. `get` a ref for the summary and transcript.',
    inputSchema: {
      type: 'object',
      properties: { since: { type: 'string' }, until: { type: 'string' }, person: { type: 'string' }, source: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 } },
    },
  },
  {
    name: 'fragments',
    description:
      'The tenant\'s attribution decisions: fragments of Owen\'s day (a call, a thread, a work block) with their initiative(s) and ' +
      'shares, who decided (rule|model|owen) and why. Filters: since/until (fragment start), initiative (id or prefix), status (decided|escalated).',
    inputSchema: {
      type: 'object',
      properties: { since: { type: 'string' }, until: { type: 'string' }, initiative: { type: 'string' }, status: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 500, default: 100 } },
    },
  },
  {
    name: 'people',
    description: 'Look up known people by name or identity (email / slack id); returns person_id, company, marker {type: exclusive|narrow|broad, initiatives}, identities.',
    inputSchema: { type: 'object', properties: { q: { type: 'string' } } },
  },
  {
    name: 'stats',
    description: 'Coverage of the replica: per-source message, task and meeting counts and time ranges, events, files, people, fragments, last build.',
    inputSchema: { type: 'object', properties: {} },
  },
];

// ── DB access (one open per call; see header) ────────────────────────────────────────────

function openDb(path) {
  // `readOnly` landed in Node 22.13+/23; older runtimes throw on the unknown option, in which
  // case a plain open on a read-only mount still behaves read-only (writes fail, reads work).
  try {
    return new DatabaseSync(path, { readOnly: true });
  } catch (e) {
    if (e && /readOnly|unknown option|ERR_INVALID_ARG/i.test(String(e.message ?? e))) return new DatabaseSync(path);
    throw e;
  }
}

function resolvePersonIds(db, person) {
  const ids = new Set();
  if (person) {
    const p = String(person).trim();
    const byIdentity = db.prepare('SELECT person_id FROM identities WHERE lower(identity) = lower(?)').all(p);
    for (const r of byIdentity) ids.add(r.person_id);
    if (!ids.size) {
      const byName = db.prepare('SELECT person_id FROM people WHERE lower(name) LIKE ? OR lower(person_id) LIKE ?').all(
        `%${p.toLowerCase()}%`,
        `%${p.toLowerCase()}%`,
      );
      for (const r of byName) ids.add(r.person_id);
    }
    if (!ids.size) return { ids: ['__nobody__'], note: `no person matches ${JSON.stringify(p)}` };
  }
  return { ids: [...ids] };
}

function hasTable(db, name) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
}

export function runSearch(db, args) {
  const since = normalizeTime(args.since, 'since');
  const until = normalizeTime(args.until, 'until');
  const match = sanitizeFtsQuery(args.query);
  const { ids: personIds, note: personNote } = resolvePersonIds(db, args.person);
  const initiative = args.initiative ? String(args.initiative) : undefined;
  const notes = personNote ? [personNote] : [];
  if (initiative && !hasTable(db, 'attributions')) return { mode: 'fts', note: 'this replica has no attributions yet (built before tenant annotations)', hits: [] };
  if (initiative && !db.prepare('SELECT 1 FROM attributions LIMIT 1').get()) notes.push('the tenant has not attributed anything yet — the initiative filter matches nothing');
  const f = { match, since, until, source: args.source, personIds, initiative, limit: args.limit };
  const src = args.source ? String(args.source) : undefined;
  const isTracker = src && TRACKER_SOURCES.includes(src);
  const isMeeting = src && MEETING_SOURCES.includes(src);
  const q = buildSearchSql(f);
  let rows = isTracker || isMeeting ? [] : db.prepare(q.sql).all(...q.params);
  // Old replicas (built before trackers / meetings existed) lack those tables — skip them.
  if ((!src || isTracker) && hasTable(db, 'tasks')) {
    const tq = buildTaskSearchSql(f);
    rows.push(...db.prepare(tq.sql).all(...tq.params).map((r) => ({ ...r, kind: 'task' })));
  }
  if ((!src || isMeeting) && hasTable(db, 'meetings')) {
    const mq = buildMeetingSearchSql(f);
    rows.push(...db.prepare(mq.sql).all(...mq.params).map((r) => ({ ...r, kind: 'meeting' })));
  }
  // bm25 scores from different FTS tables are not strictly comparable, but all are "lower is
  // better" — good enough to interleave; recency mode sorts by ts.
  rows = rows.sort((a, b) => (q.mode === 'fts' ? a.rank - b.rank : String(b.ts).localeCompare(String(a.ts))));
  rows = rows.slice(0, Math.max(1, Math.min(100, Number(args.limit) || 20)));
  return {
    mode: q.mode,
    ...(notes.length ? { note: notes.join('; ') } : {}),
    hits: rows.map((r) => ({
      ...(r.kind === 'task' ? { kind: 'task', status: r.status, statusCategory: r.status_category } : {}),
      ...(r.kind === 'meeting' ? { kind: 'meeting' } : {}),
      ref: r.ref,
      source: r.source,
      ts: r.ts,
      author: r.author_person || r.author_raw,
      container: r.container,
      subject: r.subject,
      snippet: r.snippet,
      permalink: r.permalink,
      ...(r.scrub_withheld ? { withheld: true } : {}),
    })),
  };
}

function taskRow(t) {
  let comments = [];
  try {
    comments = JSON.parse(t.comments || '[]');
  } catch {
    comments = [];
  }
  return {
    kind: 'task',
    ref: t.ref,
    source: t.source,
    key: t.key,
    title: t.title,
    status: t.status,
    statusCategory: t.status_category,
    assignee: t.assignee_person || t.assignee_raw,
    reporter: t.reporter_person || t.reporter_raw,
    due: t.due,
    created: t.created,
    updated: t.updated,
    project: t.project,
    url: t.url,
    labels: JSON.parse(t.labels || '[]'),
    text: t.text, // withheld bodies carry the marker verbatim
    comments,
    deleted: !!t.deleted,
    scrub: { withheld: !!t.scrub_withheld, kinds: t.scrub_kinds ? t.scrub_kinds.split(',').filter(Boolean) : [] },
  };
}

const parseJson = (v, d) => {
  try {
    return JSON.parse(v);
  } catch {
    return d;
  }
};

function attributionsFor(db, refs) {
  if (!hasTable(db, 'attributions')) return [];
  const ph = refs.map(() => '?').join(',');
  return db.prepare(`SELECT initiative, share, fragment_id, decided_by FROM attributions WHERE ref IN (${ph})`).all(...refs);
}

function meetingRow(db, mt) {
  const people = db
    .prepare('SELECT p.person_id, p.name FROM meeting_people mp JOIN people p ON p.person_id = mp.person_id WHERE mp.ref = ?')
    .all(mt.ref);
  return {
    kind: 'meeting',
    ref: mt.ref,
    source: mt.source,
    account: mt.account,
    title: mt.title,
    start: mt.start,
    end: mt.end,
    attendees: parseJson(mt.attendees || '[]', []),
    people,
    summary: mt.summary, // withheld bodies carry the marker verbatim
    next_steps: parseJson(mt.next_steps || '[]', []),
    transcript: mt.transcript,
    url: mt.url,
    deleted: !!mt.deleted,
    attributions: attributionsFor(db, [mt.ref, `meeting:${mt.source}:${mt.id}`]),
    scrub: { withheld: !!mt.scrub_withheld, kinds: mt.scrub_kinds ? mt.scrub_kinds.split(',').filter(Boolean) : [] },
  };
}

export function runMeetings(db, args) {
  if (!hasTable(db, 'meetings')) return { meetings: [], note: 'no meeting sources in this replica' };
  let personIds;
  let note;
  if (args.person) {
    const r = resolvePersonIds(db, args.person);
    personIds = r.ids;
    note = r.note;
  }
  const q = buildMeetingsListSql({ since: normalizeTime(args.since, 'since'), until: normalizeTime(args.until, 'until'), personIds, source: args.source, limit: args.limit });
  return {
    ...(note ? { note } : {}),
    meetings: db.prepare(q.sql).all(...q.params).map((r) => ({
      ref: r.ref,
      source: r.source,
      title: r.title,
      start: r.start,
      end: r.end,
      attendees: parseJson(r.attendees || '[]', []),
      next_steps: parseJson(r.next_steps || '[]', []),
      transcript_chars: r.transcript_chars,
      url: r.url,
      ...(r.scrub_withheld ? { withheld: true } : {}),
    })),
  };
}

export function runFragments(db, args) {
  if (!hasTable(db, 'fragments')) return { fragments: [], note: 'this replica has no fragments (built before tenant annotations)' };
  const q = buildFragmentsSql({ since: normalizeTime(args.since, 'since'), until: normalizeTime(args.until, 'until'), initiative: args.initiative, status: args.status, limit: args.limit });
  return {
    fragments: db.prepare(q.sql).all(...q.params).map((f) => ({
      id: f.id,
      kind: f.kind,
      start: f.start,
      end: f.end,
      refs: parseJson(f.refs || '[]', []),
      attributions: parseJson(f.attributions || '[]', []),
      decided_by: f.decided_by,
      ...(f.rule_id ? { rule_id: f.rule_id } : {}),
      rationale: f.rationale,
      decided_at: f.decided_at,
      status: f.status,
    })),
  };
}

export function runTasks(db, args) {
  if (!hasTable(db, 'tasks')) return { tasks: [], note: 'no tracker sources in this replica' };
  let personIds;
  let note;
  if (args.assignee) {
    const r = resolvePersonIds(db, args.assignee);
    if (r.ids[0] !== '__nobody__') personIds = r.ids;
    else note = `${r.note}; matching assignee text instead`;
  }
  const q = buildTasksListSql({
    status: args.status,
    personIds,
    assigneeRaw: personIds ? undefined : args.assignee,
    dueBefore: normalizeTime(args.dueBefore, 'until'),
    project: args.project,
    source: args.source,
    updatedSince: normalizeTime(args.updatedSince, 'since'),
    limit: args.limit,
  });
  const rows = db.prepare(q.sql).all(...q.params);
  return {
    ...(note ? { note } : {}),
    tasks: rows.map((t) => ({
      ref: t.ref,
      source: t.source,
      key: t.key,
      title: t.title,
      status: t.status,
      statusCategory: t.status_category,
      assignee: t.assignee_person || t.assignee_raw,
      due: t.due,
      updated: t.updated,
      project: t.project,
      url: t.url,
    })),
  };
}

export function runGet(db, args) {
  const ref = String(args.ref ?? '');
  const m = db.prepare('SELECT * FROM messages WHERE ref = ?').get(ref);
  if (!m) {
    const t = hasTable(db, 'tasks') ? db.prepare('SELECT * FROM tasks WHERE ref = ?').get(ref) : undefined;
    if (t) return taskRow(t);
    const mt = hasTable(db, 'meetings') ? db.prepare('SELECT * FROM meetings WHERE ref = ?').get(ref) : undefined;
    if (mt) return meetingRow(db, mt);
    return { error: `no message, task or meeting with ref ${JSON.stringify(ref)}` };
  }
  const before = db
    .prepare('SELECT ref, ts, author_person, author_raw, substr(text,1,300) AS text FROM messages WHERE thread_id = ? AND deleted = 0 AND ts < ? ORDER BY ts DESC LIMIT 5')
    .all(m.thread_id, m.ts)
    .reverse();
  const after = db
    .prepare('SELECT ref, ts, author_person, author_raw, substr(text,1,300) AS text FROM messages WHERE thread_id = ? AND deleted = 0 AND ts > ? ORDER BY ts ASC LIMIT 5')
    .all(m.thread_id, m.ts);
  const people = db
    .prepare('SELECT mp.role, p.person_id, p.name FROM message_people mp JOIN people p ON p.person_id = mp.person_id WHERE mp.ref = ?')
    .all(ref);
  const sib = (r) => ({ ref: r.ref, ts: r.ts, author: r.author_person || r.author_raw, text: r.text });
  return {
    ref: m.ref,
    source: m.source,
    account: m.account,
    container: m.container,
    thread_id: m.thread_id,
    ts: m.ts,
    author: m.author_person || m.author_raw,
    subject: m.subject,
    text: m.text, // withheld bodies carry the marker verbatim — that IS the answer
    permalink: m.permalink,
    deleted: !!m.deleted,
    scrub: { withheld: !!m.scrub_withheld, kinds: m.scrub_kinds ? m.scrub_kinds.split(',').filter(Boolean) : [] },
    people,
    attributions: attributionsFor(db, [m.ref]),
    thread: { before: before.map(sib), after: after.map(sib) },
  };
}

export function runPeople(db, args) {
  const q = String(args.q ?? '').trim().toLowerCase();
  const rows = q
    ? db
        .prepare(
          'SELECT DISTINCT p.person_id, p.name, p.company, p.marker_type, p.marker_initiatives FROM people p ' +
            'LEFT JOIN identities i ON i.person_id = p.person_id ' +
            'WHERE lower(p.name) LIKE ? OR lower(p.person_id) LIKE ? OR lower(i.identity) LIKE ? ORDER BY p.name LIMIT 50',
        )
        .all(`%${q}%`, `%${q}%`, `%${q}%`)
    : db.prepare('SELECT person_id, name, company, marker_type, marker_initiatives FROM people ORDER BY name LIMIT 200').all();
  const ids = db.prepare('SELECT identity, kind FROM identities WHERE person_id = ?');
  return {
    people: rows.map((p) => ({
      person_id: p.person_id,
      name: p.name,
      company: p.company,
      marker: p.marker_type ? { type: p.marker_type, initiatives: parseJson(p.marker_initiatives || '[]', []) } : null,
      identities: ids.all(p.person_id),
    })),
  };
}

export function runStats(db) {
  const bySource = db
    .prepare('SELECT source, count(*) AS n, min(ts) AS first_ts, max(ts) AS last_ts FROM messages WHERE deleted = 0 GROUP BY source ORDER BY source')
    .all();
  const events = db.prepare('SELECT count(*) AS n, min(start) AS first, max(start) AS last FROM events WHERE deleted = 0').get();
  const files = db.prepare('SELECT count(*) AS n FROM files WHERE deleted = 0').get();
  const people = db.prepare('SELECT count(*) AS n FROM people').get();
  const withheld = db.prepare('SELECT count(*) AS n FROM messages WHERE deleted = 0 AND scrub_withheld = 1').get();
  // sync_state holds per-file byte offsets plus a few scalar keys; expose the scalars only.
  const meta = Object.fromEntries(
    db
      .prepare("SELECT key, value FROM sync_state WHERE key NOT LIKE 'offset:%' AND key NOT LIKE 'file:%'")
      .all()
      .map((r) => [r.key, r.value]),
  );
  const tasks = hasTable(db, 'tasks')
    ? db
        .prepare(
          "SELECT source, count(*) AS n, sum(status_category != 'done') AS open, min(updated) AS first_updated, max(updated) AS last_updated " +
            'FROM tasks WHERE deleted = 0 GROUP BY source ORDER BY source',
        )
        .all()
    : [];
  const meetings = hasTable(db, 'meetings')
    ? db.prepare('SELECT source, count(*) AS n, min(start) AS first, max(start) AS last FROM meetings WHERE deleted = 0 GROUP BY source ORDER BY source').all()
    : [];
  const fragments = hasTable(db, 'fragments') ? db.prepare('SELECT status, count(*) AS n FROM fragments GROUP BY status').all() : [];
  const attributions = hasTable(db, 'attributions') ? db.prepare('SELECT count(*) AS n FROM attributions').get().n : 0;
  return { messages: bySource, tasks, meetings, withheld: withheld.n, events, files: files.n, people: people.n, fragments, attributions, meta };
}

export function callTool(dbPath, name, args) {
  const db = openDb(dbPath);
  try {
    switch (name) {
      case 'search':
        return runSearch(db, args ?? {});
      case 'get':
        return runGet(db, args ?? {});
      case 'people':
        return runPeople(db, args ?? {});
      case 'tasks':
        return runTasks(db, args ?? {});
      case 'meetings':
        return runMeetings(db, args ?? {});
      case 'fragments':
        return runFragments(db, args ?? {});
      case 'stats':
        return runStats(db);
      default:
        throw Object.assign(new Error(`unknown tool ${name}`), { code: -32602 });
    }
  } finally {
    db.close();
  }
}

// ── JSON-RPC plumbing ────────────────────────────────────────────────────────────────────

export function handleMessage(msg, dbPath) {
  if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
    return { jsonrpc: '2.0', id: msg && msg.id !== undefined ? msg.id : null, error: { code: -32600, message: 'invalid request' } };
  }
  const { id, method, params } = msg;
  const isNotification = id === undefined;
  const reply = (result) => (isNotification ? undefined : { jsonrpc: '2.0', id, result });
  const fail = (code, message) => (isNotification ? undefined : { jsonrpc: '2.0', id, error: { code, message } });
  try {
    switch (method) {
      case 'initialize': {
        const requested = params && typeof params.protocolVersion === 'string' ? params.protocolVersion : PROTOCOL_VERSION;
        const version = requested < PROTOCOL_VERSION ? requested : PROTOCOL_VERSION;
        return reply({
          protocolVersion: version,
          capabilities: { tools: {} },
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
          instructions:
            'Read-only, scrubbed replica of this project\'s connected sources. Search first, then `get` the refs you ' +
            'need; cite permalinks. Redaction markers are final.',
        });
      }
      case 'notifications/initialized':
      case 'notifications/cancelled':
        return undefined;
      case 'ping':
        return reply({});
      case 'tools/list':
        return reply({ tools: TOOLS });
      case 'tools/call': {
        const name = params && params.name;
        const args = (params && params.arguments) || {};
        try {
          const result = callTool(dbPath, name, args);
          return reply({ content: [{ type: 'text', text: JSON.stringify(result) }], isError: false });
        } catch (e) {
          // Tool-level failures are results, not protocol errors — the model sees the message
          // and can adjust (bad date, unknown ref) instead of losing the tool for the session.
          if (e && e.code === -32602) return fail(-32602, e.message);
          return reply({ content: [{ type: 'text', text: `error: ${e && e.message ? e.message : String(e)}` }], isError: true });
        }
      }
      default:
        return fail(-32601, `method not found: ${method}`);
    }
  } catch (e) {
    return fail(-32603, e && e.message ? e.message : String(e));
  }
}

export function serve(dbPath = process.env.SOURCES_DB || DEFAULT_DB_PATH, input = process.stdin, output = process.stdout) {
  const rl = createInterface({ input, crlfDelay: Infinity });
  rl.on('line', (line) => {
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      output.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }) + '\n');
      return;
    }
    const batch = Array.isArray(msg) ? msg : [msg];
    for (const m of batch) {
      const res = handleMessage(m, dbPath);
      if (res) output.write(JSON.stringify(res) + '\n');
    }
  });
  rl.on('close', () => process.exit(0));
}

// Entry point only when executed directly (tests import this module without starting a server).
// The orchestrator launches it with `node --no-warnings` so Node 22's ExperimentalWarning for
// node:sqlite (emitted at import, before this line runs) never reaches the MCP client's stderr.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  serve();
}
