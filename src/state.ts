import { existsSync, readFileSync, writeFileSync } from 'node:fs';

// MVP state store: a single JSON file mapping projects → their warm sandbox, plus
// chat-thread → Claude-session bindings. Swap for SQLite later if concurrency demands
// it. Writes are atomic-ish (write whole file each mutation; single-process for now).

export interface ProjectRecord {
  slug: string;
  repo: string; // primary repo, "Org/name"
  sandboxName: string;
  clonedAt?: string;
}

// A chat thread (e.g. a Slack thread) bound to a project's Claude session. Lets a
// restarted bot resume the same conversation via `--resume <sessionId>`.
export interface ChatRecord {
  threadTs: string;
  slug: string;
  sessionId?: string; // Claude conversation id (for --resume)
  // The Daytona session-command driving this thread's persistent claude process. Lets a
  // restarted bot REATTACH to it (it keeps running in the sandbox) instead of spawning a
  // duplicate — see ClaudeSession.attach.
  sessionKey?: string;
  cmdId?: string;
  // A turn whose Slack status message was still "Working…" when the bot last wrote state.
  // On startup the bot reattaches and finalizes this message with the recovered result —
  // see resumeInflightTurns. Cleared when the turn completes.
  inflight?: { channel: string; statusTs: string; msgThreadTs?: string; startedAt: string };
  updatedAt: string;
}

// A scheduled "report" job bound to a project channel. A 60s scheduler tick (in slack.ts)
// matches `cron` against the wall-clock in `tz` and fires `prompt` as a read-only turn on
// session key `cron:<slug>:<id>`. Stored here so jobs survive bot restarts.
export interface RoutineRecord {
  id: string; // short, e.g. "r1"
  slug: string;
  channel: string; // where the digest is posted
  cron: string; // 5-field: "min hour dom mon dow"
  tz: string; // IANA tz the cron is evaluated in
  spec: string; // human-readable original, e.g. "weekdays 9:00"
  prompt: string; // the standing instruction
  enabled: boolean;
  createdBy: string; // Slack user id
  createdAt: string;
  lastRunAt?: string; // last fire (dedupes within a minute + across restarts)
  kind?: 'report' | 'dream'; // undefined/'report' = scheduled digest; 'dream' = memory consolidation
  lastSummary?: string; // dream: one-line digest of the last run (visibility without channel noise)
}

// Per-project runtime settings (mutable, unlike the read-once projects.config.json).
// Currently just the auto-review toggle for the PR-watcher.
export interface ProjectSettings {
  autoReview?: boolean;
  autoReviewSince?: string; // ISO; only auto-review PRs opened after this (skip the backlog on enable)
  autoReviewChannel?: string; // where the poller posts reviews (set when enabled)
  autoReviewEffort?: 'low' | 'med' | 'high'; // effort for auto-reviews (default med)
}

// An autofix subscription on one PR: the poller watches its CI + reviews and posts a Slack
// notification with a "Fix" button when something changes. Keyed by "<Org/repo>#<number>".
// The last* cursors are baselined at subscribe so only post-subscription changes notify.
export interface PrWatch {
  repo: string; // "Org/name"
  number: number;
  slug: string; // owning project
  channel: string; // where notifications go
  createdBy: string;
  createdAt: string;
  lastCiSha?: string;
  lastCiConclusion?: string;
  lastReviewId?: number;
}

interface StateShape {
  projects: Record<string, ProjectRecord>;
  chats?: Record<string, ChatRecord>;
  routines?: Record<string, RoutineRecord>;
  projectSettings?: Record<string, ProjectSettings>;
  // "<Org/repo>#<number>" → ISO timestamp it was auto-reviewed (dedup across restarts).
  reviewedPrs?: Record<string, string>;
  prWatches?: Record<string, PrWatch>; // key = "<Org/repo>#<number>"
  // YouTrack ticket id (e.g. "GLACIER-42") → ISO timestamp it was investigated (the pilot
  // poller investigates each tagged ticket once, surviving restarts — like reviewedPrs).
  seenYouTrackTickets?: Record<string, string>;
}

const STATE_PATH = new URL('../state.json', import.meta.url).pathname;

export class Store {
  private data: StateShape;

  // `path` is injectable so tests can use a throwaway file instead of the real state.json.
  constructor(private readonly path: string = STATE_PATH) {
    this.data = existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as StateShape) : { projects: {} };
  }

  private save() {
    writeFileSync(this.path, JSON.stringify(this.data, null, 2) + '\n');
  }

  getProject(slug: string): ProjectRecord | undefined {
    return this.data.projects[slug];
  }

  // namePrefix lets dev/prod share one Daytona without colliding on warm sandboxes
  // (dev → `dev-proj-<slug>`). Only applied at creation; existing records keep their
  // stored name, so a prod state.json is never re-prefixed.
  upsertProject(slug: string, repo: string, namePrefix = 'proj-'): ProjectRecord {
    const existing = this.data.projects[slug];
    if (existing) {
      existing.repo = repo;
      this.save();
      return existing;
    }
    const rec: ProjectRecord = {
      slug,
      repo,
      sandboxName: `${namePrefix}${slug}`,
    };
    this.data.projects[slug] = rec;
    this.save();
    return rec;
  }

  setProject(rec: ProjectRecord) {
    this.data.projects[rec.slug] = rec;
    this.save();
  }

  getChat(threadTs: string): ChatRecord | undefined {
    return this.data.chats?.[threadTs];
  }

  allChats(): ChatRecord[] {
    return Object.values(this.data.chats ?? {});
  }

  setChat(rec: ChatRecord) {
    (this.data.chats ??= {})[rec.threadTs] = rec;
    this.save();
  }

  // Merge a partial update into a chat record (creating it if absent) without clobbering
  // fields written by a different code path. A key set to `undefined` is deleted. Several
  // concerns touch one record concurrently — sessionId (persist), sessionKey/cmdId (open),
  // inflight (turn start/end) — so they must merge, not overwrite.
  patchChat(threadTs: string, slug: string, patch: Partial<ChatRecord>) {
    const chats = (this.data.chats ??= {});
    const cur = chats[threadTs] ?? { threadTs, slug, updatedAt: '' };
    const next = { ...cur, ...patch, threadTs, slug, updatedAt: new Date().toISOString() };
    for (const k of Object.keys(patch) as (keyof ChatRecord)[]) {
      if (patch[k] === undefined) delete next[k];
    }
    chats[threadTs] = next;
    this.save();
  }

  // ── scheduled report jobs ───────────────────────────────────────────────
  listRoutines(filter?: { slug?: string; channel?: string }): RoutineRecord[] {
    let rs = Object.values(this.data.routines ?? {});
    if (filter?.slug) rs = rs.filter((r) => r.slug === filter.slug);
    if (filter?.channel) rs = rs.filter((r) => r.channel === filter.channel);
    return rs;
  }

  getRoutine(id: string): RoutineRecord | undefined {
    return this.data.routines?.[id];
  }

  // Add a routine, assigning a fresh "r<n>" id (n = highest existing + 1; single-process).
  addRoutine(rec: Omit<RoutineRecord, 'id' | 'createdAt'>): RoutineRecord {
    const routines = (this.data.routines ??= {});
    const maxN = Object.keys(routines).reduce((m, id) => {
      const n = Number(id.replace(/^r/, ''));
      return Number.isFinite(n) && n > m ? n : m;
    }, 0);
    const full: RoutineRecord = { ...rec, id: `r${maxN + 1}`, createdAt: new Date().toISOString() };
    routines[full.id] = full;
    this.save();
    return full;
  }

  patchRoutine(id: string, patch: Partial<RoutineRecord>): RoutineRecord | undefined {
    const cur = this.data.routines?.[id];
    if (!cur) return undefined;
    const next = { ...cur, ...patch, id };
    (this.data.routines ??= {})[id] = next;
    this.save();
    return next;
  }

  deleteRoutine(id: string): boolean {
    if (!this.data.routines?.[id]) return false;
    delete this.data.routines[id];
    this.save();
    return true;
  }

  // ── per-project settings + auto-review dedup ─────────────────────────────
  getProjectSettings(slug: string): ProjectSettings {
    return this.data.projectSettings?.[slug] ?? {};
  }

  patchProjectSettings(slug: string, patch: Partial<ProjectSettings>): ProjectSettings {
    const settings = (this.data.projectSettings ??= {});
    settings[slug] = { ...settings[slug], ...patch };
    this.save();
    return settings[slug];
  }

  // PRs already auto-reviewed (keys "<Org/repo>#<number>"), so the poller reviews each once.
  reviewedPrKeys(): Set<string> {
    return new Set(Object.keys(this.data.reviewedPrs ?? {}));
  }

  markPrReviewed(key: string): void {
    (this.data.reviewedPrs ??= {})[key] = new Date().toISOString();
    this.save();
  }

  // ── YouTrack tickets already investigated (the pilot poller) ─────────────
  seenTicketIds(): Set<string> {
    return new Set(Object.keys(this.data.seenYouTrackTickets ?? {}));
  }

  markTicketSeen(id: string): void {
    (this.data.seenYouTrackTickets ??= {})[id] = new Date().toISOString();
    this.save();
  }

  // ── autofix PR watches (keyed "<Org/repo>#<number>") ─────────────────────
  listPrWatches(filter?: { channel?: string }): PrWatch[] {
    const ws = Object.values(this.data.prWatches ?? {});
    return filter?.channel ? ws.filter((w) => w.channel === filter.channel) : ws;
  }

  getPrWatch(key: string): PrWatch | undefined {
    return this.data.prWatches?.[key];
  }

  setPrWatch(key: string, watch: PrWatch): void {
    (this.data.prWatches ??= {})[key] = watch;
    this.save();
  }

  patchPrWatch(key: string, patch: Partial<PrWatch>): void {
    const cur = this.data.prWatches?.[key];
    if (!cur) return;
    (this.data.prWatches ??= {})[key] = { ...cur, ...patch };
    this.save();
  }

  deletePrWatch(key: string): boolean {
    if (!this.data.prWatches?.[key]) return false;
    delete this.data.prWatches[key];
    this.save();
    return true;
  }
}
