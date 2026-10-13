// Asana puller. The workspace in question is on a non-premium plan, so the search API is off
// the table: we list `GET /tasks?assignee=<me>&workspace=<w>&modified_since=…` plus, per
// watched project, `GET /tasks?project=<p>&modified_since=…` (the API forbids assignee and
// project together, and `/projects/{gid}/tasks` has no modified_since), keep only the project
// tasks assigned to me or following me (involvesMe — @mentions make followers), dedupe by gid,
// and fetch comment stories per kept task. The free-tier limit is 150 requests/minute → paced
// at one request per 450 ms (~133/min).
import type { AsanaSourcesConfig, PullContext, PullSummary } from '../types.js';
import { createHttp, type Http } from '../trackers/http.js';
import { readTokenFile, runTrackerPull } from '../trackers/writer.js';
import type { TaskRecord } from '../trackers/task.js';
import { ASANA_STORY_FIELDS, ASANA_TASK_FIELDS, commentsFromStories, involvesMe, normaliseAsanaTask, type AsanaMe } from './normalise.js';

const API = 'https://app.asana.com/api/1.0';

export function asanaToken(tokenPath: string): string {
  const t = readTokenFile<{ token?: string }>(tokenPath)?.token;
  if (!t) throw new Error(`no token: ${tokenPath} missing (orch sources auth <slug> asana add)`);
  return t;
}

export function asanaHttp(token: string, log?: (l: string) => void): Http {
  return createHttp({ headers: { Authorization: `Bearer ${token}` }, minIntervalMs: 450, baseBackoffMs: 10_000, ...(log ? { log } : {}) });
}

async function* listTasks(http: Http, query: string): AsyncIterable<Record<string, unknown>> {
  let offset: string | undefined;
  for (;;) {
    const r = await http.get(`${API}/tasks?${query}&opt_fields=${ASANA_TASK_FIELDS}&limit=100${offset ? `&offset=${encodeURIComponent(offset)}` : ''}`);
    const body = (r.json ?? {}) as { data?: Record<string, unknown>[]; next_page?: { offset?: string } | null };
    for (const t of body.data ?? []) yield t;
    offset = body.next_page?.offset;
    if (!offset) break;
  }
}

/** `me` as Asana knows it: /users/me when the config says `me` (default), else the configured gid / e-mail. */
export async function resolveMe(http: Http, assignee = 'me'): Promise<AsanaMe> {
  const a = assignee.trim();
  if (a !== 'me') return /^\d+$/.test(a) ? { gid: a } : { email: a.toLowerCase() };
  const r = await http.get(`${API}/users/me?opt_fields=email`);
  const u = ((r.json ?? {}) as { data?: { gid?: string; email?: string } }).data ?? {};
  const me: AsanaMe = { ...(u.gid ? { gid: String(u.gid) } : {}), ...(u.email ? { email: u.email.toLowerCase() } : {}) };
  // Silent "nothing matches" would look like an empty project; fail the pass instead.
  if (!me.gid && !me.email) throw new Error('GET /users/me returned neither gid nor email');
  return me;
}

export async function* fetchAsana(http: Http, cfg: AsanaSourcesConfig, from: Date, log: (l: string) => void): AsyncIterable<TaskRecord> {
  const since = encodeURIComponent(from.toISOString());
  const queries = [
    { label: `assignee=${cfg.assignee ?? 'me'}`, query: `assignee=${encodeURIComponent(cfg.assignee ?? 'me')}&workspace=${cfg.workspace}&modified_since=${since}`, scoped: false },
    ...(cfg.projects ?? []).map((p) => ({ label: `project=${p}`, query: `project=${p}&modified_since=${since}`, scoped: true })),
  ];
  // One extra request per pull, only when a project is watched.
  const me = cfg.projects?.length ? await resolveMe(http, cfg.assignee) : undefined;
  const seen = new Set<string>();
  for (const q of queries) {
    let n = 0;
    let dropped = 0;
    for await (const t of listTasks(http, q.query)) {
      const gid = String(t.gid ?? '');
      if (!gid || seen.has(gid)) continue;
      // A project task that is neither mine nor followed by me is dropped BEFORE its story fetch.
      if (q.scoped && me && !involvesMe(t, me)) {
        dropped++;
        continue;
      }
      seen.add(gid);
      const st = await http.get(`${API}/tasks/${gid}/stories?opt_fields=${ASANA_STORY_FIELDS}&limit=100`);
      const stories = (((st.json ?? {}) as { data?: Record<string, unknown>[] }).data ?? []);
      n++;
      yield normaliseAsanaTask(t, cfg.workspace, commentsFromStories(stories));
    }
    log(`  ${q.label}: ${n} tasks${dropped ? ` (${dropped} neither assigned to nor followed by me, skipped)` : ''}`);
  }
}

export async function pullAsana(ctx: PullContext, cfg: AsanaSourcesConfig, o: { full?: boolean; since?: string } = {}): Promise<PullSummary> {
  let http: Http;
  try {
    http = asanaHttp(asanaToken(ctx.tokenPath), ctx.log);
  } catch (e) {
    const now = new Date().toISOString();
    return { kind: 'asana', ok: false, reauth: true, counts: {}, errors: [String(e instanceof Error ? e.message : e)], startedAt: now, finishedAt: now };
  }
  return runTrackerPull(ctx, {
    kind: 'asana',
    account: cfg.workspace,
    ...((o.since ?? cfg.since) ? { since: o.since ?? cfg.since } : {}),
    full: o.full ?? false,
    fetchUpdated: (from, log) => fetchAsana(http, cfg, from, log),
  });
}
