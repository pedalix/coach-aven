// Wrike puller (REST v4). Per configured folder or space, with its own cursor (TrackerRun.scope):
//
//   GET /folders/{id}/folders          the subtree's titles — a task's `project` is the folder it sits in
//   GET /folders/{id}/tasks?descendants=true&subTasks=true&updatedDate={"start":…}&fields=[…]&pageSize=1000
//                                      paged by `nextPageToken`; a space id works here like a folder id
//   GET /tasks/{id}/comments?plainText=true   per task: the record carries ALL its comments (the store
//                                      replaces the row), and Wrike takes one task id per call here —
//                                      a comma list answers 400 "Invalid Task ID" (verified live)
//   GET /contacts/{ids}                up to 100 ids per call, cached for the pass (deleted users included)
//   GET /workflows                     once per pass: customStatusId → name + group
//
// A new comment moves the task's `updatedDate` (verified live: the task's updatedDate equals its last
// comment's createdDate to the second), so the folder query alone finds commented tasks; no account-wide
// /comments sweep is needed. Token: a permanent token from the env var `tokenEnv` (default
// WRIKE_API_TOKEN) — Wrike has no token file, the value lives in the bot's / daemon's `.env`.
import type { PullContext, PullSummary, WrikeSourcesConfig } from '../types.js';
import { createHttp, TrackerHttpError, type Http } from '../trackers/http.js';
import { runTrackerPull } from '../trackers/writer.js';
import type { TaskRecord } from '../trackers/task.js';
import { commentsFromWrike, contactIdsOf, dataOf, folderTitles, normaliseWrikeTask, statusMap, updatedSince, WRIKE_TASK_FIELDS, type WrikeStatus } from './normalise.js';

export const WRIKE_TOKEN_ENV = 'WRIKE_API_TOKEN';
export const DEFAULT_WRIKE_HOST = 'www.wrike.com';
/** First-pull horizon of a folder when the config gives no `since` (the other trackers use 90). */
export const WRIKE_DEFAULT_SINCE_DAYS = 30;
const PAGE = 1000;
const CONTACTS_PER_CALL = 100;

type J = Record<string, unknown>;

export function wrikeHost(cfg: WrikeSourcesConfig): string {
  return cfg.host ?? DEFAULT_WRIKE_HOST;
}

export function wrikeToken(cfg: WrikeSourcesConfig): string {
  const name = cfg.tokenEnv ?? WRIKE_TOKEN_ENV;
  const v = process.env[name];
  if (!v?.trim()) throw new Error(`no token: env var ${name} is empty`);
  return v.trim();
}

export function wrikeHttp(token: string, log?: (l: string) => void): Http {
  // Wrike limits requests per user per minute and answers 429 past it; 5 req/s keeps a backfill
  // under it, and the shared client honours Retry-After when it is hit anyway.
  return createHttp({ headers: { Authorization: `Bearer ${token}` }, minIntervalMs: 200, ...(log ? { log } : {}) });
}

/** What one pass learns once and every folder reuses. */
export interface WrikeCache {
  contacts: Map<string, J | null>;
  statuses?: Map<string, WrikeStatus>;
}

export const newWrikeCache = (): WrikeCache => ({ contacts: new Map() });

/** A failed lookup degrades the records (`wrike:<id>`, the standard status) instead of failing the pass — unless the token is dead. */
function degrade(e: unknown, log: (l: string) => void, what: string): void {
  if (e instanceof TrackerHttpError && e.reauth) throw e;
  log(`  ${what} — ${e instanceof Error ? e.message : String(e)}`);
}

async function statuses(http: Http, api: string, cache: WrikeCache, log: (l: string) => void): Promise<Map<string, WrikeStatus>> {
  if (!cache.statuses) {
    try {
      cache.statuses = statusMap(dataOf((await http.get(`${api}/workflows`)).json));
    } catch (e) {
      degrade(e, log, 'workflows unreadable: statuses fall back to the standard four');
      cache.statuses = new Map();
    }
  }
  return cache.statuses;
}

async function resolveContacts(http: Http, api: string, cache: WrikeCache, wanted: string[], log: (l: string) => void): Promise<void> {
  const missing = wanted.filter((id) => !cache.contacts.has(id));
  for (let i = 0; i < missing.length; i += CONTACTS_PER_CALL) {
    const batch = missing.slice(i, i + CONTACTS_PER_CALL);
    try {
      for (const c of dataOf((await http.get(`${api}/contacts/${batch.join(',')}`)).json)) cache.contacts.set(String(c.id ?? ''), c);
    } catch (e) {
      degrade(e, log, `${batch.length} contacts unresolved, kept as wrike:<id>`);
    }
    // Asked once per pass: an id Wrike does not return is not asked again for every task.
    for (const id of batch) if (!cache.contacts.has(id)) cache.contacts.set(id, null);
  }
}

/** Pages of tasks in the folder and everything beneath it, subtasks included, updated at/after `from`. */
async function* folderTaskPages(http: Http, api: string, folder: string, from: Date): AsyncIterable<J[]> {
  const q =
    `descendants=true&subTasks=true&updatedDate=${encodeURIComponent(updatedSince(from))}` +
    `&fields=${encodeURIComponent(JSON.stringify(WRIKE_TASK_FIELDS))}&pageSize=${PAGE}`;
  let token: string | undefined;
  for (;;) {
    const r = await http.get(`${api}/folders/${folder}/tasks?${q}${token ? `&nextPageToken=${encodeURIComponent(token)}` : ''}`);
    const body = (r.json ?? {}) as { nextPageToken?: unknown };
    yield dataOf(r.json);
    const next = typeof body.nextPageToken === 'string' && body.nextPageToken ? body.nextPageToken : undefined;
    // A token handed back unchanged would loop for ever; stop instead.
    if (!next || next === token) break;
    token = next;
  }
}

export async function* fetchWrikeFolder(http: Http, host: string, cache: WrikeCache, folder: string, from: Date, log: (l: string) => void): AsyncIterable<TaskRecord> {
  const api = `https://${host}/api/v4`;
  const folders = folderTitles(dataOf((await http.get(`${api}/folders/${folder}/folders`)).json));
  const fallbackProject = folders.get(folder) || folder;
  const st = await statuses(http, api, cache, log);
  let n = 0;
  for await (const page of folderTaskPages(http, api, folder, from)) {
    // Comments first, for the whole page, so one contacts round trip covers assignees, authors and commenters.
    const comments = new Map<string, J[]>();
    for (const t of page) {
      const id = String(t.id ?? '');
      if (id) comments.set(id, dataOf((await http.get(`${api}/tasks/${id}/comments?plainText=true`)).json));
    }
    await resolveContacts(http, api, cache, contactIdsOf(page, comments.values()), log);
    for (const t of page) {
      const id = String(t.id ?? '');
      if (!id) continue;
      n++;
      yield normaliseWrikeTask(t, { host, contacts: cache.contacts, statuses: st, folders, fallbackProject }, commentsFromWrike(comments.get(id) ?? [], cache.contacts));
    }
  }
  log(`  ${folder} (${folders.size} folders in the subtree): ${n} tasks`);
}

/** One summary for the kind: ok when every folder was, reauth when any needs a human, counts per folder. */
export function mergeSummaries(parts: PullSummary[], now: () => Date = () => new Date()): PullSummary {
  const t = now().toISOString();
  return {
    kind: 'wrike',
    ok: parts.every((p) => p.ok),
    reauth: parts.some((p) => p.reauth),
    counts: Object.assign({}, ...parts.map((p) => p.counts)) as Record<string, number>,
    errors: parts.flatMap((p) => p.errors),
    startedAt: parts[0]?.startedAt ?? t,
    finishedAt: parts.at(-1)?.finishedAt ?? t,
  };
}

/** The first-pull horizon: `--since`, else the config's `since`, else 30 days before `now` (a date, as `since` is). */
export function wrikeSince(cfg: WrikeSourcesConfig, o: { since?: string }, now: Date): string {
  return o.since ?? cfg.since ?? new Date(now.getTime() - WRIKE_DEFAULT_SINCE_DAYS * 86_400_000).toISOString().slice(0, 10);
}

/**
 * Every configured folder in turn, each its own TrackerRun scope (cursor + raw file under
 * `wrike/<host>/<folder>/`). A folder that fails does not stop the others; a task listed under two
 * configured folders is written twice and the store keeps the later line (same ref).
 */
export async function pullWrikeWith(ctx: PullContext, cfg: WrikeSourcesConfig, http: Http, o: { full?: boolean; since?: string; now?: () => Date } = {}): Promise<PullSummary> {
  const now = o.now ?? (() => new Date());
  const host = wrikeHost(cfg);
  const cache = newWrikeCache();
  const since = wrikeSince(cfg, o, now());
  const parts: PullSummary[] = [];
  for (const folder of cfg.folders) {
    parts.push(
      await runTrackerPull(ctx, {
        kind: 'wrike',
        account: host,
        scope: folder,
        since,
        full: o.full ?? false,
        now,
        fetchUpdated: (from, log) => fetchWrikeFolder(http, host, cache, folder, from, log),
      }),
    );
  }
  return mergeSummaries(parts, now);
}

export async function pullWrike(ctx: PullContext, cfg: WrikeSourcesConfig, o: { full?: boolean; since?: string } = {}): Promise<PullSummary> {
  let http: Http;
  try {
    http = wrikeHttp(wrikeToken(cfg), ctx.log);
  } catch (e) {
    const now = new Date().toISOString();
    return { kind: 'wrike', ok: false, reauth: true, counts: {}, errors: [String(e instanceof Error ? e.message : e)], startedAt: now, finishedAt: now };
  }
  return pullWrikeWith(ctx, cfg, http, o);
}
