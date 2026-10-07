// Jira Cloud puller over the enhanced search endpoint (POST /rest/api/3/search/jql — the
// classic /search was removed in 2025; pagination is by `nextPageToken`, not startAt).
// Credentials: basic auth e-mail + Atlassian API token, from jira.json `{email, token}` or —
// with `fromNetrc: true` — the bot host's existing `machine <site>` entry in ~/.netrc.
import type { JiraSourcesConfig, PullContext, PullSummary } from '../types.js';
import { createHttp, type Http } from '../trackers/http.js';
import { netrcEntry } from '../trackers/netrc.js';
import { readTokenFile, runTrackerPull } from '../trackers/writer.js';
import type { TaskRecord } from '../trackers/task.js';
import { JIRA_FIELDS, jiraJql, normaliseJiraIssue } from './normalise.js';

export function jiraCredentials(cfg: JiraSourcesConfig, tokenPath: string): { email: string; token: string } {
  if (cfg.fromNetrc) {
    const e = netrcEntry(cfg.site);
    if (!e) throw new Error(`no credentials: no "machine ${cfg.site}" entry in ~/.netrc`);
    return { email: cfg.email ?? e.login, token: e.password };
  }
  const f = readTokenFile<{ email?: string; token?: string }>(tokenPath);
  const email = cfg.email ?? f?.email;
  if (!f?.token || !email) throw new Error(`no credentials: ${tokenPath} needs {email, token} (orch sources auth <slug> jira add --email …)`);
  return { email, token: f.token };
}

export function jiraHttp(c: { email: string; token: string }, log?: (l: string) => void): Http {
  const basic = Buffer.from(`${c.email}:${c.token}`).toString('base64');
  // Jira Cloud's cost-based limits are generous for one user; 4 req/s plus Retry-After handling.
  return createHttp({ headers: { Authorization: `Basic ${basic}` }, minIntervalMs: 250, ...(log ? { log } : {}) });
}

export async function* fetchJira(http: Http, cfg: JiraSourcesConfig, from: Date): AsyncIterable<TaskRecord> {
  let nextPageToken: string | undefined;
  for (;;) {
    const body = { jql: jiraJql(from, cfg.jql), fields: JIRA_FIELDS, maxResults: 100, ...(nextPageToken ? { nextPageToken } : {}) };
    const r = await http.post(`https://${cfg.site}/rest/api/3/search/jql`, body);
    const page = (r.json ?? {}) as { issues?: Record<string, unknown>[]; nextPageToken?: string; isLast?: boolean };
    for (const issue of page.issues ?? []) yield normaliseJiraIssue(issue, cfg.site);
    if (!page.nextPageToken || page.isLast) break;
    nextPageToken = page.nextPageToken;
  }
}

export async function pullJira(ctx: PullContext, cfg: JiraSourcesConfig, o: { full?: boolean; since?: string } = {}): Promise<PullSummary> {
  let http: Http;
  try {
    http = jiraHttp(jiraCredentials(cfg, ctx.tokenPath), ctx.log);
  } catch (e) {
    const now = new Date().toISOString();
    return { kind: 'jira', ok: false, reauth: true, counts: {}, errors: [String(e instanceof Error ? e.message : e)], startedAt: now, finishedAt: now };
  }
  return runTrackerPull(ctx, {
    kind: 'jira',
    account: cfg.site,
    ...((o.since ?? cfg.since) ? { since: o.since ?? cfg.since } : {}),
    full: o.full ?? false,
    fetchUpdated: (from) => fetchJira(http, cfg, from),
  });
}
