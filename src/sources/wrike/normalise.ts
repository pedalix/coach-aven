// Wrike REST v4 task (+ its comments) → TaskRecord. Pure: the puller hands in what it fetched —
// the task, its comments, the contacts, the workflows' custom statuses and the folder titles of
// the configured subtree — and gets the one `task` shape every tracker emits (trackers/task.ts).
//
// What Wrike does differently from the other trackers, and how it maps:
// - People are ids (`responsibleIds`, `authorIds`, a comment's `authorId`) resolved through
//   /contacts. A person becomes `Name <email>`: the readouts show a name, `resolveIdentity` joins
//   the address inside the brackets to the people file, and `tasks({assignee})` matches either.
// - A task may have several assignees; the record has one, so it keeps the first (as YouTrack's
//   multi-value Assignee does). Known limit, stated in docs/sources.md.
// - Status is a workflow's custom status (`customStatusId` → name + group). The GROUP
//   (Active | Completed | Deferred | Cancelled) is Wrike's own open/closed verdict, so it decides
//   `done`; the name only splits open work into todo/doing.
// - Folders double as tags: a task sits in one or more folders (`parentIds`). The first of them
//   inside the configured subtree is the `project`, the others become labels. A subtask sits in
//   no project folder of its own (its `parentIds` point at the account root); its
//   `superParentIds` do, so they are the fallback before the configured folder's own title.
// - Descriptions are HTML (lists, links, checklists, mentions); comments are asked for as plain
//   text (`plainText=true`).
import { htmlToText } from '../msgraph/normalise.js';
import { categoryFromName, iso, type StatusCategory, type TaskComment, type TaskRecord } from '../trackers/task.js';

/**
 * Optional fields asked for on the task list (the defaults carry id, title, status, importance, dates,
 * createdDate, updatedDate, customStatusId and permalink). Kept here beside the parser so the shape
 * asked for and the shape read never drift apart.
 */
export const WRIKE_TASK_FIELDS = ['description', 'responsibleIds', 'authorIds', 'parentIds', 'superParentIds'];

type J = Record<string, unknown>;
const s = (v: unknown) => (typeof v === 'string' ? v : '');
const ids = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && !!x) : []);

/** `data` of a Wrike envelope (`{kind, data: [...]}`); [] for anything else. */
export function dataOf(body: unknown): J[] {
  const d = body && typeof body === 'object' ? (body as J).data : undefined;
  return Array.isArray(d) ? (d.filter((x) => x && typeof x === 'object') as J[]) : [];
}

/**
 * Wrike's date filters take `yyyy-MM-ddTHH:mm:ssZ` and answer 400 "Parameter 'updatedDate' value is
 * invalid" to the milliseconds `toISOString()` writes — verified against the live API.
 */
export function wrikeStamp(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** The `updatedDate` query value: an open range from `from` on. */
export function updatedSince(from: Date): string {
  return JSON.stringify({ start: wrikeStamp(from) });
}

/** A contact as the record carries it: `Name <email>`, else the e-mail, else the name, else `wrike:<id>`. */
export function wrikePerson(id: string, contacts: ReadonlyMap<string, J | null>): string {
  if (!id) return '';
  const c = contacts.get(id);
  if (!c) return `wrike:${id}`;
  // Brackets in a display name would make `Name <email>` ambiguous to resolveIdentity.
  const name = [s(c.firstName), s(c.lastName)].join(' ').replace(/[<>]/g, '').replace(/\s+/g, ' ').trim();
  const profiles = Array.isArray(c.profiles) ? (c.profiles as J[]) : [];
  // Deleted users lose their e-mail; a robot or a group may have none.
  const email = (s(c.primaryEmail) || s(profiles.find((p) => s(p.email))?.email)).trim().toLowerCase();
  if (email && name) return `${name} <${email}>`;
  return email || name || `wrike:${id}`;
}

export interface WrikeStatus {
  name: string;
  /** Active | Completed | Deferred | Cancelled */
  group: string;
}

/** customStatusId → name + group, over every workflow of the account (GET /workflows). */
export function statusMap(workflows: J[]): Map<string, WrikeStatus> {
  const out = new Map<string, WrikeStatus>();
  for (const w of workflows) {
    for (const st of Array.isArray(w.customStatuses) ? (w.customStatuses as J[]) : []) {
      if (s(st.id)) out.set(s(st.id), { name: s(st.name), group: s(st.group) });
    }
  }
  return out;
}

/** folder id → title for a subtree listing (GET /folders/{id}/folders — the folder itself included). */
export function folderTitles(entries: J[]): Map<string, string> {
  return new Map(entries.filter((f) => s(f.id)).map((f) => [s(f.id), s(f.title)]));
}

/**
 * Wrike's group is the verdict: Completed and Cancelled are done; Deferred is parked but still
 * open work (like an "On hold" elsewhere → todo). In the Active group the name splits todo from
 * doing, and a name that merely reads "done" ("Fixed on staging") stays open, because Wrike says so.
 */
export function wrikeCategory(group: string, name: string): StatusCategory {
  if (group === 'Completed' || group === 'Cancelled') return 'done';
  if (group === 'Deferred') return 'todo';
  const c = categoryFromName(name);
  return c === 'done' ? 'doing' : c;
}

/** The number a person sees in a Wrike link (`open.htm?id=1234567890`); the API id when there is none. */
export function permalinkKey(permalink: string, id: string): string {
  const m = /[?&]id=(\d+)/.exec(permalink);
  return m?.[1] ?? id;
}

/** Plain-text comments (asked with plainText=true), oldest first — a stable order keeps the raw dedupe hash stable. */
export function commentsFromWrike(raw: J[], contacts: ReadonlyMap<string, J | null>): TaskComment[] {
  return raw
    .filter((c) => s(c.text).trim())
    .map((c) => ({ id: s(c.id), author: wrikePerson(s(c.authorId), contacts), ts: iso(c.createdDate), text: s(c.text).trim() }))
    .sort((a, b) => a.ts.localeCompare(b.ts) || a.id.localeCompare(b.id));
}

export interface WrikeLookups {
  /** The API host — the `account` segment of every ref. */
  host: string;
  /** contact id → contact; null = asked and not found. */
  contacts: ReadonlyMap<string, J | null>;
  statuses: ReadonlyMap<string, WrikeStatus>;
  /** folder id → title, for the configured folder and everything beneath it. */
  folders: ReadonlyMap<string, string>;
  /** The configured folder's own title: the project when no parent of the task is in the subtree. */
  fallbackProject: string;
}

export function normaliseWrikeTask(t: J, lk: WrikeLookups, comments: TaskComment[] = []): TaskRecord {
  const id = s(t.id);
  const st = lk.statuses.get(s(t.customStatusId));
  // An unknown custom status (a workflow hidden from this user) still has the standard status.
  const group = st?.group || s(t.status);
  const status = st?.name || s(t.status);
  const parents = ids(t.parentIds).filter((p) => lk.folders.has(p));
  const supers = ids(t.superParentIds).filter((p) => lk.folders.has(p));
  const home = parents[0] ?? supers[0];
  const project = (home && lk.folders.get(home)) || lk.fallbackProject;
  const tags = parents.slice(1).map((p) => lk.folders.get(p) ?? '').filter((x) => x && x !== project);
  const importance = s(t.importance);
  const dates = (t.dates && typeof t.dates === 'object' ? t.dates : {}) as J;
  const permalink = s(t.permalink);
  return {
    source: 'wrike',
    account: lk.host,
    id,
    key: permalinkKey(permalink, id),
    title: s(t.title),
    status,
    statusCategory: wrikeCategory(group, status),
    assignee: wrikePerson(ids(t.responsibleIds)[0] ?? '', lk.contacts),
    reporter: wrikePerson(ids(t.authorIds)[0] ?? '', lk.contacts),
    // `dates.due` is a wall-clock time in the account's zone without an offset; the day is what Wrike shows.
    due: s(dates.due).slice(0, 10),
    created: iso(t.createdDate),
    updated: iso(t.updatedDate),
    project,
    url: permalink,
    labels: [...new Set(tags), ...(importance && importance !== 'Normal' ? [`importance:${importance.toLowerCase()}`] : [])],
    text: htmlToText(s(t.description)),
    comments,
  };
}

/** Every contact id a page of tasks and their comments mention (assignees, authors, comment authors). */
export function contactIdsOf(tasks: J[], comments: Iterable<J[]>): string[] {
  const out = new Set<string>();
  for (const t of tasks) {
    const first = ids(t.responsibleIds)[0];
    if (first) out.add(first);
    const author = ids(t.authorIds)[0];
    if (author) out.add(author);
  }
  for (const list of comments) for (const c of list) if (s(c.authorId)) out.add(s(c.authorId));
  return [...out];
}
