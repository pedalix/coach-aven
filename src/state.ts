import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';

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
  // A one-way latch: set true the first turn whose answer contained a PR URL, so we stop
  // offering the "Open a PR" button in this thread (a PR already exists — the button would
  // just be noise). "View PR" is still shown per-message whenever a URL is in the answer,
  // so hiding "Open a PR" doesn't hide the link. Never cleared (see answerBlocks).
  prCreated?: boolean;
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
  // undefined/'report' = scheduled digest; 'dream' = memory consolidation;
  // 'housekeeping' = the deterministic sandbox janitor (docs/housekeeping.md)
  kind?: 'report' | 'dream' | 'housekeeping';
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

// One YouTrack ticket's investigation (the pilot poller). The ticket id is the idempotency
// key; `rootTs` is the Slack thread the investigation runs in, so the ticket is durably linked
// to the thread and — via chats[`thread:<rootTs>`] — to the Claude session. This replaces the
// old boolean seen-set: the poller investigates each tagged ticket once, and the record is the
// hook future two-way sync (pull new comments into the thread / post findings back) will use.
export interface TicketInvestigation {
  slug: string; // owning project
  channel: string; // Slack channel id the thread lives in
  rootTs?: string; // thread root ts → session key `thread:<rootTs>` (absent if the header failed)
  startedAt: string; // ISO, when the investigation was dispatched
  finishedAt?: string; // ISO, when the turn settled (step 1 has no failed/retry status yet)
  reportedAt?: string; // ISO, when a report was last posted back to the ticket (📝 flow)
}

interface StateShape {
  projects: Record<string, ProjectRecord>;
  chats?: Record<string, ChatRecord>;
  routines?: Record<string, RoutineRecord>;
  projectSettings?: Record<string, ProjectSettings>;
  // "<Org/repo>#<number>" → ISO timestamp it was auto-reviewed (dedup across restarts).
  reviewedPrs?: Record<string, string>;
  prWatches?: Record<string, PrWatch>; // key = "<Org/repo>#<number>"
  // YouTrack ticket id (e.g. "ESET-42") → its investigation. Supersedes seenYouTrackTickets.
  youtrackInvestigations?: Record<string, TicketInvestigation>;
  // Legacy pre-record dedup (ticket id → ISO). Still READ for dedup back-compat; not written.
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
    // Write-then-rename so a crash mid-write can't leave a truncated state.json — an
    // in-place write that dies half-way makes the NEXT boot fail at JSON.parse, losing
    // everything. rename() on the same filesystem is atomic.
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 2) + '\n');
    renameSync(tmp, this.path);
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

  // ── YouTrack investigations (the pilot poller) ───────────────────────────
  // Every ticket id we've already investigated — the union of the new records and the legacy
  // seen-set — so the poller dedups across both and a state written by an older build still
  // dedups after upgrade.
  investigatedTicketIds(): Set<string> {
    return new Set([
      ...Object.keys(this.data.youtrackInvestigations ?? {}),
      ...Object.keys(this.data.seenYouTrackTickets ?? {}),
    ]);
  }

  getInvestigation(id: string): TicketInvestigation | undefined {
    return this.data.youtrackInvestigations?.[id];
  }

  // Record an investigation at dispatch (before the turn runs), so the ticket→thread link and
  // the dedup survive an immediate crash.
  recordInvestigation(id: string, rec: TicketInvestigation): void {
    (this.data.youtrackInvestigations ??= {})[id] = rec;
    this.save();
  }

  // Stamp finishedAt when the turn settles. No-op if the record is gone.
  finishInvestigation(id: string): void {
    const rec = this.data.youtrackInvestigations?.[id];
    if (!rec) return;
    rec.finishedAt = new Date().toISOString();
    this.save();
  }

  // Reverse lookup: which ticket does this Slack thread investigate? Powers the
  // "📝 Report to YouTrack" button (thread key → ticket id). Linear scan is fine —
  // investigations number in the dozens, and this runs once per finished turn.
  investigationByRoot(rootTs: string): { id: string; rec: TicketInvestigation } | undefined {
    for (const [id, rec] of Object.entries(this.data.youtrackInvestigations ?? {})) {
      if (rec.rootTs === rootTs) return { id, rec };
    }
    return undefined;
  }

  // Stamp reportedAt when a report comment lands on the ticket. No-op if the record is gone.
  markReported(id: string): void {
    const rec = this.data.youtrackInvestigations?.[id];
    if (!rec) return;
    rec.reportedAt = new Date().toISOString();
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

  // ── retention (run at boot + daily; see slack.ts) ────────────────────────
  // Both maps otherwise grow by one record per thread / per PR forever — after months of
  // uptime that's a state.json rewritten wholesale on every patchChat, several times a turn.

  // Drop chat records idle for longer than maxAgeMs. Skips records with a turn in flight
  // (recovery needs them). Losing an old record only loses `--resume` of a long-dead
  // thread — whose transcript has usually been rebuilt away with its sandbox anyway.
  pruneChats(maxAgeMs: number, now = Date.now()): number {
    const chats = this.data.chats ?? {};
    let dropped = 0;
    for (const [key, rec] of Object.entries(chats)) {
      if (rec.inflight) continue;
      const t = Date.parse(rec.updatedAt);
      if (Number.isFinite(t) && now - t > maxAgeMs) {
        delete chats[key];
        dropped++;
      }
    }
    if (dropped) this.save();
    return dropped;
  }

  // Drop auto-review dedup entries older than maxAgeMs. A pruned entry could in principle
  // re-review a PR that's STILL open months later — rare, and a fresh review of such a
  // long-liver is arguably useful; keep the horizon long (90d) rather than track PR state.
  pruneReviewedPrs(maxAgeMs: number, now = Date.now()): number {
    const reviewed = this.data.reviewedPrs ?? {};
    let dropped = 0;
    for (const [key, iso] of Object.entries(reviewed)) {
      const t = Date.parse(iso);
      if (Number.isFinite(t) && now - t > maxAgeMs) {
        delete reviewed[key];
        dropped++;
      }
    }
    if (dropped) this.save();
    return dropped;
  }
}
