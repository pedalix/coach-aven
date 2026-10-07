// Asana task (+ its comment stories) → TaskRecord. Pure. Asana has no workflow "status" — the
// board column (section) is what people mean, so status = first membership's section name,
// overridden by `completed`.
import { categoryFromName, iso, type TaskComment, type TaskRecord } from '../trackers/task.js';

export const ASANA_TASK_FIELDS =
  'name,notes,completed,completed_at,assignee.name,assignee.email,created_by.name,created_by.email,' +
  'due_on,due_at,created_at,modified_at,memberships.project.name,memberships.section.name,permalink_url,tags.name,projects.name';
export const ASANA_STORY_FIELDS = 'type,resource_subtype,text,created_at,created_by.name,created_by.email';

type J = Record<string, unknown>;
const s = (v: unknown) => (typeof v === 'string' ? v : '');

export function asanaUser(u: unknown): string {
  if (!u || typeof u !== 'object') return '';
  const o = u as J;
  return s(o.email).toLowerCase() || (s(o.gid) ? `asana:${s(o.gid)}` : s(o.name));
}

export function commentsFromStories(stories: J[]): TaskComment[] {
  return stories
    .filter((st) => st.resource_subtype === 'comment_added' || (st.type === 'comment' && !st.resource_subtype))
    .map((st) => ({ id: s(st.gid), author: asanaUser(st.created_by), ts: iso(st.created_at), text: s(st.text) }));
}

export function normaliseAsanaTask(t: J, workspace: string, comments: TaskComment[] = []): TaskRecord {
  const memberships = Array.isArray(t.memberships) ? (t.memberships as J[]) : [];
  const m0 = memberships[0] ?? {};
  const section = s(((m0.section ?? {}) as J).name);
  const project = s(((m0.project ?? {}) as J).name) || s((((t.projects as J[] | undefined) ?? [])[0] ?? {}).name);
  const completed = t.completed === true;
  const status = completed ? 'Completed' : section || 'Open';
  return {
    source: 'asana',
    account: workspace,
    id: s(t.gid),
    key: s(t.gid),
    title: s(t.name),
    status,
    statusCategory: categoryFromName(section, completed),
    assignee: asanaUser(t.assignee),
    reporter: asanaUser(t.created_by),
    due: s(t.due_at) || s(t.due_on),
    created: iso(t.created_at),
    updated: iso(t.modified_at),
    project,
    url: s(t.permalink_url),
    labels: (Array.isArray(t.tags) ? (t.tags as J[]) : []).map((x) => s(x.name)).filter(Boolean),
    text: s(t.notes),
    comments,
  };
}
