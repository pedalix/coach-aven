// The normalised TASK record every tracker connector (youtrack, jira, asana, wrike) emits — one shape,
// so the store, the search tool and the overseer's prompt learn trackers once (docs/sources.md →
// "Task trackers"). Raw files are `raw/<kind>/<account>/tasks.jsonl`; the store compacts by
// `source:account:id` (last line wins) exactly like messages.
//
// Scrubbing happens here, at the one write path, like scrubForWrite for messages: tickets are
// where people paste `.env` files and "here are the prod creds" comments, so description AND
// every comment go through the same carrier/inline rules, and a carrier's body is filed in the
// vault and replaced by the withheld marker.
import { scrubText, type ScrubMeta } from '../../scrub.js';
import { scrubForWrite, type SinkOptions } from '../common/sink.js';
import type { TrackerKind } from '../types.js';

export type StatusCategory = 'todo' | 'doing' | 'done';

export interface TaskComment {
  id?: string;
  author: string;
  ts: string;
  text: string;
}

export interface TaskRecord {
  source: TrackerKind;
  /** youtrack: host · jira: site · asana: workspace gid · wrike: API host — the `account` segment of the ref. */
  account: string;
  /** Tracker-internal stable id (YouTrack `id`, Jira `id`, Asana `gid`, Wrike API v4 `id`). */
  id: string;
  /** Human key: CG-50, P1-12; Asana has none → the gid; Wrike → the number in its permalink. */
  key: string;
  title: string;
  status: string;
  statusCategory: StatusCategory;
  /** E-mail when the tracker exposes it, else `<kind>:<login|accountId|name>` — joins via people identities. */
  assignee: string;
  reporter: string;
  /** YYYY-MM-DD or ISO datetime; '' when none. */
  due: string;
  created: string;
  updated: string;
  project: string;
  url: string;
  labels: string[];
  text: string;
  comments: TaskComment[];
  deleted?: boolean;
}

export type ScrubbedTask = TaskRecord & { scrub: ScrubMeta };

/** Map a free-form status name to the three buckets the overseer reasons in. */
export function categoryFromName(name: string, resolved = false): StatusCategory {
  if (resolved) return 'done';
  const n = name.toLowerCase();
  if (/\b(done|closed|resolved|fixed|verified|released|complete|completed|won'?t fix|duplicate|obsolete|cancel+ed|rejected)\b/.test(n)) return 'done';
  if (/(progress|doing|review|testing|\bqa\b|develop|implement|wip|staging|deploy|investigat|blocked|waiting)/.test(n)) return 'doing';
  return 'todo';
}

/** ms-epoch number | ISO string | null → ISO string ('' when absent). */
export function iso(v: unknown): string {
  if (v === null || v === undefined || v === '') return '';
  if (typeof v === 'number' && Number.isFinite(v)) return new Date(v).toISOString();
  if (typeof v === 'string') {
    const t = Date.parse(v);
    return Number.isNaN(t) ? v : new Date(t).toISOString();
  }
  return '';
}

/**
 * Scrub a task before it is written: description as a message (carrier → vault + marker), the
 * title inline, and each comment as its own message so one comment with a DSN does not take
 * the whole ticket down — only that comment's body is withheld.
 */
export function scrubTask(t: TaskRecord, sink: SinkOptions = {}): ScrubbedTask {
  const body = scrubForWrite({ source: t.source, id: t.id, subject: t.title, text: t.text }, sink);
  const kinds = new Set(body.scrub.kinds);
  let redactions = body.scrub.redactions;
  let withheld = body.scrub.withheld;
  const comments = t.comments.map((c, i) => {
    const s = scrubForWrite({ source: t.source, id: `${t.id}#c${c.id ?? i}`, text: c.text }, sink);
    for (const k of s.scrub.kinds) kinds.add(k);
    redactions += s.scrub.redactions;
    withheld ||= s.scrub.withheld;
    return { ...c, text: s.text };
  });
  const title = scrubText(t.title);
  for (const f of title.findings) kinds.add(f.kind);
  redactions += title.findings.length;
  const scrub: ScrubMeta = { withheld, kinds: [...kinds].sort(), redactions, ...(body.scrub.vault ? { vault: body.scrub.vault } : {}) };
  return { ...t, title: title.text, text: body.text, comments, scrub };
}
