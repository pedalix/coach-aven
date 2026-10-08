// Jira Cloud issue (REST v3) → TaskRecord, plus the Atlassian Document Format → plain text
// converter v3 forces on us for description and comments. Pure.
import { categoryFromName, iso, type StatusCategory, type TaskComment, type TaskRecord } from '../trackers/task.js';

export const JIRA_FIELDS = ['summary', 'status', 'assignee', 'reporter', 'duedate', 'created', 'updated', 'project', 'labels', 'description', 'comment', 'resolution'];

type J = Record<string, unknown>;
const s = (v: unknown) => (typeof v === 'string' ? v : '');

/** ADF (or a legacy wiki string) → readable plain text: paragraphs/headings end with a newline, list items get "- ". */
export function adfToText(node: unknown): string {
  if (node === null || node === undefined) return '';
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map(adfToText).join('');
  if (typeof node !== 'object') return '';
  const n = node as J;
  const kids = () => adfToText(n.content);
  const attrs = (n.attrs ?? {}) as J;
  switch (n.type) {
    case 'text':
      return s(n.text);
    case 'hardBreak':
      return '\n';
    case 'mention':
      return s(attrs.text) || `@${s(attrs.id)}`;
    case 'emoji':
      return s(attrs.text) || s(attrs.shortName);
    case 'inlineCard':
    case 'blockCard':
      return s(attrs.url);
    case 'status':
      return `[${s(attrs.text)}]`;
    case 'date':
      return attrs.timestamp ? new Date(Number(attrs.timestamp)).toISOString().slice(0, 10) : '';
    case 'paragraph':
    case 'heading':
    case 'codeBlock':
    case 'blockquote':
      return `${kids()}\n`;
    case 'listItem':
      return `- ${kids().replace(/\n+$/, '')}\n`;
    case 'rule':
      return '---\n';
    default:
      return kids();
  }
}

export function jiraUser(u: unknown): string {
  if (!u || typeof u !== 'object') return '';
  const o = u as J;
  return s(o.emailAddress).toLowerCase() || (s(o.accountId) ? `jira:${s(o.accountId)}` : s(o.displayName));
}

const CATEGORY: Record<string, StatusCategory> = { new: 'todo', indeterminate: 'doing', done: 'done' };

export function normaliseJiraIssue(issue: J, site: string): TaskRecord {
  const f = (issue.fields ?? {}) as J;
  const status = (f.status ?? {}) as J;
  const statusName = s(status.name);
  const catKey = s(((status.statusCategory ?? {}) as J).key);
  const commentBlock = (f.comment ?? {}) as J;
  const comments: TaskComment[] = (Array.isArray(commentBlock.comments) ? (commentBlock.comments as J[]) : []).map((c) => ({
    id: s(c.id),
    author: jiraUser(c.author),
    ts: iso(c.created),
    text: adfToText(c.body).trim(),
  }));
  const key = s(issue.key);
  return {
    source: 'jira',
    account: site,
    id: s(issue.id),
    key,
    title: s(f.summary),
    status: statusName,
    statusCategory: CATEGORY[catKey] ?? categoryFromName(statusName, Boolean(f.resolution)),
    assignee: jiraUser(f.assignee),
    reporter: jiraUser(f.reporter),
    due: s(f.duedate),
    created: iso(f.created),
    updated: iso(f.updated),
    project: s(((f.project ?? {}) as J).key),
    url: `https://${site}/browse/${key}`,
    labels: Array.isArray(f.labels) ? (f.labels as unknown[]).filter((x): x is string => typeof x === 'string') : [],
    text: adfToText(f.description).trim(),
    comments,
  };
}

/** "Involves me" by default; the configured JQL replaces it. `updated >=` is always ANDed on (minute granularity, UTC). */
export function jiraJql(from: Date, custom?: string): string {
  const d = from.toISOString();
  const stamp = `${d.slice(0, 10)} ${d.slice(11, 16)}`;
  const base = custom ?? '(assignee = currentUser() OR reporter = currentUser() OR watcher = currentUser() OR comment ~ currentUser())';
  return `(${base}) AND updated >= "${stamp}" ORDER BY updated ASC`;
}
