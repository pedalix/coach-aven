import type { Config } from './config.js';
import type { AttachmentRef } from './attachments.js';

// YouTrack integration for the support-ticket investigation pilot: a label on a ticket is
// the trigger. This module mirrors github.ts — a thin REST client (typed `fetch` against the
// instance with a permanent token) plus the PURE selection logic (`dueTickets`), which lives
// here with a test so the poller in slack.ts stays a thin shell. Read-only: we only GET.

export interface YouTrackIssue {
  id: string; // human-readable id, e.g. "GLACIER-42" (YouTrack `idReadable`)
  summary: string;
  description: string; // markdown body ("" if none)
  projectShortName: string; // e.g. "GLACIER" — the id prefix
  tags: string[];
  createdAt: string; // ISO 8601 ("" if unknown)
  reporter: string; // login or full name ("" if unknown)
  fields: TicketField[]; // custom fields that carry a value (Priority, State, Subsystem, …)
  links: TicketLink[]; // linked issues, one entry per target ("duplicates GLACIER-30 …")
}

// A custom field flattened to display text ("Priority" → "Critical"). Unset fields dropped.
export interface TicketField {
  name: string;
  value: string;
}

// One linked issue, labelled direction-aware ("duplicates" vs "is duplicated by"). A resolved
// link is gold for an investigation — it often already names the cause or the fix.
export interface TicketLink {
  type: string;
  id: string; // idReadable of the linked issue
  summary: string;
  resolved: boolean;
}

export interface YouTrackComment {
  author: string;
  createdAt: string;
  text: string;
}

// Shape of a YouTrack issue as returned by the REST API with our `fields` selector.
interface RawIssue {
  idReadable?: string;
  summary?: string;
  description?: string;
  created?: number; // epoch ms
  project?: { shortName?: string };
  tags?: Array<{ name?: string }>;
  reporter?: { login?: string; fullName?: string };
  customFields?: RawCustomField[];
  links?: RawLink[];
}
interface RawCustomField {
  $type?: string; // e.g. "DateIssueCustomField" — how we catch epoch values needing a date render
  name?: string;
  value?: unknown; // polymorphic: see fieldValueText
}
interface RawLink {
  direction?: string; // OUTWARD | INWARD | BOTH
  linkType?: { name?: string; sourceToTarget?: string; targetToSource?: string };
  issues?: Array<{ idReadable?: string; summary?: string; resolved?: number | null }>;
}

// Custom-field values are polymorphic: enum/state/version {name}, user {login,fullName},
// period {presentation}, text {text}, plain string/number, and arrays of any of those for
// multi-value fields. Flatten to display text; '' when unset (the field is then dropped).
export function fieldValueText(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'string' || typeof v === 'number') return String(v);
  if (Array.isArray(v)) return v.map(fieldValueText).filter(Boolean).join(', ');
  if (typeof v === 'object') {
    for (const k of ['name', 'presentation', 'fullName', 'login', 'text'] as const) {
      const x = (v as Record<string, unknown>)[k];
      if (typeof x === 'string' && x.trim()) return x;
    }
  }
  return '';
}

// The human label for a link, from the reading direction: an INWARD link reads
// target→source ("is duplicated by"), anything else source→target ("duplicates").
export function linkTypeLabel(direction: string | undefined, lt?: RawLink['linkType']): string {
  const label = direction === 'INWARD' ? lt?.targetToSource : lt?.sourceToTarget;
  return label ?? lt?.name ?? 'relates to';
}

// Exported for tests only — pure REST→domain mapping.
export const mapIssue = (r: RawIssue): YouTrackIssue => ({
  id: r.idReadable ?? '',
  summary: r.summary ?? '',
  description: r.description ?? '',
  projectShortName: r.project?.shortName ?? '',
  tags: (r.tags ?? []).map((t) => t.name ?? '').filter(Boolean),
  createdAt: r.created ? new Date(r.created).toISOString() : '',
  reporter: r.reporter?.login ?? r.reporter?.fullName ?? '',
  fields: (r.customFields ?? [])
    .map((f) => ({
      name: f.name ?? '',
      // Date fields carry an epoch-ms number — render as a date, not a raw millis count.
      value:
        typeof f.value === 'number' && /date/i.test(f.$type ?? '')
          ? new Date(f.value).toISOString().slice(0, 10)
          : fieldValueText(f.value),
    }))
    .filter((f) => f.name && f.value),
  links: (r.links ?? []).flatMap((l) =>
    (l.issues ?? [])
      .filter((i) => i.idReadable)
      .map((i) => ({
        type: linkTypeLabel(l.direction, l.linkType),
        id: i.idReadable!,
        summary: i.summary ?? '',
        resolved: i.resolved != null,
      })),
  ),
});

const ISSUE_FIELDS =
  'idReadable,summary,description,created,project(shortName),tags(name),reporter(login,fullName),' +
  'customFields(name,value(name,presentation,login,fullName,text)),' +
  'links(direction,linkType(name,sourceToTarget,targetToSource),issues(idReadable,summary,resolved))';

// GET against the YouTrack REST API. Returns parsed JSON, or throws on a non-2xx so callers
// can degrade quietly. `baseUrl` is the instance root (no trailing /api).
async function ytGet(yt: NonNullable<Config['youtrack']>, path: string): Promise<unknown> {
  const res = await fetch(`${yt.baseUrl.replace(/\/$/, '')}/api${path}`, {
    headers: { Authorization: `Bearer ${yt.token}`, Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`YouTrack ${path} → ${res.status} ${await res.text().catch(() => '')}`);
  return res.json();
}

// List every OPEN issue carrying the trigger tag, across all projects (the poller routes
// each to a project by id prefix). Returns [] on any failure so the poller degrades quietly,
// exactly like listOpenPRs. The tag query uses YouTrack syntax: `tag: {AI auto review}`.
export async function listTaggedIssues(cfg: Config, label: string): Promise<YouTrackIssue[]> {
  const yt = cfg.youtrack;
  if (!yt) return [];
  try {
    const query = `tag: {${label}} #Unresolved`;
    const arr = (await ytGet(
      yt,
      `/issues?query=${encodeURIComponent(query)}&fields=${ISSUE_FIELDS}&$top=200`,
    )) as RawIssue[];
    return arr.map(mapIssue);
  } catch {
    return [];
  }
}

// Fetch a ticket's comments (oldest first) to give the agent the full conversation. [] on
// failure — the investigation can still proceed from the summary + description.
export async function listComments(cfg: Config, id: string): Promise<YouTrackComment[]> {
  const yt = cfg.youtrack;
  if (!yt) return [];
  try {
    const arr = (await ytGet(
      yt,
      `/issues/${encodeURIComponent(id)}/comments?fields=text,created,author(login,fullName)&$top=200`,
    )) as Array<{ text?: string; created?: number; author?: { login?: string; fullName?: string } }>;
    return arr
      .filter((c) => (c.text ?? '').trim())
      .map((c) => ({
        author: c.author?.login ?? c.author?.fullName ?? '',
        createdAt: c.created ? new Date(c.created).toISOString() : '',
        text: c.text ?? '',
      }));
  } catch {
    return [];
  }
}

// Resolve a YouTrack attachment `url` (typically a root-relative `/api/files/...?sign=...`) to
// an absolute, fetchable URL against the instance root. Pass-through if it's already absolute.
// Pure so the join is unit-tested (the download itself needs the bearer token, in ingest()).
export function attachmentUrl(baseUrl: string, url: string): string {
  if (/^https?:\/\//i.test(url)) return url;
  const base = baseUrl.replace(/\/$/, '');
  return `${base}${url.startsWith('/') ? '' : '/'}${url}`;
}

// Fetch a ticket's file attachments so the investigation can actually see the screenshots/PDFs
// users lean on. Downloaded + written into the sandbox by ChatSession.ingest (same YT bearer).
// [] on failure — the investigation still proceeds from the text, like listComments.
export async function listAttachments(cfg: Config, id: string): Promise<AttachmentRef[]> {
  const yt = cfg.youtrack;
  if (!yt) return [];
  try {
    const arr = (await ytGet(
      yt,
      `/issues/${encodeURIComponent(id)}/attachments?fields=name,url,mimeType,size&$top=100`,
    )) as Array<{ name?: string; url?: string; mimeType?: string; size?: number }>;
    return arr
      .filter((a) => a.url && a.name)
      .map((a) => ({
        name: a.name!,
        url: attachmentUrl(yt.baseUrl, a.url!),
        mime: a.mimeType ?? '',
        size: a.size ?? 0,
      }));
  } catch {
    return [];
  }
}

// ── pure selection logic (unit-tested in youtrack.test.ts) ───────────────────────

// Does an issue id belong to one of a project's YouTrack prefixes? Ids look like
// "<PREFIX>-<n>" (idReadable). Case-insensitive so config casing doesn't bite.
export function matchesPrefix(id: string, prefixes: string[]): boolean {
  const lid = id.toLowerCase();
  return prefixes.some((p) => {
    const lp = p.toLowerCase();
    return lid === lp || lid.startsWith(`${lp}-`);
  });
}

// Which tagged issues are NEW work for a project: id matches one of the project's prefixes
// and hasn't been seen before. Pure — the caller records the fire (mirrors prsToReview /
// dueRoutines). `seen` is read, not mutated.
export function dueTickets(
  issues: YouTrackIssue[],
  opts: { seen: Set<string>; prefixes: string[] },
): YouTrackIssue[] {
  if (opts.prefixes.length === 0) return [];
  return issues.filter((i) => i.id && !opts.seen.has(i.id) && matchesPrefix(i.id, opts.prefixes));
}
