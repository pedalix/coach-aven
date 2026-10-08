// YouTrack puller: per configured project, issues updated since the cursor (optionally scoped to
// one person), with comments. Token = permanent token from ~/.config/coach-aven/sources/<slug>/
// youtrack.json `{token}` or, when `tokenEnv` is configured, from that env var — which lets the
// bot reuse the YOUTRACK_TOKEN it already holds for the label poller without a second copy.
import type { PullContext, PullSummary, YoutrackSourcesConfig } from '../types.js';
import { createHttp, type Http } from '../trackers/http.js';
import { readTokenFile, runTrackerPull } from '../trackers/writer.js';
import type { TaskRecord } from '../trackers/task.js';
import { normaliseYoutrackIssue, YOUTRACK_FIELDS, youtrackQuery } from './normalise.js';

const PAGE = 100;

export function youtrackToken(cfg: YoutrackSourcesConfig, tokenPath: string): string {
  if (cfg.tokenEnv) {
    const v = process.env[cfg.tokenEnv];
    if (!v) throw new Error(`no token: env var ${cfg.tokenEnv} is empty`);
    return v.trim();
  }
  const t = readTokenFile<{ token?: string }>(tokenPath)?.token;
  if (!t) throw new Error(`no token: ${tokenPath} missing (orch sources auth <slug> youtrack add)`);
  return t;
}

export function youtrackHttp(token: string, log?: (l: string) => void): Http {
  // YouTrack Cloud has no published hard limit; 5 req/s keeps a backfill polite.
  return createHttp({ headers: { Authorization: `Bearer ${token}` }, minIntervalMs: 200, ...(log ? { log } : {}) });
}

export async function* fetchYoutrack(http: Http, cfg: YoutrackSourcesConfig, from: Date, log: (l: string) => void): AsyncIterable<TaskRecord> {
  for (const project of cfg.projects) {
    let skip = 0;
    let n = 0;
    for (;;) {
      const q = encodeURIComponent(youtrackQuery(project, from, cfg.assignee));
      const r = await http.get(`${cfg.url}/api/issues?query=${q}&fields=${encodeURIComponent(YOUTRACK_FIELDS)}&$top=${PAGE}&$skip=${skip}`);
      const page = Array.isArray(r.json) ? (r.json as Record<string, unknown>[]) : [];
      for (const issue of page) {
        const t = normaliseYoutrackIssue(issue, cfg.url);
        // Day-granular query: drop what is older than the precise cursor.
        if (!t.updated || Date.parse(t.updated) >= from.getTime()) {
          n++;
          yield t;
        }
      }
      if (page.length < PAGE) break;
      skip += PAGE;
    }
    log(`  ${project}: ${n} issues`);
  }
}

export async function pullYoutrack(ctx: PullContext, cfg: YoutrackSourcesConfig, o: { full?: boolean; since?: string } = {}): Promise<PullSummary> {
  let http: Http;
  try {
    http = youtrackHttp(youtrackToken(cfg, ctx.tokenPath), ctx.log);
  } catch (e) {
    const now = new Date().toISOString();
    return { kind: 'youtrack', ok: false, reauth: true, counts: {}, errors: [String(e instanceof Error ? e.message : e)], startedAt: now, finishedAt: now };
  }
  return runTrackerPull(ctx, {
    kind: 'youtrack',
    account: new URL(cfg.url).host,
    ...((o.since ?? cfg.since) ? { since: o.since ?? cfg.since } : {}),
    full: o.full ?? false,
    fetchUpdated: (from, log) => fetchYoutrack(http, cfg, from, log),
  });
}
