// YouTrack REST issue → TaskRecord. Pure. Field request lives here too (YOUTRACK_FIELDS) so the
// shape asked for and the shape parsed never drift apart.
import { categoryFromName, iso, type TaskComment, type TaskRecord } from '../trackers/task.js';

export const YOUTRACK_FIELDS =
  'id,idReadable,summary,description,created,updated,resolved,' +
  'reporter(login,email,fullName),project(shortName),tags(name),' +
  'customFields(name,value(name,login,email,fullName,presentation,$type)),' +
  'comments(id,text,created,deleted,author(login,email,fullName))';

type J = Record<string, unknown>;
const s = (v: unknown) => (typeof v === 'string' ? v : '');

export function ytUser(u: unknown): string {
  if (!u || typeof u !== 'object') return '';
  const o = u as J;
  return s(o.email).toLowerCase() || (s(o.login) ? `youtrack:${s(o.login)}` : s(o.fullName));
}

function field(issue: J, ...names: string[]): unknown {
  const cfs = Array.isArray(issue.customFields) ? (issue.customFields as J[]) : [];
  for (const n of names) {
    const f = cfs.find((c) => s(c.name).toLowerCase() === n.toLowerCase());
    if (f) return f.value;
  }
  return undefined;
}

export function normaliseYoutrackIssue(issue: J, base: string): TaskRecord {
  const host = new URL(base).host;
  const state = field(issue, 'State', 'Status', 'Stage');
  const status = state && typeof state === 'object' ? s((state as J).name) : s(state);
  const assigneeV = field(issue, 'Assignee', 'Assignees');
  const assignee = Array.isArray(assigneeV) ? ytUser(assigneeV[0]) : ytUser(assigneeV);
  const dueV = field(issue, 'Due Date', 'Due date', 'Deadline');
  const due = typeof dueV === 'number' ? new Date(dueV).toISOString().slice(0, 10) : '';
  const comments: TaskComment[] = (Array.isArray(issue.comments) ? (issue.comments as J[]) : [])
    .filter((c) => c.deleted !== true)
    .map((c) => ({ id: s(c.id), author: ytUser(c.author), ts: iso(c.created), text: s(c.text) }));
  const key = s(issue.idReadable) || s(issue.id);
  return {
    source: 'youtrack',
    account: host,
    id: s(issue.id),
    key,
    title: s(issue.summary),
    status: status || (issue.resolved ? 'Resolved' : 'Open'),
    statusCategory: categoryFromName(status, issue.resolved !== null && issue.resolved !== undefined),
    assignee,
    reporter: ytUser(issue.reporter),
    due,
    created: iso(issue.created),
    updated: iso(issue.updated),
    project: issue.project && typeof issue.project === 'object' ? s((issue.project as J).shortName) : '',
    url: `${base.replace(/\/+$/, '')}/issue/${key}`,
    labels: (Array.isArray(issue.tags) ? (issue.tags as J[]) : []).map((t) => s(t.name)).filter(Boolean),
    text: s(issue.description),
    comments,
  };
}

/**
 * YouTrack query for one project + optional person scope. Dates as YYYY-MM-DD (day granularity).
 * Verified against YouTrack Cloud 2026-10: a parenthesised OR group needs explicit `and` around
 * it, the reporter keyword is `reporter:` (`by:` does not parse inside a group), and a
 * `sort by:` clause after a group does not parse at all — so no sort: the puller pages through
 * every hit and tracks the max `updated` itself, order is irrelevant.
 */
export function youtrackQuery(project: string, from: Date, person?: string): string {
  const day = from.toISOString().slice(0, 10);
  const scope = person ? ` and (for: ${person} or reporter: ${person} or commenter: ${person})` : '';
  return `project: {${project}} and updated: ${day} .. Today${scope}`;
}
