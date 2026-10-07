// Asana puller. The workspace in question is on a non-premium plan, so the search API is off
// the table: we list `GET /tasks?assignee=<me>&workspace=<w>&modified_since=…` plus, per
// configured project, `GET /tasks?project=<p>&modified_since=…` (the API forbids assignee and
// project together), dedupe by gid, and fetch comment stories per changed task. The free-tier
// limit is 150 requests/minute → paced at one request per 450 ms (~133/min).
import type { AsanaSourcesConfig, PullContext, PullSummary } from '../types.js';
import { createHttp, type Http } from '../trackers/http.js';
import { readTokenFile, runTrackerPull } from '../trackers/writer.js';
import type { TaskRecord } from '../trackers/task.js';
import { ASANA_STORY_FIELDS, ASANA_TASK_FIELDS, commentsFromStories, normaliseAsanaTask } from './normalise.js';

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

export async function* fetchAsana(http: Http, cfg: AsanaSourcesConfig, from: Date, log: (l: string) => void): AsyncIterable<TaskRecord> {
  const since = encodeURIComponent(from.toISOString());
  const queries = [
    `assignee=${encodeURIComponent(cfg.assignee ?? 'me')}&workspace=${cfg.workspace}&modified_since=${since}`,
    ...(cfg.projects ?? []).map((p) => `project=${p}&modified_since=${since}`),
  ];
  const seen = new Set<string>();
  for (const q of queries) {
    let n = 0;
    for await (const t of listTasks(http, q)) {
      const gid = String(t.gid ?? '');
      if (!gid || seen.has(gid)) continue;
      seen.add(gid);
      const st = await http.get(`${API}/tasks/${gid}/stories?opt_fields=${ASANA_STORY_FIELDS}&limit=100`);
      const stories = (((st.json ?? {}) as { data?: Record<string, unknown>[] }).data ?? []);
      n++;
      yield normaliseAsanaTask(t, cfg.workspace, commentsFromStories(stories));
    }
    log(`  ${q.split('&')[0]}: ${n} tasks`);
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
