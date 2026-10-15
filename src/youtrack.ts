import type { Config } from './config.js';
import type { AttachmentRef } from './attachments.js';
import { fmtAge } from './format.js';

// YouTrack integration for the support-ticket investigation pilot: a label on a ticket is
// the trigger. This module mirrors github.ts — a thin REST client (typed `fetch` against the
// instance with a permanent token) plus the PURE selection logic (`dueTickets`), which lives
// here with a test so the poller in slack.ts stays a thin shell. Read-only except ONE write:
// postInternalComment — the human-approved "📝 Report to YouTrack" flow (see events.ts).

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

// Who put the trigger tag on a ticket. The tag itself carries no author — only the issue's
// ACTIVITY STREAM does — so this comes from a separate read (tagApplier). Used to treat a
// teammate's manual flag differently from a support agent's: see `taggerMatches`.
export interface TagApplier {
  login: string;
  fullName: string;
  email: string;
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

// Fetch one ticket by id, fresh — the "🔍 Full ticket" modal re-reads YouTrack at click
// time so it shows the current state (new comments included), not the investigation-time
// snapshot. null on any failure; the modal degrades to a "couldn't load" note + link.
export async function getIssue(cfg: Config, id: string): Promise<YouTrackIssue | null> {
  const yt = cfg.youtrack;
  if (!yt) return null;
  try {
    const r = (await ytGet(yt, `/issues/${encodeURIComponent(id)}?fields=${ISSUE_FIELDS}`)) as RawIssue;
    return r?.idReadable ? mapIssue(r) : null;
  } catch {
    return null;
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

// One entry of the issue's TagsCategory activity stream (a tag added or removed, by whom).
interface RawTagActivity {
  timestamp?: number; // epoch ms
  author?: { login?: string; fullName?: string; email?: string };
  added?: Array<{ name?: string }>;
  removed?: Array<{ name?: string }>;
}

// Who most recently ADDED `label`. Pure so the pick is unit-tested. YouTrack returns the
// stream oldest-first, but we sort by timestamp anyway rather than trust the order: a tag
// that was added, removed and re-added must resolve to the LATEST adder (that's the person
// whose flag we're acting on now). undefined when nothing in the stream added the tag —
// e.g. it predates the activity retention, or the token can't read activities.
export function pickTagApplier(activities: RawTagActivity[], label: string): TagApplier | undefined {
  const want = label.trim().toLowerCase();
  const adds = activities
    .filter((a) => (a.added ?? []).some((t) => (t.name ?? '').trim().toLowerCase() === want))
    .sort((x, y) => (x.timestamp ?? 0) - (y.timestamp ?? 0));
  const last = adds[adds.length - 1];
  if (!last?.author) return undefined;
  return {
    login: last.author.login ?? '',
    fullName: last.author.fullName ?? '',
    email: last.author.email ?? '',
  };
}

// Does the tagger appear in a configured list of logins/emails? Case- and whitespace-
// insensitive, and matches EITHER identifier so config can use whichever is stable (login
// "Owen" or "owen@home.example"). Empty list → false, i.e. the feature is off by default.
export function taggerMatches(applier: TagApplier | undefined, list: string[]): boolean {
  if (!applier || list.length === 0) return false;
  const ids = new Set([applier.login, applier.email].map((s) => s.trim().toLowerCase()).filter(Boolean));
  return list.some((entry) => {
    const e = entry.trim().toLowerCase();
    return !!e && ids.has(e);
  });
}

// Best human name for a tagger — full name if the instance has one, else the login/email.
export function applierName(applier: TagApplier): string {
  return applier.fullName || applier.login || applier.email;
}

// Read the issue's tag activity to find who applied the trigger tag. One extra REST call per
// ticket we're about to investigate (not per poll tick), so the cost is negligible.
// undefined on any failure — callers must treat "unknown tagger" as the default path.
export async function tagApplier(cfg: Config, id: string, label: string): Promise<TagApplier | undefined> {
  const yt = cfg.youtrack;
  if (!yt) return undefined;
  try {
    const arr = (await ytGet(
      yt,
      `/issues/${encodeURIComponent(id)}/activities?categories=TagsCategory` +
        `&fields=timestamp,author(login,fullName,email),added(name),removed(name)&$top=100`,
    )) as RawTagActivity[];
    return pickTagApplier(Array.isArray(arr) ? arr : [], label);
  } catch {
    return undefined;
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

// POST against the YouTrack REST API — the write twin of ytGet. Throws on non-2xx with the
// response text so callers can surface the real reason (403 = token lacks Create Comment).
async function ytPost(yt: NonNullable<Config['youtrack']>, path: string, body: unknown): Promise<unknown> {
  const res = await fetch(`${yt.baseUrl.replace(/\/$/, '')}/api${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${yt.token}`, Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`YouTrack ${path} → ${res.status} ${await res.text().catch(() => '')}`);
  return res.json();
}

// The group an INTERNAL comment is restricted to. Helpdesk reporters are external users, so
// "internal" = visible only to the project's team group. Pure so the pick is unit-tested:
// prefer a recommended group; fall back to the single available one; among several, require
// a "... Team" name (YouTrack's per-project team groups end that way). undefined = ambiguous —
// callers must FAIL rather than post publicly (fail-closed: never leak a report to customers).
export function pickInternalGroup(
  recommended: { id: string; name: string }[],
  others: { id: string; name: string }[],
): { id: string; name: string } | undefined {
  const isTeam = (g: { name: string }) => /\bteam$/i.test(g.name.trim());
  const all = [...recommended, ...others];
  return recommended.find(isTeam) ?? (all.length === 1 ? all[0] : all.filter(isTeam).length === 1 ? all.find(isTeam) : undefined);
}

// Deep link to one comment on the ticket (the "✅ Posted" confirmation in Slack).
export function commentUrl(baseUrl: string, issueId: string, commentId: string): string {
  return `${baseUrl.replace(/\/$/, '')}/issue/${issueId}#focus=Comments-${commentId}.0-0`;
}

// Post an INTERNAL comment (team-only visibility) on a ticket. Two calls: resolve the
// visibility group the instance offers for this issue, then create the comment restricted to
// it. Throws (never degrades to a public comment) when the group is ambiguous/absent or the
// token lacks Create Comment — the caller shows the error to the human who clicked Send.
export async function postInternalComment(
  cfg: Config,
  issueId: string,
  text: string,
): Promise<{ commentId: string; url: string; group: string }> {
  const yt = cfg.youtrack;
  if (!yt) throw new Error('YouTrack is not configured');
  const vis = (await ytPost(yt, `/visibilityGroups?fields=recommendedGroups(id,name),groupsWithoutRecommended(id,name)`, {
    issues: [{ idReadable: issueId }],
  })) as {
    recommendedGroups?: { id?: string; name?: string }[];
    groupsWithoutRecommended?: { id?: string; name?: string }[];
  };
  const clean = (gs?: { id?: string; name?: string }[]) =>
    (gs ?? []).filter((g): g is { id: string; name: string } => !!g.id && !!g.name);
  const group = pickInternalGroup(clean(vis.recommendedGroups), clean(vis.groupsWithoutRecommended));
  if (!group) throw new Error(`no unambiguous team group for ${issueId} — refusing to post (would risk a public comment)`);
  const created = (await ytPost(yt, `/issues/${encodeURIComponent(issueId)}/comments?fields=id`, {
    text,
    visibility: { $type: 'LimitedVisibility', permittedGroups: [{ id: group.id }] },
  })) as { id?: string };
  if (!created.id) throw new Error(`comment on ${issueId}: YouTrack returned no id`);
  return { commentId: created.id, url: commentUrl(yt.baseUrl, issueId, created.id), group: group.name };
}

// Compact extras for the ticket's Slack channel header: "🔴 Critical · 2d old". Priority
// comes from the custom fields (any casing); the red dot only for clearly-urgent names so
// ordinary tickets stay visually calm. '' when there's nothing worth showing.
export function headerExtras(issue: YouTrackIssue, nowMs: number): string {
  const bits: string[] = [];
  const prio = issue.fields.find((f) => f.name.toLowerCase() === 'priority')?.value;
  if (prio) bits.push(`${/critical|show-?stopper|blocker|urgent/i.test(prio) ? '🔴 ' : ''}${prio}`);
  if (issue.createdAt) {
    const age = nowMs - Date.parse(issue.createdAt);
    if (Number.isFinite(age) && age >= 0) bits.push(`${fmtAge(age)} old`);
  }
  return bits.join(' · ');
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
