// The `activity` shape: a block of Owen's hands-on work on this machine — a cluster of git
// commits in one repo, or a cluster of Claude Code session activity in one working directory.
// Why it is a source at all: the review session runs in the sandbox and cannot see the host's
// repos or ~/.claude transcripts, yet "where did my day go" is mostly this kind of work. So
// the bot pulls it like any other source and the sandbox reads it from the replica.
//
// Block id = hash(source, container, start): a block that grows during the day (more commits
// joining it) keeps its first point and so its id, and re-runs upsert. When a recompute makes
// a block disappear (two blocks merged by a commit in the gap), the puller writes a tombstone.
import { createHash } from 'node:crypto';
import { scrubText } from '../../scrub.js';

export type ActivitySource = 'git' | 'claude';

export interface ActivityItem {
  ts: string;
  text: string;
}

export interface ActivityRecord {
  source: ActivitySource;
  /** The machine the work happened on (os.hostname()). */
  account: string;
  id: string;
  /** Repo identity (`github.com/owner/name`) or, outside any repo, the working directory. */
  container: string;
  start: string;
  end: string;
  minutes: number;
  title: string;
  items: ActivityItem[];
  scrub?: { kinds: string[]; redactions: number };
}

export interface ActivityTombstone {
  source: ActivitySource;
  account: string;
  id: string;
  container: string;
  deleted: true;
}

export function blockId(source: ActivitySource, container: string, startIso: string): string {
  return createHash('sha256').update(`${source}\0${container}\0${startIso}`).digest('hex').slice(0, 16);
}

/** `github.com/owner/name` → `owner/name`; a path → its last two segments. For titles only. */
export function shortContainer(container: string): string {
  if (/^[a-z0-9.-]+\.[a-z]{2,}\//i.test(container)) return container.replace(/^[^/]+\//, '');
  const segs = container.split('/').filter(Boolean);
  return segs.slice(-2).join('/') || container;
}

/**
 * Canonical repo identity from an origin URL: host/owner/name, no scheme, no credentials,
 * no `.git`. Worktrees and clones of one repo collapse to one container.
 */
export function containerOfRemote(remote: string): string | undefined {
  const r = remote.trim();
  if (!r) return undefined;
  const ssh = /^[^@\s]+@([^:\s]+):(.+?)(?:\.git)?\/?$/.exec(r);
  if (ssh) return `${ssh[1]!.toLowerCase()}/${ssh[2]}`;
  try {
    const u = new URL(r);
    return `${u.hostname.toLowerCase()}${u.pathname.replace(/\.git$/, '').replace(/\/$/, '')}`;
  } catch {
    return undefined;
  }
}

/**
 * Commit subjects and first prompts can carry secrets (a pasted token in a prompt, a DSN in a
 * commit message): inline redaction on title and every item. Never withheld — a work block
 * without its titles is useless to the review agent, and the detectors still cut the secret.
 */
export function scrubActivity(r: ActivityRecord): ActivityRecord {
  const title = scrubText(r.title);
  const items = r.items.map((i) => ({ ts: i.ts, s: scrubText(i.text) }));
  const kinds = new Set([...title.findings.map((f) => f.kind), ...items.flatMap((i) => i.s.findings.map((f) => f.kind))]);
  return {
    ...r,
    title: title.text,
    items: items.map((i) => ({ ts: i.ts, text: i.s.text })),
    scrub: { kinds: [...kinds].sort(), redactions: title.findings.length + items.reduce((n, i) => n + i.s.findings.length, 0) },
  };
}
