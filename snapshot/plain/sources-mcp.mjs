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
export const SERVER_VERSION = '1.8.0';
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

// FTS5 MATCH has its own grammar (AND/OR/NOT, NEAR, column filters, `*`, quotes). User text is
// rebuilt from scratch: every word becomes a QUOTED term, so nothing the model (or a Slack
// message it copied) types can change the query's shape or error out. Exposed on purpose:
// "quoted phrases", a trailing `*` (prefix), and the UPPER-CASE operators OR / AND / NOT between
// two terms (lower-case "or" is just a word). A dangling or doubled operator is dropped.
export function sanitizeFtsQuery(input) {
  const raw = String(input ?? '').match(/"[^"]*"?|\S+/g) ?? [];
  const out = [];
  const isOp = (t) => t === 'OR' || t === 'AND' || t === 'NOT';
  for (const t of raw) {
    if (isOp(t)) {
      if (out.length && !isOp(out[out.length - 1])) out.push(t);
      continue;
    }
    let term = '';
    if (t.startsWith('"')) {
      const phrase = t.replace(/^"|"$/g, '').replace(/["^*():{}]/g, ' ').replace(/\s+/g, ' ').trim();
      if (phrase) term = `"${phrase}"`;
    } else {
      const prefix = t.endsWith('*');
      // Strip everything that is FTS syntax or noise; keep letters (any script), digits, and
      // the in-word punctuation that appears in emails/handles/paths.
      const core = (prefix ? t.slice(0, -1) : t).replace(/["^*():{}]/g, '').replace(/^[-+]+/, '');
      if (core) term = `"${core}"${prefix ? '*' : ''}`;
    }
    if (term) out.push(term);
  }
  while (out.length && isOp(out[out.length - 1])) out.pop();
  return out.join(' ');
}

// ── local time ───────────────────────────────────────────────────────────────────────────
// The sandbox runs in UTC (the plain image has no tzdata), but the person the agent serves has
// a day. The orchestrator passes it as SOURCES_TZ (sources/mcp.ts, from AVEN_TZ); every window
// argument is read in that zone, so "today" is computed here and not by the model. Node's
// bundled ICU resolves IANA names without tzdata; an unknown name falls back to UTC rather than
// killing the server.
function resolveTz(name) {
  if (!name) return 'UTC';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: String(name) });
    return String(name);
  } catch {
    return 'UTC';
  }
}
// The DEFAULT presentation zone (SOURCES_TZ: the bot's AVEN_TZ). Storage is UTC everywhere; a store
// built for a tenant carries that tenant's zone as `tz` in sync_state, and callTool presents every
// answer of that store in it for the duration of the call (one zone per tenant, not per bot).
export let LOCAL_TZ = resolveTz(process.env.SOURCES_TZ);
export function setLocalTz(name) {
  LOCAL_TZ = resolveTz(name);
  return LOCAL_TZ;
}

// Offset (ms) of `tz` at the UTC instant `utcMs`: format the instant in that zone, read the wall
// clock back as if it were UTC, and take the difference.
function tzOffsetMs(utcMs, tz) {
  const dtf = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const p = Object.fromEntries(dtf.formatToParts(new Date(utcMs)).map((x) => [x.type, x.value]));
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - Math.floor(utcMs / 1000) * 1000;
}
// Wall-clock fields in `tz` → UTC ms. The offset is looked up at the naive instant, then once more
// at the corrected one so a wall time just after a DST switch lands on the right side.
export function zonedToUtcMs(fields, tz) {
  const naive = Date.UTC(...fields);
  const once = naive - tzOffsetMs(naive, tz);
  return naive - tzOffsetMs(once, tz);
}

const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?(Z|[+-]\d{2}:?\d{2})?)?$/;
/**
 * since/until → an ISO instant for the `>=`/`<=` comparisons. A bare date is the whole LOCAL day
 * (`until: 2026-10-07` includes that evening's messages); a zone-less datetime is local wall
 * time; anything carrying Z or an offset is taken as given.
 */
export function normalizeTime(v, edge, tz = LOCAL_TZ) {
  if (v === undefined || v === null || v === '') return undefined;
  const s = String(v).trim();
  const m = ISO_RE.exec(s);
  if (!m) throw new Error(`${edge}: expected an ISO date or datetime, got ${JSON.stringify(s)}`);
  const [, y, mo, d, h, mi, sec, frac, zone] = m;
  if (zone) return s;
  const endOfDay = h === undefined && edge === 'until';
  const ms = frac ? Math.round(Number(`0.${frac}`) * 1000) : 0;
  const fields = endOfDay ? [+y, +mo - 1, +d, 23, 59, 59, 999] : [+y, +mo - 1, +d, +(h ?? 0), +(mi ?? 0), +(sec ?? 0), ms];
  const utc = zonedToUtcMs(fields, tz);
  if (!Number.isFinite(utc)) throw new Error(`${edge}: not a real date: ${JSON.stringify(s)}`);
  return new Date(utc).toISOString();
}
// Shared wording for every tool that takes a window.
// The project's zone is the store's (`stats.tz`); the name here is only the default for a store that names none.
const ZONE_DOC = `the project's time zone (stats.tz; ${LOCAL_TZ} unless the project names one)`;
const WINDOW_DOC = `since/until: ISO date = whole day in ${ZONE_DOC}, or a datetime (zone-less = wall time there; Z/offset as given)`;

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
  // Bots (integrations, webhooks, no-reply mail) drown human conversation; excluded unless asked.
  if (f.excludeBots) where.push('m.is_bot = 0');
  const limit = Math.max(1, Math.min(100, Number(f.limit) || 20));
  const cols =
    'm.ref, m.source, m.account, m.container, m.thread_id, m.ts, m.author_person, m.author_raw, m.subject, m.permalink, m.scrub_withheld, m.scrub_kinds, m.participants';
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
  const cols = `mt.ref, mt.source, mt.account, '' AS container, mt.ref AS thread_id, mt.start AS ts, '' AS author_person, '' AS author_raw, mt.title AS subject, mt.url AS permalink, mt.scrub_withheld, mt.scrub_kinds, ${f.hasCalls ? 'mt.call_id' : 'NULL'} AS call_id`;
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
/** Chars of summary shown per call in `meetings` (the full text is one `get` away). */
export const SUMMARY_PREVIEW_CHARS = 900;
/** Without since/until, `meetings` shows this many days back (the full list is ~70k chars). */
export const DEFAULT_MEETINGS_WINDOW_DAYS = 14;
/** Transcript head inspected for speaker labels (≈150 lines; a recorder does not relabel mid-call). */
export const SPEAKER_SAMPLE_CHARS = 12_000;
/** `transcript` page size: well under the ~25k-token cap on a tool result, even for Cyrillic. */
export const TRANSCRIPT_PAGE_CHARS = 30_000;
export const TRANSCRIPT_MAX_CHARS = 50_000;
const MEETING_COLS =
  'mt.ref, mt.source, mt.id, mt.title, mt.start, mt."end", mt.attendees, mt.next_steps, mt.url, ' +
  `substr(mt.summary, 1, ${SUMMARY_PREVIEW_CHARS + 1}) AS summary_head, length(mt.transcript) AS transcript_chars, mt.scrub_withheld`;
const COPY_META_SQL = `SELECT ref, source, substr(transcript, 1, ${SPEAKER_SAMPLE_CHARS}) AS head, length(transcript) AS transcript_chars, scrub_withheld FROM meetings WHERE ref = ?`;
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
  const limit = Math.max(1, Math.min(200, Number(f.limit) || 20));
  return {
    sql: `SELECT ${MEETING_COLS}, ${f.hasCalls ? 'mt.call_id' : 'NULL AS call_id'} FROM meetings mt WHERE ${where.join(' AND ')} ORDER BY mt.start DESC LIMIT ?`,
    params: [...params, limit],
  };
}

// `activity` tool: local work blocks (git commit clusters, Claude Code sessions) in a window,
// oldest first; q = FTS over title + commit subjects / first prompts.
export function buildActivitySql(f) {
  const where = ['a.deleted = 0'];
  const params = [];
  if (f.since) {
    where.push('a."end" >= ?');
    params.push(f.since);
  }
  if (f.until) {
    where.push('a.start <= ?');
    params.push(f.until);
  }
  if (f.container) {
    where.push('a.container LIKE ?');
    params.push(`%${String(f.container)}%`);
  }
  if (f.source) {
    where.push('a.source = ?');
    params.push(String(f.source));
  }
  const limit = Math.max(1, Math.min(500, Number(f.limit) || 100));
  const cols = 'a.ref, a.source, a.account, a.container, a.start, a."end", a.minutes, a.title, a.items';
  const q = f.q ? sanitizeFtsQuery(f.q) : '';
  if (q) {
    return {
      sql: `SELECT ${cols} FROM activity_fts JOIN activity a ON a.rowid = activity_fts.rowid WHERE activity_fts MATCH ? AND ${where.join(' AND ')} ORDER BY a.start LIMIT ?`,
      params: [q, ...params, limit],
    };
  }
  return { sql: `SELECT ${cols} FROM activity a WHERE ${where.join(' AND ')} ORDER BY a.start LIMIT ?`, params: [...params, limit] };
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
      'SELECT t.ref, t.source, t.key, t.title, t.status, t.status_category, t.assignee_person, t.assignee_raw, t.due, t.updated, t.project, t.url, t.comments ' +
      `FROM tasks t WHERE ${where.join(' AND ')} ORDER BY (t.due = '') ASC, t.due ASC, t.updated DESC LIMIT ?`,
    params: [...params, limit],
  };
}

// `calendar` tool: events in a window, ordered by start. `needles` are lower-cased identities
// (emails, names) any of which must appear among attendees/organizer; `q` matches the title.
export function buildCalendarSql(f) {
  const where = ['e.deleted = 0', "e.start <> ''"];
  const params = [];
  if (f.since) {
    where.push('e.start >= ?');
    params.push(f.since);
  }
  if (f.until) {
    where.push('e.start <= ?');
    params.push(f.until);
  }
  if (f.source) {
    where.push('e.source = ?');
    params.push(f.source);
  }
  if (f.needles && f.needles.length) {
    where.push(`(${f.needles.map(() => '(lower(e.attendees) LIKE ? OR lower(e.organizer) LIKE ?)').join(' OR ')})`);
    for (const n of f.needles) params.push(`%${n}%`, `%${n}%`);
  }
  if (f.q) {
    where.push('lower(e.title) LIKE ?');
    params.push(`%${String(f.q).toLowerCase()}%`);
  }
  const limit = Math.max(1, Math.min(500, Number(f.limit) || 100));
  return {
    sql: `SELECT e.ref, e.source, e.account, e.calendar, e.start, e."end", e.title, e.attendees, e.organizer, e.link FROM events e WHERE ${where.join(' AND ')} ORDER BY e.start ASC LIMIT ?`,
    params: [...params, limit],
  };
}

// ── readouts: what waits for a reply, what stopped moving (docs/sources.md → "Readouts") ──
// Plain SQL over stored rows — no model, no text heuristics — so a routine quotes the rows as
// facts and the same store always yields the same list. Both take `now` so tests pin the clock.

/** `unanswered` without since/until looks this far back: older silence is history, not a wait. */
export const DEFAULT_UNANSWERED_WINDOW_DAYS = 14;
/** Direct conversations — Slack DMs / group DMs, Teams chats: the whole container is one thread. */
const DIRECT_CONTAINER_SQL = "(m.container LIKE 'dm:%' OR m.container LIKE 'mpim:%' OR m.container LIKE 'chat:%')";
const isDirectContainer = (c) => /^(dm|mpim|chat):/.test(String(c ?? ''));
/** A numeric argument with a default; junk falls back to the default rather than to 0. */
function numArg(v, dflt, min = 0) {
  if (v === undefined || v === null || v === '') return dflt;
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(min, n) : dflt;
}

/**
 * Who "we" are for a readout. `side` = company names and/or person ids from the people file
 * (comma-separated; everyone of a listed company is us), `person` = one person as `search.person`
 * resolves it, neither = the account owner(s): the people whose identities are the mail accounts
 * the store was pulled for (Slack accounts are team ids and never resolve — the mailbox decides).
 */
export function resolveSubject(db, args) {
  if (args.side) {
    const wanted = String(args.side).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
    const ids = new Set();
    const q = db.prepare('SELECT person_id FROM people WHERE lower(company) = ? OR lower(person_id) = ?');
    for (const w of wanted) for (const r of q.all(w, w)) ids.add(r.person_id);
    if (!ids.size) return { mode: 'side', ids: ['__nobody__'], note: `side ${JSON.stringify(args.side)} matches no company or person id in the people file` };
    return { mode: 'side', ids: [...ids] };
  }
  if (args.person) {
    const r = resolvePersonIds(db, args.person);
    return { mode: 'person', ids: r.ids, ...(r.note ? { note: r.note } : {}) };
  }
  const owners = db
    .prepare('SELECT DISTINCT person_id FROM identities WHERE identity IN (SELECT DISTINCT lower(account) FROM messages)')
    .all()
    .map((r) => r.person_id);
  if (!owners.length) return { mode: 'person', ids: ['__nobody__'], note: 'no account owner in the people file — pass `person` or `side`' };
  return { mode: 'person', ids: owners };
}

/**
 * Candidates: human messages not by the subject, at least `cutoff` old and, in person mode,
 * addressed to them — listed in `to` (mail recipients, Slack @mentions, DM/group members; the
 * pullers put the DM counterpart there); a side is addressed when any member is. With `all` every message in scope counts: the store (or
 * `container`) IS the client scope. Unanswered: no later message by the subject in the same
 * thread, in the same direct conversation, or addressed to the author within the same source — a
 * mail reply (any folder), an @mention in the same channel: how people answer outside the thread.
 * A mention of the author in ANOTHER channel is not an answer. Oldest first; the caller folds
 * rows per conversation. A reply posted in a channel without thread or mention is NOT seen.
 */
export function buildUnansweredSql(f) {
  const ids = f.subjectIds && f.subjectIds.length ? f.subjectIds : ['__nobody__'];
  const ph = ids.map(() => '?').join(',');
  const where = ['m.deleted = 0', `(m.author_person IS NULL OR m.author_person NOT IN (${ph}))`, 'm.ts <= ?'];
  const params = [...ids, f.cutoff];
  if (f.hasBots !== false) where.push('m.is_bot = 0');
  // Addressed to the subject (any side member) — mail recipients, @mentions, DM members — unless `all`
  // asks for every message in scope (a store that IS one client channel). The 2026-10-15 brief showed
  // why the default must be addressed: in a shared channel Bluefin ↔ Bluefin exchanges and questions to the
  // project's own agent came out as "waiting on us" / "waiting on Bluefin".
  if (!f.all) {
    where.push(`EXISTS (SELECT 1 FROM message_people mp WHERE mp.ref = m.ref AND mp.role = 'to' AND mp.person_id IN (${ph}))`);
    params.push(...ids);
  }
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
    params.push(String(f.source));
  }
  if (f.container) {
    where.push('m.container LIKE ?');
    params.push(`%${String(f.container)}%`);
  }
  where.push(
    `NOT EXISTS (SELECT 1 FROM messages r WHERE r.deleted = 0 AND r.ts > m.ts AND r.author_person IN (${ph}) AND (` +
      'r.thread_id = m.thread_id' +
      ` OR (${DIRECT_CONTAINER_SQL} AND r.source = m.source AND r.container = m.container)` +
      // addressed to the author, in the same source: a mail reply (any folder), an @mention or DM in the same conversation
      " OR (r.source = m.source AND (m.source = 'gmail' OR m.container LIKE 'mailbox:%' OR r.container = m.container) AND (" +
      "(m.author_person IS NOT NULL AND EXISTS (SELECT 1 FROM message_people rp WHERE rp.ref = r.ref AND rp.role = 'to' AND rp.person_id = m.author_person))" +
      " OR (m.author_person IS NULL AND m.author_raw <> '' AND instr(lower(r.participants), lower(m.author_raw)) > 0)))))",
  );
  params.push(...ids);
  const limit = Math.max(1, Math.min(2000, Number(f.limit) || 1000));
  return {
    sql:
      'SELECT m.ref, m.source, m.container, m.thread_id, m.ts, m.author_person, m.author_raw, m.subject, m.permalink, m.scrub_withheld, m.participants, ' +
      'substr(m.text, 1, 200) AS snippet, th.first_ts, th.last_ts, th.n ' +
      `FROM messages m LEFT JOIN threads th ON th.thread_id = m.thread_id WHERE ${where.join(' AND ')} ORDER BY m.ts ASC LIMIT ?`,
    params: [...params, limit],
  };
}

export function runUnanswered(db, args, now = new Date()) {
  const subject = resolveSubject(db, args);
  const hours = numArg(args.hours, 24);
  const notes = subject.note ? [subject.note] : [];
  if (subject.ids[0] === '__nobody__') {
    return { subject: { mode: subject.mode, people: [] }, hours, now: now.toISOString(), note: notes.join('; '), conversations: 0, unanswered: [] };
  }
  let since = normalizeTime(args.since, 'since');
  const until = normalizeTime(args.until, 'until');
  if (!since && !until) {
    since = new Date(now.getTime() - DEFAULT_UNANSWERED_WINDOW_DAYS * 86_400_000).toISOString();
    notes.push(`no since/until given — looking back ${DEFAULT_UNANSWERED_WINDOW_DAYS} days (since ${since})`);
  }
  const cutoff = new Date(now.getTime() - hours * 3_600_000).toISOString();
  const q = buildUnansweredSql({
    mode: subject.mode, subjectIds: subject.ids, cutoff, since, until, source: args.source, container: args.container, hasBots: hasColumn(db, 'messages', 'is_bot'), all: args.all === true,
  });
  // One row per conversation — a direct container, else the thread — carrying the OLDEST waiting
  // message (when the wait began) and how many more piled up behind it.
  const byConv = new Map();
  for (const r of db.prepare(q.sql).all(...q.params)) {
    const key = isDirectContainer(r.container) ? `${r.source}:${r.container}` : r.thread_id;
    const first = byConv.get(key);
    if (first) {
      first.pending += 1;
      first.lastInboundTs = r.ts;
      continue;
    }
    byConv.set(key, { ...r, pending: 1, lastInboundTs: r.ts });
  }
  const limit = Math.max(1, Math.min(200, Number(args.limit) || 50));
  return {
    subject: { mode: subject.mode, people: subject.ids[0] === '__nobody__' ? [] : subject.ids },
    hours,
    ...(args.all === true ? { all: true } : {}),
    since,
    ...(until ? { until } : {}),
    now: now.toISOString(),
    ...(notes.length ? { note: notes.join('; ') } : {}),
    conversations: byConv.size,
    unanswered: [...byConv.values()].slice(0, limit).map((r) => ({
      ref: r.ref,
      source: r.source,
      container: r.container,
      author: r.author_person || r.author_raw,
      ...toField(r),
      ts: r.ts,
      ageHours: Math.max(0, Math.round((now.getTime() - Date.parse(r.ts)) / 3_600_000)),
      pending: r.pending,
      ...(r.pending > 1 ? { lastInboundTs: r.lastInboundTs } : {}),
      thread: { id: r.thread_id, first_ts: r.first_ts, last_ts: r.last_ts, n: r.n },
      subject: r.subject,
      snippet: r.snippet,
      permalink: r.permalink,
      ...(r.scrub_withheld ? { withheld: true } : {}),
    })),
  };
}

/**
 * `stuck`: open tracker tasks (todo/doing) whose last activity — `updated`, or a later comment —
 * is at least `days` old. SQL pre-filters on `updated` (a comment can only make a task NEWER);
 * the JS pass applies the comment timestamps and groups project → status, stalest first.
 */
export function buildStuckSql(f) {
  const where = ['t.deleted = 0', "t.status_category IN ('todo', 'doing')", 't.updated <= ?'];
  const params = [f.cutoff];
  const st = f.status ? String(f.status).toLowerCase() : '';
  if (st === 'todo' || st === 'doing') {
    where.push('t.status_category = ?');
    params.push(st);
  } else if (st) {
    where.push('lower(t.status) = ?');
    params.push(st);
  }
  if (f.personIds && f.personIds.length) {
    where.push(`t.assignee_person IN (${f.personIds.map(() => '?').join(',')})`);
    params.push(...f.personIds);
  } else if (f.assigneeRaw) {
    where.push('lower(t.assignee_raw) LIKE ?');
    params.push(`%${String(f.assigneeRaw).toLowerCase()}%`);
  }
  if (f.project) {
    where.push('(lower(t.project) = lower(?) OR lower(t.key) LIKE lower(?))');
    params.push(String(f.project), `${String(f.project)}-%`);
  }
  if (f.source) {
    where.push('t.source = ?');
    params.push(String(f.source));
  }
  return {
    sql:
      'SELECT t.ref, t.source, t.key, t.title, t.status, t.status_category, t.assignee_person, t.assignee_raw, t.due, t.updated, t.project, t.url, t.comments ' +
      `FROM tasks t WHERE ${where.join(' AND ')} ORDER BY t.project, t.status, t.updated ASC`,
    params,
  };
}

export function runStuck(db, args, now = new Date()) {
  if (!hasTable(db, 'tasks')) return { groups: [], note: 'no tracker sources in this replica' };
  const days = numArg(args.days, 5);
  let personIds;
  let note;
  if (args.assignee) {
    const r = resolvePersonIds(db, args.assignee);
    if (r.ids[0] !== '__nobody__') personIds = r.ids;
    else note = `${r.note}; matching assignee text instead`;
  }
  const cutoffMs = now.getTime() - days * 86_400_000;
  const q = buildStuckSql({
    cutoff: new Date(cutoffMs).toISOString(), status: args.status, personIds, assigneeRaw: personIds ? undefined : args.assignee, project: args.project, source: args.source,
  });
  const limit = Math.max(1, Math.min(500, Number(args.limit) || 200));
  const groups = new Map();
  let total = 0;
  let truncated = false;
  for (const t of db.prepare(q.sql).all(...q.params)) {
    const { lastComment } = commentActivity(t.comments);
    const lastMs = Math.max(Date.parse(t.updated) || 0, lastComment ? Date.parse(lastComment.at) || 0 : 0);
    if (!lastMs || lastMs > cutoffMs) continue; // a comment inside the window: it moved
    if (total >= limit) {
      truncated = true;
      break;
    }
    total += 1;
    const key = `${t.project}\u0000${t.status}`;
    let g = groups.get(key);
    if (!g) {
      g = { project: t.project, status: t.status, statusCategory: t.status_category, n: 0, tasks: [] };
      groups.set(key, g);
    }
    g.n += 1;
    g.tasks.push({
      ref: t.ref,
      source: t.source,
      key: t.key,
      title: t.title,
      status: t.status,
      assignee: t.assignee_person || t.assignee_raw,
      updated: t.updated,
      lastActivity: new Date(lastMs).toISOString(),
      daysSinceUpdate: Math.floor((now.getTime() - lastMs) / 86_400_000),
      due: t.due,
      url: t.url,
    });
  }
  for (const g of groups.values()) g.tasks.sort((a, b) => b.daysSinceUpdate - a.daysSinceUpdate);
  return {
    days,
    now: now.toISOString(),
    ...(note ? { note } : {}),
    ...(truncated ? { truncated: true } : {}),
    total,
    groups: [...groups.values()],
  };
}

export const TOOLS = [
  {
    name: 'search',
    description:
      'Full-text search over the project\'s read-only, scrubbed replica of connected mail, chat, trackers and recorded calls ' +
      `(FTS5, ranked). Returns refs + snippets; call \`get\` for a full message. Filters: ${WINDOW_DOC}, ` +
      'source (gmail|slack|msgraph|youtrack|jira|asana|granola|gmeet|wispr|…), person (email, slack id, or a name fragment), ' +
      'initiative (only what the tenant has attributed). Tracker tickets carry `kind: "task"`, recorded calls `kind: "meeting"`. ' +
      'With an empty query it lists the newest messages matching the filters. Bot/integration messages are excluded unless includeBots. ' +
      'A call recorded by several recorders comes back once (`also` lists the other copies). Cite the `permalink` of anything you quote. ' +
      '`author` is who WROTE the message and `to` the other side: a hit whose author is the mailbox owner (e.g. from …/Sent Items) is ' +
      'a message they sent, never one they received.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Words, "quoted phrases", a trailing * for prefix; OR / AND / NOT (upper-case) between terms' },
        since: { type: 'string' },
        until: { type: 'string' },
        source: { type: 'string' },
        person: { type: 'string' },
        initiative: { type: 'string', description: 'Initiative id or prefix; filters by the tenant\'s attribution decisions' },
        includeBots: { type: 'boolean', description: 'Include integrations/webhooks/no-reply mail (excluded by default)', default: false },
        limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
      },
    },
  },
  {
    name: 'get',
    description:
      'One record by ref (from `search`, `tasks` or `meetings`). A message comes with its thread neighbours (up to 5 before ' +
      'and after) and scrub metadata; a task with its description and comments; a MEETING compactly — title, attendees, ' +
      'full summary, next steps, transcript size, `speakers` and every recorder copy side by side, never the transcript ' +
      '(page it with `transcript`). `speakers`: me-them is attribution-grade; names-diarized/anonymous labels are recorder ' +
      'guesses — mark quotes from them as unverified. `[REDACTED:…]` tags and `[BODY WITHHELD…]` markers are deliberate: ' +
      'the secret was removed before it reached you — never ask for the value or try to reconstruct it.',
    inputSchema: { type: 'object', properties: { ref: { type: 'string' } }, required: ['ref'] },
  },
  {
    name: 'transcript',
    description:
      'The transcript of one recorded call by a copy ref (`meetings` rows carry `ref` and every copy in `sources`; a ' +
      '`call:` id resolves to its primary copy). Long; for a question that needs reading it, spawn one Agent with the ' +
      `question + ref, it pages/filters and returns ≤30 quoted lines. Pages by characters: offset/limit (default ${TRANSCRIPT_PAGE_CHARS}, ` +
      `max ${TRANSCRIPT_MAX_CHARS}), continue at \`next_offset\` until it is null. With \`q\` (words that must all occur in a line, ` +
      'case-insensitive) only the matching lines ±1 line of context come back, numbered `L<n>:` for citing. A withheld ' +
      'transcript returns its marker — that IS the answer.',
    inputSchema: {
      type: 'object',
      properties: {
        ref: { type: 'string' },
        q: { type: 'string', description: 'Filter: every word must occur in a line (case-insensitive)' },
        offset: { type: 'integer', minimum: 0, default: 0 },
        limit: { type: 'integer', minimum: 1, maximum: TRANSCRIPT_MAX_CHARS, default: TRANSCRIPT_PAGE_CHARS },
      },
      required: ['ref'],
    },
  },
  {
    name: 'tasks',
    description:
      'Tracker tickets (YouTrack, Jira, Asana) as a work list — "what is on me", "what is overdue", "what moved since". ' +
      'Defaults to OPEN tasks (status category todo/doing), soonest due first. Every row carries `lastComment {by, at}`; with ' +
      '`updatedSince` also `commentsSince {n, authors}` — comment activity without a `get` per task. Filters: assignee ' +
      '(email, login, or name — resolved via people), status (open|todo|doing|done|any|<exact status name>), dueBefore ' +
      `(ISO date), project (key prefix or project name), source, updatedSince (ISO date = whole day in ${ZONE_DOC}, or ` +
      'datetime). Use `get` with a ref for description and comment texts.',
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
      'Recorded calls in a time window, newest first — ONE row per call even when Granola, Gemini in Meet and Wispr all recorded it. ' +
      '`sources` lists every copy with its ref, transcript size and `speakers` label quality; the primary copy (`ref`) is the ' +
      'highest-priority recorder with a transcript — granola > wispr > gmeet — then the longest. Fields: title, start/end, ' +
      `attendees, summary (first ~${SUMMARY_PREVIEW_CHARS} chars, \`summary_truncated\` when cut), next steps of every copy, transcript size. ` +
      `Without since/until: the last ${DEFAULT_MEETINGS_WINDOW_DAYS} days. Filters: ${WINDOW_DOC}, person (an attendee), source. ` +
      '`get` a ref for the full summary and all copies; `transcript` for the text.',
    inputSchema: {
      type: 'object',
      properties: { since: { type: 'string' }, until: { type: 'string' }, person: { type: 'string' }, source: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 200, default: 20 } },
    },
  },
  {
    name: 'calendar',
    description:
      'Calendar events (Google Calendar, Outlook) ordered by start — THE source for "meetings today", "what is on my calendar ' +
      `tomorrow", "when do I meet X". Filters: ${WINDOW_DOC}, person (attendee or organizer: ` +
      'email, name or person id), q (title words), source (gcal|msgraph|…). Returns start/end/title/attendees/organizer/link/source. ' +
      'Recorded calls with transcripts are in `meetings`, not here.',
    inputSchema: {
      type: 'object',
      properties: {
        since: { type: 'string' },
        until: { type: 'string' },
        person: { type: 'string' },
        q: { type: 'string' },
        source: { type: 'string' },
        limit: { type: 'integer', minimum: 1, maximum: 500, default: 100 },
      },
    },
  },
  {
    name: 'activity',
    description:
      'Hands-on work on Owen\'s machine: git commit clusters per repo and Claude Code session clusters per working directory, ' +
      'each a block with start/end/minutes, a title and items (commit subjects, or the first prompt of each session). THE source for ' +
      `"what did I work on", coding time and work fragments. Filters: ${WINDOW_DOC}, container ` +
      '(repo like owner/name, or a path fragment), source (git|claude), q (words in titles/items).',
    inputSchema: {
      type: 'object',
      properties: {
        since: { type: 'string' },
        until: { type: 'string' },
        container: { type: 'string' },
        source: { type: 'string' },
        q: { type: 'string' },
        limit: { type: 'integer', minimum: 1, maximum: 500, default: 100 },
      },
    },
  },
  {
    name: 'fragments',
    description:
      'The tenant\'s attribution decisions: fragments of Owen\'s day (a call, a thread, a work block) with their initiative(s) and ' +
      `shares, who decided (rule|model|owen) and why. Filters: ${WINDOW_DOC} (on the fragment start), initiative (id or prefix), status (decided|escalated).`,
    inputSchema: {
      type: 'object',
      properties: { since: { type: 'string' }, until: { type: 'string' }, initiative: { type: 'string' }, status: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 500, default: 100 } },
    },
  },
  {
    name: 'unanswered',
    description:
      'What WAITS for a reply: inbound human messages addressed to the subject with no later reply from them. Subject = the account ' +
      'owner by default, `person` (as in search), or `side` (company names and/or person ids from the people file, comma-separated — ' +
      'everyone of that company is "us"; list an agent there to count its replies). Addressed = in `to` (mail recipients, Slack @mentions, ' +
      'DM/group members) — for a side, addressed to ANY member; a message between two people outside the side, or one addressed to ' +
      'someone else, is never inbound. `all: true` counts every message in scope instead (only for a store that is exactly one client channel). ' +
      'Answered = the subject wrote later in the same thread, in the same direct conversation, or a message addressed ' +
      'to the author in the same source (mail reply, @mention in the same channel). One row per conversation: the OLDEST waiting message (`ts`, `ageHours`), `pending` = ' +
      'messages piled up since, the thread summary, `permalink` — cite it. Bot/integration messages are never inbound. Filters: hours ' +
      `(minimum age, default 24), ${WINDOW_DOC} (default: the last ${DEFAULT_UNANSWERED_WINDOW_DAYS} days), container (name fragment), ` +
      'source, limit. Known limits: a reply posted in a channel without thread or @mention, and reactions, are not seen as answers.',
    inputSchema: {
      type: 'object',
      properties: {
        person: { type: 'string', description: 'Subject as one person: email, slack id, or a name fragment' },
        side: { type: 'string', description: 'Subject as a side: company names and/or person ids from the people file, comma-separated' },
        all: { type: 'boolean', default: false, description: 'Every message in scope counts as inbound, not only those addressed to the subject' },
        hours: { type: 'number', minimum: 0, default: 24, description: 'Minimum age of the waiting message in hours' },
        since: { type: 'string' },
        until: { type: 'string' },
        container: { type: 'string', description: 'Channel / mailbox / conversation name fragment' },
        source: { type: 'string' },
        limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
      },
    },
  },
  {
    name: 'stuck',
    description:
      'What STOPPED moving: open tracker tasks (status category todo/doing) whose last activity — `updated` or a later comment — is at ' +
      'least `days` old (default 5), grouped by project then status, stalest first. Rows carry ref, key, title, status, assignee, updated, ' +
      'lastActivity, daysSinceUpdate, due, url; `get` a ref for the text and comments. Filters: days, project (key prefix or project name), ' +
      'status (todo|doing|<exact status name>), assignee (resolved via people), source, limit. Known limit: age is from the last update of ' +
      'ANY kind, not time in the current status — trackers do not record transitions here.',
    inputSchema: {
      type: 'object',
      properties: {
        days: { type: 'number', minimum: 0, default: 5 },
        project: { type: 'string' },
        status: { type: 'string' },
        assignee: { type: 'string' },
        source: { type: 'string' },
        limit: { type: 'integer', minimum: 1, maximum: 500, default: 200 },
      },
    },
  },
  {
    name: 'attribution',
    description:
      'The tenant\'s attribution plan, computed in the store build from its own data (rules, people markers, initiatives.json): the ' +
      'subject\'s fragments — calls (one per summary topic), runs of their messages, work blocks — for local days since..until ' +
      `(YYYY-MM-DD, each a whole day in ${ZONE_DOC}; default: today), each with its state: ` +
      '`decided` (a judgment in the tenant ledger, or a rule decision the platform pinned once its day closed — `pinned`), ' +
      '`escalated` (an open question), `rule` (the ladder decides it while its day is open; the platform pins it — nothing to record), ' +
      '`open` (needs a judgment: candidates + hint). Plus rule proposals from recorded judgments. Filter by `state`. Refs are store ' +
      'refs (`get` them for content); `container` is what a question about it is about; titles carry no message text.',
    inputSchema: {
      type: 'object',
      properties: {
        since: { type: 'string', description: 'YYYY-MM-DD, a local day' },
        until: { type: 'string', description: 'YYYY-MM-DD, a local day' },
        state: { type: 'string', enum: ['decided', 'escalated', 'rule', 'open'] },
        limit: { type: 'integer', minimum: 1, maximum: 1000, default: 300 },
      },
    },
  },
  {
    name: 'timelog',
    description:
      'The subject\'s time per local day and initiative, from the attribution plan (decided, pinned and rule decisions): calls count in ' +
      'full (topics by share), runs of messages and work blocks are unioned per initiative minus call time, split aliases distribute by ' +
      'weight; unattributed time is its own row with `confidence` open|escalated and the candidates. Policy from the tenant config ' +
      `(sum | wallclock). since/until: YYYY-MM-DD, each a whole day in ${ZONE_DOC}; default: this month so far. ` +
      'With budgets in the tenant config, `reconciliation` covers the month of `until` from its first day (whatever the window): per ' +
      'budget the units used (half-days rounded per billing code, hours), the month\'s cap (overrides win) and what is left, plus ' +
      'minutes per umbrella, non-billable and unrouted time. Quote it; never recompute it.',
    inputSchema: {
      type: 'object',
      properties: {
        since: { type: 'string', description: 'YYYY-MM-DD, a local day' },
        until: { type: 'string', description: 'YYYY-MM-DD, a local day' },
      },
    },
  },
  {
    name: 'people',
    description: 'Look up known people by name or identity (email / slack id); returns person_id, company, marker {type: exclusive|narrow|broad, initiatives}, identities.',
    inputSchema: { type: 'object', properties: { q: { type: 'string' } } },
  },
  {
    name: 'stats',
    description:
      'Coverage of the replica: per-source message, task, meeting and local-activity counts and time ranges, events, files, people, ' +
      'fragments, `tz` (the zone dates are read in), `now`, and `meta` — last build plus, where the poller records it, ' +
      '`pulled.<source> {at, age_minutes}`. A source older than its pull interval: name it and its last pull, then continue with what you have.',
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

function hasColumn(db, table, col) {
  try {
    return db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col);
  } catch {
    return false;
  }
}

// Rows already sorted best-first: keep the first hit per call, remember the other copies.
export function collapseCalls(rows) {
  const seen = new Map();
  const out = [];
  for (const r of rows) {
    if (r.kind !== 'meeting' || !r.call_id) {
      out.push(r);
      continue;
    }
    const first = seen.get(r.call_id);
    if (first) {
      first.also.push({ source: r.source, ref: r.ref });
      continue;
    }
    const row = { ...r, also: [] };
    seen.set(r.call_id, row);
    out.push(row);
  }
  return out;
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
  const excludeBots = !args.includeBots && hasColumn(db, 'messages', 'is_bot');
  const hasCalls = hasColumn(db, 'meetings', 'call_id');
  const f = { match, since, until, source: args.source, personIds, initiative, limit: args.limit, excludeBots, hasCalls };
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
  rows = collapseCalls(rows);
  rows = rows.slice(0, Math.max(1, Math.min(100, Number(args.limit) || 20)));
  return {
    mode: q.mode,
    ...(notes.length ? { note: notes.join('; ') } : {}),
    hits: rows.map((r) => ({
      ...(r.kind === 'task' ? { kind: 'task', status: r.status, statusCategory: r.status_category } : {}),
      ...(r.kind === 'meeting' ? { kind: 'meeting', ...(r.call_id ? { call_id: r.call_id } : {}), ...(r.also?.length ? { also: r.also } : {}) } : {}),
      ref: r.ref,
      source: r.source,
      ts: r.ts,
      author: r.author_person || r.author_raw,
      ...(r.kind ? {} : toField(r)),
      container: r.container,
      subject: r.subject,
      snippet: r.snippet,
      permalink: r.permalink,
      ...(r.scrub_withheld ? { withheld: true } : {}),
    })),
  };
}

/**
 * The other side of a message: participants minus its author, as short labels ("Tess North | Partner",
 * no address). `author` alone cannot tell direction — a mail Owen SENT has Owen as author and sits in
 * …/Sent Items; the 2026-10-14 brief read exactly such a hit as "Tobin wrote". Empty (omitted) for a
 * channel post, whose participants are just the author.
 */
function toField(r) {
  let p = [];
  try {
    p = JSON.parse(r.participants || '[]');
  } catch {
    p = [];
  }
  const me = String(r.author_raw || '');
  const short = (x) => String(x).replace(/\s*<[^>]*>\s*$/, '').trim() || String(x);
  const to = p.filter((x) => x !== me).map(short);
  if (!to.length) return {};
  return { to: to.length > 6 ? [...to.slice(0, 6), `+${to.length - 6}`] : to };
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

// ── meetings: speaker labels, summary preview ───────────────────────────────────────────
const LABEL_RE = /^([^:\n]{1,60}):\s/;
const ANON_LABEL_RE = /^speaker\s*[0-9a-z]{1,2}$/i;
/**
 * How a transcript labels its turns, judged from the labels themselves, not the recorder:
 *   me-them         "Me:"/"Them:" — Granola's microphone-vs-speaker split, attribution-grade;
 *   names-diarized  person names (Wispr, Gemini) — diarization guesses, turns get swapped;
 *   anonymous       only "Speaker N" — nobody is named at all;
 *   null            no labelled lines (empty or withheld transcript).
 * Only the head is read; a recorder keeps its labelling for the whole call.
 */
export function speakerQuality(transcript) {
  const text = String(transcript ?? '');
  if (text.startsWith('[BODY WITHHELD')) return null;
  const labels = new Set();
  for (const line of text.slice(0, SPEAKER_SAMPLE_CHARS).split('\n')) {
    const m = LABEL_RE.exec(line);
    if (m) labels.add(m[1].trim());
  }
  if (!labels.size) return null;
  const every = (pred) => [...labels].every(pred);
  if (every((l) => l === 'Me' || l === 'Them')) return 'me-them';
  if (every((l) => ANON_LABEL_RE.test(l))) return 'anonymous';
  return 'names-diarized';
}

/** `summary_head` (one char over the limit when longer) → preview cut at a word + flag. */
export function previewSummary(head, max = SUMMARY_PREVIEW_CHARS) {
  const s = String(head ?? '');
  if (s.length <= max) return { summary: s, summary_truncated: false };
  const cut = s.lastIndexOf(' ', max);
  return { summary: `${s.slice(0, cut > max * 0.8 ? cut : max).trimEnd()}…`, summary_truncated: true };
}

/** One recorder copy as `meetings`/`get` list it: ref, transcript size, label quality, withheld flag. */
const copyRow = (c) => ({
  ref: c.ref,
  source: c.source,
  transcript_chars: c.transcript_chars,
  speakers: speakerQuality(c.head),
  ...(c.scrub_withheld ? { withheld: true } : {}),
});

/**
 * `tasks` rows: the newest comment and, inside the `updatedSince` window, how many comments by
 * whom — from the stored comments JSON, so "Rowan: 2 comments on AWS billing" needs no `get`.
 */
export function commentActivity(commentsJson, since) {
  const comments = parseJson(commentsJson || '[]', []);
  const byTs = (Array.isArray(comments) ? comments : []).filter((c) => c && typeof c === 'object').sort((a, b) => String(a.ts ?? '').localeCompare(String(b.ts ?? '')));
  const last = byTs[byTs.length - 1];
  const out = { lastComment: last ? { by: String(last.author ?? ''), at: String(last.ts ?? '') } : null };
  if (since) {
    const t0 = Date.parse(since);
    const recent = byTs.filter((c) => Date.parse(String(c.ts ?? '')) >= t0);
    out.commentsSince = { n: recent.length, authors: [...new Set(recent.map((c) => String(c.author ?? '')).filter(Boolean))] };
  }
  return out;
}

/**
 * `pulled:<source>` scalars in sync_state (the poller's last successful pull per source, once it
 * records them) → `pulled: { <source>: { at, age_minutes } }` for `stats.meta`. The value may be
 * an ISO instant, epoch ms, or a JSON object carrying one (`at`/`finishedAt`/`lastOkAt`); anything
 * else is passed through as `raw`. No such keys (today's replicas) → no `pulled` field.
 */
export function pulledMeta(meta, now = new Date()) {
  const out = {};
  for (const [k, v] of Object.entries(meta ?? {})) {
    if (!k.startsWith('pulled:')) continue;
    let at = parseJson(String(v ?? ''), String(v ?? ''));
    if (at && typeof at === 'object') at = at.at ?? at.finishedAt ?? at.lastOkAt ?? at.ts ?? '';
    const ms = typeof at === 'number' ? at : Date.parse(String(at));
    out[k.slice('pulled:'.length)] = Number.isFinite(ms)
      ? { at: new Date(ms).toISOString(), age_minutes: Math.max(0, Math.round((now.getTime() - ms) / 60_000)) }
      : { raw: String(v) };
  }
  return Object.keys(out).length ? { pulled: out } : {};
}

// `get` on a meeting: the record WITHOUT its transcript (70–100k chars dumped into one tool
// result overflowed the cap five times in a week); `transcript` pages it on demand.
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
    transcript_chars: (mt.transcript || '').length,
    speakers: speakerQuality(mt.transcript),
    url: mt.url,
    deleted: !!mt.deleted,
    attributions: attributionsFor(db, [mt.ref, `meeting:${mt.source}:${mt.id}`]),
    scrub: { withheld: !!mt.scrub_withheld, kinds: mt.scrub_kinds ? mt.scrub_kinds.split(',').filter(Boolean) : [] },
  };
}

export function runMeetings(db, args) {
  if (!hasTable(db, 'meetings')) return { meetings: [], note: 'no meeting sources in this replica' };
  let personIds;
  const notes = [];
  if (args.person) {
    const r = resolvePersonIds(db, args.person);
    personIds = r.ids;
    if (r.note) notes.push(r.note);
  }
  let since = normalizeTime(args.since, 'since');
  const until = normalizeTime(args.until, 'until');
  // No window at all → the last two weeks. The whole history with every copy's next steps is
  // ~70k chars, more than one tool result may carry (it overflowed twice in a week).
  if (!since && !until) {
    since = new Date(Date.now() - DEFAULT_MEETINGS_WINDOW_DAYS * 86_400_000).toISOString();
    notes.push(`no since/until given — showing the last ${DEFAULT_MEETINGS_WINDOW_DAYS} days (since ${since})`);
  }
  const hasCalls = hasColumn(db, 'meetings', 'call_id') && hasTable(db, 'calls');
  const limit = Math.max(1, Math.min(200, Number(args.limit) || 20));
  // Over-fetch copies, then fold them into calls: up to three recorders per call.
  const q = buildMeetingsListSql({ since, until, personIds, source: args.source, limit: limit * 3, hasCalls });
  const rows = db.prepare(q.sql).all(...q.params);
  const callMeta = hasCalls ? db.prepare('SELECT primary_ref, sources, start, "end", title FROM calls WHERE call_id = ?') : undefined;
  const primaryRow = db.prepare(`SELECT ${MEETING_COLS} FROM meetings mt WHERE mt.ref = ?`);
  const otherSteps = db.prepare('SELECT next_steps FROM meetings WHERE call_id = ? AND deleted = 0 AND ref <> ?');
  const copyMeta = db.prepare(COPY_META_SQL);
  const seen = new Set();
  const out = [];
  for (const r of rows) {
    const key = r.call_id || r.ref;
    if (seen.has(key)) continue;
    seen.add(key);
    const meta = r.call_id && callMeta ? callMeta.get(r.call_id) : undefined;
    const primary = meta && meta.primary_ref !== r.ref ? primaryRow.get(meta.primary_ref) ?? r : r;
    const sources = (meta ? parseJson(meta.sources || '[]', []) : [{ source: r.source, ref: r.ref }]).map((s) => {
      const c = copyMeta.get(s.ref);
      return c ? copyRow(c) : s;
    });
    const others = r.call_id ? otherSteps.all(r.call_id, primary.ref) : [];
    out.push({
      ...(r.call_id ? { call_id: r.call_id } : {}),
      ref: primary.ref,
      source: primary.source,
      sources,
      title: (meta && meta.title) || primary.title,
      start: (meta && meta.start) || primary.start,
      end: (meta && meta.end) || primary.end,
      attendees: parseJson(primary.attendees || '[]', []),
      ...previewSummary(primary.summary_head),
      // Next steps from EVERY copy (primary first, de-duplicated): recorders catch different ones.
      next_steps: [...new Set([primary, ...others].flatMap((x) => parseJson(x.next_steps || '[]', [])))],
      transcript_chars: primary.transcript_chars,
      url: primary.url,
      ...(primary.scrub_withheld ? { withheld: true } : {}),
    });
    if (out.length >= limit) break;
  }
  return { ...(notes.length ? { note: notes.join('; ') } : {}), meetings: out };
}

export function runCalendar(db, args) {
  if (!hasTable(db, 'events')) return { events: [], note: 'no calendar sources in this replica' };
  let needles;
  let note;
  if (args.person) {
    const p = String(args.person).trim().toLowerCase();
    const r = resolvePersonIds(db, args.person);
    const ids = r.ids[0] === '__nobody__' ? [] : r.ids;
    const idents = ids.length
      ? db.prepare(`SELECT identity FROM identities WHERE person_id IN (${ids.map(() => '?').join(',')})`).all(...ids).map((x) => String(x.identity).replace(/^[a-z]+:/, '').toLowerCase())
      : [];
    needles = [...new Set([p, ...idents].filter(Boolean))];
    if (!ids.length) note = `no known person matches ${JSON.stringify(args.person)}; matching the text in attendees/organizer`;
  }
  const q = buildCalendarSql({ since: normalizeTime(args.since, 'since'), until: normalizeTime(args.until, 'until'), source: args.source, needles, q: args.q, limit: args.limit });
  return {
    ...(note ? { note } : {}),
    events: db.prepare(q.sql).all(...q.params).map((e) => ({
      ref: e.ref,
      source: e.source,
      account: e.account,
      calendar: e.calendar,
      start: e.start,
      end: e.end,
      title: e.title,
      attendees: parseJson(e.attendees || '[]', []),
      organizer: e.organizer,
      link: e.link,
    })),
  };
}

export function runActivity(db, args) {
  if (!hasTable(db, 'activity')) return { activity: [], note: 'no local activity in this replica (built before the local source)' };
  const q = buildActivitySql({ since: normalizeTime(args.since, 'since'), until: normalizeTime(args.until, 'until'), container: args.container, source: args.source, q: args.q, limit: args.limit });
  return {
    activity: db.prepare(q.sql).all(...q.params).map((a) => ({
      ref: a.ref,
      source: a.source,
      host: a.account,
      container: a.container,
      start: a.start,
      end: a.end,
      minutes: a.minutes,
      title: a.title,
      items: parseJson(a.items || '[]', []),
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

// The attribution layer's readout (OpenSpec attribution-layer): rows the store build wrote into att_*
// tables — no attribution logic here, so every face of the server (stdio, HTTP, the bot's channel) agrees.
const DAY_ARG = /^\d{4}-\d{2}-\d{2}$/;
export function runAttribution(db, args, now = new Date()) {
  const meta = Object.fromEntries(
    hasTable(db, 'sync_state') ? db.prepare("SELECT key, value FROM sync_state WHERE key LIKE 'att:%'").all().map((r) => [r.key.slice(4), r.value]) : [],
  );
  if (!hasTable(db, 'att_fragments') || !meta.subject) {
    return { configured: false, note: 'no attribution layer for this project: the tenant repo has no annotations/attribution.json (or the store predates it)' };
  }
  const tz = LOCAL_TZ; // the store's zone for this call (callTool)
  const dayOf = (iso) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));
  const today = dayOf(now.toISOString());
  const since = DAY_ARG.test(String(args.since ?? '')) ? String(args.since) : today;
  const until = DAY_ARG.test(String(args.until ?? '')) ? String(args.until) : since;
  const states = ['decided', 'escalated', 'rule', 'open'];
  const state = states.includes(args.state) ? args.state : undefined;
  const limit = Math.max(1, Math.min(1000, Number(args.limit) || 300));
  const counts = Object.fromEntries(states.map((s) => [s, 0]));
  // Stored instants are UTC; the requested local days become UTC bounds here, at presentation.
  const lo = normalizeTime(since, 'since', tz);
  const hi = normalizeTime(until, 'until', tz);
  for (const r of db.prepare('SELECT state, count(*) AS n FROM att_fragments WHERE start >= ? AND start <= ? GROUP BY state').all(lo, hi)) counts[r.state] = r.n;
  const pinsJoin = hasTable(db, 'att_pins');
  const rows = db
    .prepare(
      `SELECT f.*${pinsJoin ? ', p.pinned_at, p.rules_version' : ''} FROM att_fragments f${pinsJoin ? ' LEFT JOIN att_pins p ON p.id = f.id' : ''} ` +
        `WHERE f.start >= ? AND f.start <= ?${state ? ' AND f.state = ?' : ''} ORDER BY f.start LIMIT ?`,
    )
    .all(...[lo, hi, ...(state ? [state] : []), limit + 1]);
  const truncated = rows.length > limit;
  const refsOf = (f) => parseJson(f.refs || '[]', []);
  return {
    subject: meta.subject,
    since,
    until,
    tz,
    computed_at: meta.computed_at,
    horizon: { since: meta.since, until: meta.until },
    ...(since < meta.since || until > meta.until ? { note: `outside the computed horizon ${meta.since}..${meta.until}: days there have no fragments` } : {}),
    counts,
    fragments: rows.slice(0, limit).map((f) => {
      const refs = refsOf(f);
      return {
        id: f.id,
        kind: f.kind,
        day: dayOf(f.start),
        start: f.start,
        end: f.end,
        title: f.title,
        state: f.state,
        // What a question about this fragment is about: the conversation (runs), the repo or folder (work);
        // calls are their meeting ref (refs[0]).
        ...(f.container ? { container: f.container } : {}),
        ...(f.weight !== 1 ? { weight: f.weight } : {}),
        ...(f.state === 'open' || f.state === 'rule' ? { candidates: parseJson(f.candidates || '[]', []), hint: f.hint } : {}),
        ...(f.state !== 'open' ? { decided_by: f.decided_by, attributions: parseJson(f.attributions || '[]', []), ...(f.rule_id ? { rule_id: f.rule_id } : {}), ...(f.rationale ? { rationale: f.rationale } : {}) } : {}),
        ...(f.ledger_id && f.ledger_id !== f.id ? { ledger_id: f.ledger_id } : {}),
        ...(f.pinned_at ? { pinned: { at: f.pinned_at, rules_version: f.rules_version } } : {}),
        participants: parseJson(f.participants || '[]', []),
        refs: refs.slice(0, 5),
        ...(refs.length > 5 ? { more_refs: refs.length - 5 } : {}),
      };
    }),
    ...(truncated ? { truncated: true } : {}),
    proposals: hasTable(db, 'att_proposals') ? db.prepare('SELECT * FROM att_proposals ORDER BY id').all().map((p) => ({ id: p.id, question: p.question, options: parseJson(p.options || '[]', []), refs: parseJson(p.refs || '[]', []) })) : [],
  };
}

// ── timelog (OpenSpec attribution-pins-timelog) ─────────────────────────────────────────────
// Minutes per local day (the tenant's zone, cut here at query time) and initiative, over the subject's
// fragments with their effective decision (ledger, pin or rule). The owen-ops CLI's merge rules
// (src/timelog.ts), ported: calls count in full (topics by share), runs and work blocks are unioned per
// initiative minus call time, split aliases distribute by weight, a shared repo's open work follows the
// one candidate active that day, unattributed time is its own row with candidates; policy `wallclock`
// scales parallel work so a day never exceeds wall-clock (calls untouched).
const MIN_MS = 60_000;
export function unionIntervals(xs) {
  const s = xs.filter((x) => x.end > x.start).sort((a, b) => a.start - b.start);
  const out = [];
  for (const x of s) {
    const last = out[out.length - 1];
    if (last && x.start <= last.end) last.end = Math.max(last.end, x.end);
    else out.push({ ...x });
  }
  return out;
}
export function subtractIntervals(xs, cut) {
  let cur = unionIntervals(xs);
  for (const c of unionIntervals(cut)) {
    const next = [];
    for (const x of cur) {
      if (c.end <= x.start || c.start >= x.end) {
        next.push(x);
        continue;
      }
      if (c.start > x.start) next.push({ start: x.start, end: c.start });
      if (c.end < x.end) next.push({ start: c.end, end: x.end });
    }
    cur = next;
  }
  return cur;
}
const totalMinutes = (xs) => Math.round(xs.reduce((a, x) => a + (x.end - x.start), 0) / MIN_MS);

function resolveAliasIn(reg, id) {
  let cur = id;
  for (let i = 0; i < 5; i++) {
    const ini = reg[cur];
    if (!ini || !ini.alias_of || ini.split_into) return cur;
    cur = ini.alias_of;
  }
  return cur;
}
/** Attributions → a route: one initiative, or a split over several (aliases and split_into expanded, shares normalised). */
export function routeOfAttributions(atts, reg) {
  const split = {};
  for (const a of atts) {
    const id = resolveAliasIn(reg, a.initiative);
    const parts = reg[id] && reg[id].split_into ? Object.entries(reg[id].split_into) : [[id, 1]];
    for (const [k, w] of parts) split[k] = (split[k] ?? 0) + a.share * w;
  }
  const ids = Object.keys(split);
  const total = Object.values(split).reduce((a, b) => a + b, 0);
  if (!ids.length || total <= 0) return { initiative: null, confidence: 'none', candidates: [] };
  if (ids.length === 1) return { initiative: ids[0], confidence: 'exact', candidates: ids };
  for (const k of ids) split[k] = Math.round((split[k] / total) * 1000) / 1000;
  return { initiative: null, confidence: 'exact', candidates: ids, split };
}

const MEETING_REF_RE = /^(meeting:|granola:|wispr:|gmeet:)/;
const meetingKey = (f) => (f.refs.find((r) => MEETING_REF_RE.test(r)) ?? f.refs[0] ?? f.id).replace(/^meeting:/, '');

/** Fragments (rows with parsed refs/attributions/candidates) → timed evidence: one per call (topics joined), one per run or work block. */
export function fragmentsToEvidence(rows, reg) {
  const live = rows.filter((f) => f.start && f.end);
  const decided = (f) => f.state === 'decided' || f.state === 'rule';
  const undecided = (f) => ({ initiative: null, confidence: f.state === 'escalated' ? 'escalated' : 'open', candidates: f.candidates || [] });
  const mins = (a, b) => Math.max(0, Math.round((Date.parse(b) - Date.parse(a)) / MIN_MS));
  const out = [];
  const calls = new Map();
  for (const f of live.filter((f) => f.kind === 'call')) calls.set(meetingKey(f), [...(calls.get(meetingKey(f)) ?? []), f]);
  for (const [key, fs] of calls) {
    const start = fs.map((f) => f.start).sort()[0];
    const end = fs.map((f) => f.end).sort().slice(-1)[0];
    const ds = fs.filter(decided);
    out.push({ kind: 'meeting', start, end, minutes: mins(start, end), title: key, ref: `fragment:${fs.map((f) => f.id).join('+')}`, route: ds.length ? routeOfAttributions(ds.flatMap((f) => f.attributions), reg) : undecided(fs[0]) });
  }
  for (const f of live.filter((f) => f.kind !== 'call')) {
    out.push({ kind: 'session', start: f.start, end: f.end, minutes: mins(f.start, f.end), title: f.id, ref: `fragment:${f.id}`, route: decided(f) ? routeOfAttributions(f.attributions, reg) : undecided(f), workKey: `fragment:${f.kind}` });
  }
  return out;
}

/** Shared-repo rule: open WORK with several candidates follows the one candidate that has other decided time that day. */
export function resolveByCoActivity(dayEvidence) {
  const active = new Set(dayEvidence.filter((e) => e.route.initiative && e.route.confidence !== 'open').map((e) => e.route.initiative));
  return dayEvidence.map((e) => {
    if (e.route.confidence !== 'open' || e.workKey !== 'fragment:work' || e.route.candidates.length < 2) return e;
    const hits = e.route.candidates.filter((c) => active.has(c));
    if (hits.length !== 1) return e;
    return { ...e, route: { ...e.route, initiative: hits[0], confidence: 'default' } };
  });
}

function dedupeMeetingEvidence(evs) {
  const kept = [];
  for (const e of [...evs].sort((a, b) => Date.parse(a.start) - Date.parse(b.start))) {
    const s = Date.parse(e.start);
    const en = Date.parse(e.end);
    const dup = kept.find((k) => {
      const ks = Date.parse(k.start);
      const ke = Date.parse(k.end);
      return Math.min(en, ke) - Math.max(s, ks) > 0.5 * Math.min(en - s, ke - ks);
    });
    if (dup) dup.ref += `+${e.ref}`;
    else kept.push({ ...e });
  }
  return kept;
}

const CONF_RANK = ['exact', 'default', 'open', 'escalated', 'none'];
const worst = (a, b) => CONF_RANK[Math.max(CONF_RANK.indexOf(a), CONF_RANK.indexOf(b))];

/** Evidence → per local day and initiative minutes (the CLI's buildTimelog). */
export function buildTimelog(evidence, reg, tz, policy = 'sum') {
  const dayOf = (iso) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));
  const byDay = new Map();
  for (const e of evidence) {
    const d = dayOf(e.start);
    byDay.set(d, [...(byDay.get(d) ?? []), e]);
  }
  const entries = [];
  for (const [day, raw] of [...byDay].sort((a, b) => a[0].localeCompare(b[0]))) {
    const evs = resolveByCoActivity(raw);
    const meetings = dedupeMeetingEvidence(evs.filter((e) => e.kind === 'meeting'));
    const meetingIv = meetings.map((m) => ({ start: Date.parse(m.start), end: Date.parse(m.end) }));
    const acc = new Map();
    const bump = (key, add, ref, conf, candidates, coding = false) => {
      const cur = acc.get(key) ?? { minutes: 0, coding: 0, refs: [], conf, candidates: [] };
      cur.minutes += add;
      if (coding) cur.coding += add;
      cur.refs.push(ref);
      cur.conf = worst(cur.conf, conf);
      cur.candidates = [...new Set([...cur.candidates, ...candidates])];
      acc.set(key, cur);
    };
    const targets = (e) => {
      if (e.route.split) return Object.entries(e.route.split);
      if (e.route.initiative) return [[e.route.initiative, 1]];
      return [[`?${e.route.confidence}:${e.route.candidates.join('|') || e.workKey || e.ref}`, 1]];
    };
    for (const m of meetings) for (const [key, w] of targets(m)) bump(key, Math.round(m.minutes * w), m.ref, m.route.confidence, m.route.candidates);
    const ivByKey = new Map();
    for (const e of evs.filter((e) => e.kind !== 'meeting')) {
      for (const [key, w] of targets(e)) {
        const cur = ivByKey.get(key) ?? { iv: [], weight: w, refs: [], conf: e.route.confidence, candidates: e.route.candidates };
        cur.iv.push({ start: Date.parse(e.start), end: Date.parse(e.end) });
        cur.refs.push(e.ref);
        cur.conf = worst(cur.conf, e.route.confidence);
        ivByKey.set(key, cur);
      }
    }
    for (const [key, v] of ivByKey) {
      const m = totalMinutes(subtractIntervals(unionIntervals(v.iv), meetingIv));
      if (m > 0) bump(key, Math.round(m * v.weight), v.refs.join(','), v.conf, v.candidates, true);
    }
    if (policy === 'wallclock') {
      const wall = totalMinutes(unionIntervals(evs.map((e) => ({ start: Date.parse(e.start), end: Date.parse(e.end) }))));
      const meetingMin = totalMinutes(unionIntervals(meetingIv));
      const codingSum = [...acc.values()].reduce((a, v) => a + v.coding, 0);
      const budget = Math.max(0, wall - meetingMin);
      if (codingSum > budget && codingSum > 0) {
        const f = budget / codingSum;
        for (const v of acc.values()) {
          const scaled = Math.round(v.coding * f);
          v.minutes = v.minutes - v.coding + scaled;
          v.coding = scaled;
        }
      }
    }
    for (const [key, v] of acc) {
      const unattributed = key.startsWith('?');
      const initiative = unattributed ? null : key;
      entries.push({
        day,
        initiative,
        ...(initiative && reg[initiative]?.umbrella ? { umbrella: reg[initiative].umbrella } : {}),
        ...(initiative && typeof reg[initiative]?.billing_code === 'string' ? { billing_code: reg[initiative].billing_code } : {}),
        minutes: v.minutes,
        confidence: unattributed ? (key.startsWith('?escalated') ? 'escalated' : key.startsWith('?open') ? 'open' : 'none') : v.conf,
        ...(unattributed && v.candidates.length ? { candidates: v.candidates } : {}),
        refs: v.refs,
      });
    }
  }
  return entries.sort((a, b) => a.day.localeCompare(b.day) || b.minutes - a.minutes);
}

/**
 * Timelog entries reconciled against the tenant's budgets (attribution.json `budgets`) for one month: per budget the
 * units used — rounded as the frame bills (half-days to 0.5 per breakdown key, then summed; hours to 0.1 on the
 * total) — the month's cap (an override wins) and what is left. Routed time without a billing code (admin buckets,
 * personal work) is non-billable; time without an umbrella is unrouted. Never bends the minutes. The owen-ops CLI's
 * `summarize`, with the frames as tenant data instead of code.
 */
export function reconcile(entries, budgets, month) {
  const unrouted = { minutes: 0, entries: 0 };
  const nonBillable = new Map();
  const perUmbrella = new Map();
  const billable = new Map();
  for (const e of entries) {
    const u = e.umbrella ?? 'unrouted';
    perUmbrella.set(u, (perUmbrella.get(u) ?? 0) + e.minutes);
    if (!e.umbrella) {
      unrouted.minutes += e.minutes;
      unrouted.entries++;
      continue;
    }
    if (e.initiative && !e.billing_code) {
      nonBillable.set(e.initiative, (nonBillable.get(e.initiative) ?? 0) + e.minutes);
      continue;
    }
    billable.set(e.umbrella, [...(billable.get(e.umbrella) ?? []), e]);
  }
  const out = budgets.map((b) => {
    const unitMinutes = b.unitMinutes ?? (b.unit === 'half_day' ? 240 : 60);
    const round = (m) => (b.unit === 'half_day' ? Math.round((m / unitMinutes) * 2) / 2 : Math.round((m / unitMinutes) * 10) / 10);
    const keyOf = (e) => (b.by === 'billing_code' ? e.billing_code : e.initiative) ?? '??';
    const minutes = new Map();
    for (const e of billable.get(b.umbrella) ?? []) minutes.set(keyOf(e), (minutes.get(keyOf(e)) ?? 0) + e.minutes);
    const by = Object.fromEntries([...minutes].sort((x, y) => y[1] - x[1]).map(([k, m]) => [k, { minutes: m, units: round(m) }]));
    const total = [...minutes.values()].reduce((a, m) => a + m, 0);
    const used = b.unit === 'half_day' ? Object.values(by).reduce((a, v) => a + v.units, 0) : round(total);
    const override = b.overrides?.[month];
    const cap = override ?? b.perMonth;
    return {
      umbrella: b.umbrella,
      unit: b.unit,
      minutes: total,
      used,
      ...(cap !== undefined ? { cap, cap_source: override !== undefined ? 'override' : 'default', remaining: Math.round((cap - used) * 10) / 10 } : {}),
      by,
    };
  });
  return {
    budgets: out,
    per_umbrella: Object.fromEntries([...perUmbrella].sort((a, b) => b[1] - a[1])),
    non_billable: [...nonBillable].map(([initiative, minutes]) => ({ initiative, minutes })).sort((a, b) => b.minutes - a.minutes),
    unrouted,
  };
}

export function runTimelog(db, args, now = new Date()) {
  const meta = Object.fromEntries(
    hasTable(db, 'sync_state') ? db.prepare("SELECT key, value FROM sync_state WHERE key LIKE 'att:%'").all().map((r) => [r.key.slice(4), r.value]) : [],
  );
  if (!hasTable(db, 'att_fragments') || !meta.subject) {
    return { configured: false, note: 'no attribution layer for this project: the tenant repo has no annotations/attribution.json (or the store predates it)' };
  }
  const tz = LOCAL_TZ;
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  const since = DAY_ARG.test(String(args.since ?? '')) ? String(args.since) : `${today.slice(0, 8)}01`;
  const until = DAY_ARG.test(String(args.until ?? '')) ? String(args.until) : today;
  const lo = normalizeTime(since, 'since', tz);
  const hi = normalizeTime(until, 'until', tz);
  const reg = parseJson(meta.registry || '{}', {});
  const policy = meta.policy === 'wallclock' ? 'wallclock' : 'sum';
  // Entries are per local day (wall-clock scaling, unions and call trimming never cross a day), so a sub-window's
  // entries are exactly the window's entries for those days.
  const entriesBetween = (a, b) => {
    const rows = db
      .prepare("SELECT id, kind, start, \"end\", state, attributions, candidates, refs FROM att_fragments WHERE start >= ? AND start <= ? AND kind IN ('call', 'thread', 'work') ORDER BY start")
      .all(a, b)
      .map((f) => ({ ...f, attributions: parseJson(f.attributions || '[]', []), candidates: parseJson(f.candidates || '[]', []), refs: parseJson(f.refs || '[]', []) }));
    return buildTimelog(fragmentsToEvidence(rows, reg), reg, tz, policy);
  };
  const entries = entriesBetween(lo, hi);
  const days = new Map();
  const totals = new Map();
  for (const e of entries) {
    const d = days.get(e.day) ?? { day: e.day, minutes: 0, entries: [] };
    d.minutes += e.minutes;
    const { day, refs, ...rest } = e;
    d.entries.push({ ...rest, fragments: refs.join(',').split(/[,+]/).filter(Boolean).length });
    days.set(e.day, d);
    const key = e.initiative ?? `(unattributed: ${e.confidence})`;
    totals.set(key, (totals.get(key) ?? 0) + e.minutes);
  }
  // The month of `until`, from its first day — whatever the window — so a day's close and the month's budgets come
  // from one call.
  const budgets = parseJson(meta.budgets || '[]', []);
  let reconciliation;
  if (budgets.length) {
    const month = until.slice(0, 7);
    const first = `${month}-01`;
    const monthEntries = since === first ? entries : entriesBetween(normalizeTime(first, 'since', tz), hi);
    reconciliation = { month, since: first, until, ...reconcile(monthEntries, budgets, month) };
  }
  return {
    subject: meta.subject,
    since,
    until,
    tz,
    policy,
    computed_at: meta.computed_at,
    ...(since < meta.since || until > meta.until ? { note: `outside the computed horizon ${meta.since}..${meta.until}: days there have no fragments` } : {}),
    total_minutes: entries.reduce((a, e) => a + e.minutes, 0),
    totals: [...totals].map(([initiative, minutes]) => ({ initiative, minutes })).sort((a, b) => b.minutes - a.minutes),
    days: [...days.values()],
    ...(reconciliation ? { reconciliation } : {}),
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
  const updatedSince = normalizeTime(args.updatedSince, 'since');
  const q = buildTasksListSql({
    status: args.status,
    personIds,
    assigneeRaw: personIds ? undefined : args.assignee,
    dueBefore: normalizeTime(args.dueBefore, 'until'),
    project: args.project,
    source: args.source,
    updatedSince,
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
      ...commentActivity(t.comments, updatedSince),
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
    if (mt) {
      const row = meetingRow(db, mt);
      if (!mt.call_id || !hasTable(db, 'calls')) return row;
      const copies = db
        .prepare(`SELECT ref, source, title, summary, next_steps, url, substr(transcript, 1, ${SPEAKER_SAMPLE_CHARS}) AS head, length(transcript) AS transcript_chars, scrub_withheld FROM meetings WHERE call_id = ? AND deleted = 0`)
        .all(mt.call_id);
      const call = db.prepare('SELECT call_id, primary_ref, start, "end", title FROM calls WHERE call_id = ?').get(mt.call_id);
      // Every recorder's view side by side (summary, next steps, label quality): Owen compares
      // recorder quality on exactly this. Each copy's ref is what `transcript` takes.
      return {
        ...row,
        call: call ? { call_id: call.call_id, primary_ref: call.primary_ref, start: call.start, end: call.end, title: call.title } : undefined,
        copies: copies.map((c) => ({ ...copyRow(c), title: c.title, summary: c.summary, next_steps: parseJson(c.next_steps || '[]', []), url: c.url })),
      };
    }
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
    ...toField(m),
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

/**
 * `transcript`: one copy's transcript, paged by characters (whole lines where possible) and
 * optionally filtered to the lines matching `q` ±1 line of context. The filtered text is paged
 * the same way, so a dense match list cannot overflow either.
 */
export function runTranscript(db, args) {
  if (!hasTable(db, 'meetings')) return { error: 'no meeting sources in this replica' };
  const ref = String(args.ref ?? '');
  const byRef = db.prepare('SELECT ref, source, title, transcript, scrub_withheld FROM meetings WHERE ref = ?');
  let mt = byRef.get(ref);
  if (!mt && hasTable(db, 'calls')) {
    const call = db.prepare('SELECT primary_ref FROM calls WHERE call_id = ?').get(ref);
    if (call) mt = byRef.get(call.primary_ref);
  }
  if (!mt) return { error: `no meeting with ref ${JSON.stringify(ref)} — use a copy ref from \`meetings\` / \`get\` (or a call id)` };
  const full = mt.transcript || '';
  const limit = Math.max(1, Math.min(TRANSCRIPT_MAX_CHARS, Math.floor(Number(args.limit)) || TRANSCRIPT_PAGE_CHARS));
  const offset = Math.max(0, Math.floor(Number(args.offset)) || 0);
  const q = String(args.q ?? '').trim();
  let body = full;
  let filter = {};
  if (q) {
    const lines = full.split('\n');
    const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
    const hits = lines.map((l) => {
      const low = l.toLowerCase();
      return terms.every((t) => low.includes(t));
    });
    const keep = new Set();
    hits.forEach((h, i) => {
      if (h) for (const j of [i - 1, i, i + 1]) if (j >= 0 && j < lines.length) keep.add(j);
    });
    const parts = [];
    let prev = -1;
    for (const i of [...keep].sort((a, b) => a - b)) {
      if (parts.length && i !== prev + 1) parts.push('…');
      parts.push(`L${i + 1}: ${lines[i]}`);
      prev = i;
    }
    body = parts.join('\n');
    filter = { q, matches: hits.filter(Boolean).length, lines: lines.length, filtered_chars: body.length };
  }
  // Stop at a line break when more follows: a page that ends mid-sentence costs a second call.
  let end = Math.min(body.length, offset + limit);
  if (end < body.length) {
    const nl = body.lastIndexOf('\n', end);
    if (nl > offset) end = nl + 1;
  }
  return {
    ref: mt.ref,
    source: mt.source,
    title: mt.title,
    transcript_chars: full.length,
    speakers: speakerQuality(full),
    ...(mt.scrub_withheld ? { withheld: true } : {}),
    ...filter,
    offset,
    text: body.slice(offset, end),
    next_offset: end < body.length ? end : null,
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
  events.bySource = db.prepare("SELECT source, count(*) AS n, min(start) AS first, max(start) AS last FROM events WHERE deleted = 0 AND start <> '' GROUP BY source ORDER BY source").all();
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
  const activity = hasTable(db, 'activity')
    ? db.prepare('SELECT source, count(*) AS n, sum(minutes) AS minutes, min(start) AS first, max(start) AS last FROM activity WHERE deleted = 0 GROUP BY source ORDER BY source').all()
    : [];
  const fragments = hasTable(db, 'fragments') ? db.prepare('SELECT status, count(*) AS n FROM fragments GROUP BY status').all() : [];
  const attributions = hasTable(db, 'attributions') ? db.prepare('SELECT count(*) AS n FROM attributions').get().n : 0;
  const now = new Date();
  return {
    tz: LOCAL_TZ,
    now: now.toISOString(),
    messages: bySource,
    tasks,
    meetings,
    activity,
    withheld: withheld.n,
    events,
    files: files.n,
    people: people.n,
    fragments,
    attributions,
    meta: { ...meta, ...pulledMeta(meta, now) },
  };
}

/** The zone a store was built for (`tz` in sync_state), or undefined for an older store. */
function storeZone(db) {
  if (!hasTable(db, 'sync_state')) return undefined;
  const r = db.prepare("SELECT value FROM sync_state WHERE key = 'tz'").get();
  return r && r.value ? String(r.value) : undefined;
}

export function callTool(dbPath, name, args) {
  const db = openDb(dbPath);
  // Present this store's answers in its tenant's zone; restore the default after (calls are synchronous).
  const defaultTz = LOCAL_TZ;
  const zone = storeZone(db);
  if (zone) LOCAL_TZ = resolveTz(zone);
  try {
    switch (name) {
      case 'search':
        return runSearch(db, args ?? {});
      case 'get':
        return runGet(db, args ?? {});
      case 'transcript':
        return runTranscript(db, args ?? {});
      case 'people':
        return runPeople(db, args ?? {});
      case 'tasks':
        return runTasks(db, args ?? {});
      case 'meetings':
        return runMeetings(db, args ?? {});
      case 'fragments':
        return runFragments(db, args ?? {});
      case 'calendar':
        return runCalendar(db, args ?? {});
      case 'activity':
        return runActivity(db, args ?? {});
      case 'unanswered':
        return runUnanswered(db, args ?? {});
      case 'stuck':
        return runStuck(db, args ?? {});
      case 'attribution':
        return runAttribution(db, args ?? {});
      case 'timelog':
        return runTimelog(db, args ?? {});
      case 'stats':
        return runStats(db);
      default:
        throw Object.assign(new Error(`unknown tool ${name}`), { code: -32602 });
    }
  } finally {
    LOCAL_TZ = defaultTz;
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
            `need; cite permalinks. Redaction markers are final. An ISO date is a whole day in ${ZONE_DOC}. ` +
            'Call transcripts are never inlined: `transcript` pages them. `unanswered` and `stuck` are the readouts for ' +
            'what waits for a reply and what stopped moving — quote their rows instead of rebuilding the lists.',
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
