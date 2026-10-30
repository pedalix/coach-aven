import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { log } from './log.js';
import { statePath } from './paths.js';
import { splitTeam } from './teamkeys.js';
import type { TeamAccess } from './access.js';
import { countKeyDay, inTaskKey, isOpen, type DeliveryRecord, type HeldMessage, type InTask, type MessagingState, type OutTask } from './messaging/records.js';
import type { Marks } from './messaging/protocol.js';
import type { OutboxRecord, RecordStore } from './messaging/transport.js';

// MVP state store: a single JSON file mapping projects → their warm sandbox, plus
// chat-thread → Claude-session bindings. Swap for SQLite later if concurrency demands
// it. Writes are atomic-ish (write whole file each mutation; single-process for now).
//
// Multi-tenancy invariant (slice 2): EVERY tenant-owned record carries an explicit
// `teamId` (absent = home workspace), so per-tenant export/purge/sharding stays a
// mechanical filter — see exportTenant/purgeTenant. For records keyed by a session key
// (chats) the store STAMPS the field from the key's tenant prefix itself; keyless
// records get it from the caller's event context.

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
  // Owning tenant; absent = home. Stamped by the store from the key's tenant prefix
  // (teamkeys.ts) — callers never pass it, so key and field cannot disagree.
  teamId?: string;
  // Owning chat surface; absent = the installation's default driver. Stamped from the key like
  // teamId (OpenSpec multi-driver-installation): a record saved before surfaces exist has none.
  surface?: string;
  sessionId?: string; // Claude conversation id (for --resume)
  // The sandbox session command driving this thread's persistent claude process. Lets a
  // restarted bot REATTACH to it (it keeps running in the sandbox) instead of spawning a
  // duplicate — see ClaudeSession.attach.
  sessionKey?: string;
  cmdId?: string;
  // A turn whose Slack status message was still "Working…" when the bot last wrote state.
  // On startup the bot reattaches and finalizes this message with the recovered result —
  // see resumeInflightTurns. Cleared when the turn completes.
  inflight?: {
    channel: string;
    statusTs: string;
    msgThreadTs?: string;
    startedAt: string;
    // The turn's message uuid in a session with the message ledger (agent-messaging D13): the
    // restart's recovery settles the turn only on the result after its echo.
    uuid?: string;
  };
  // The session was spawned with the message ledger (agent-messaging D13). A reattach follows this,
  // not the current configuration. Absent on every session of a project without `messaging`.
  ledger?: true;
  // A one-way latch: set true the first turn whose answer contained a PR URL. Shown in the
  // session panel ("has this thread produced a PR?"). Never cleared.
  prCreated?: boolean;
  updatedAt: string;
}

// A scheduled "report" job bound to a project channel. A 60s scheduler tick (in slack.ts)
// matches `cron` against the wall-clock in `tz` and fires `prompt` as a read-only turn on
// session key `cron:<id>:<slug>`. Stored here so jobs survive bot restarts.
export interface RoutineRecord {
  id: string; // short, e.g. "r1"
  slug: string;
  teamId?: string; // owning tenant (absent = home); the poller posts with this team's token
  surface?: string; // owning chat surface (absent = the default driver) — a routine delivers where it was created
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
  // 'housekeeping' = the deterministic sandbox janitor (docs/housekeeping.md);
  // 'task' = a scheduled turn that MAY edit/commit per the project's instructions (TASK_FRAMING)
  kind?: 'report' | 'dream' | 'housekeeping' | 'task';
  // dream/housekeeping: one-line digest of the last run (visibility without channel noise);
  // report/task under the delivery guard: the delivered answer's headline.
  lastSummary?: string;
  // ── routine delivery guard (ROUTINE_GUARD=1 — docs/runtime-config.md) ──────────────────
  // Written only while the guard is on (routineguard.ts); prod records never carry them. All
  // cleared at every fire and set when the run settles, so an absent lastOutcome with a
  // lastRunAt means "the bot restarted mid-run — outcome not recorded".
  lastOutcome?: 'ok' | 'error' | 'canceled' | 'skipped'; // how the last fire settled ('skipped' = empty-slot skip, no turn)
  lastReason?: string; // error: one line of the failure (≤ 200 chars)
  lastDeliveredAt?: string; // ok: ISO, when the answer landed in Slack
  lastFire?: 'scheduled' | 'late' | 'retry' | 'manual'; // what kind of fire the last run was
  // A pending one-shot retry of a failed scheduled run: fired by the scheduler at the first tick
  // ≥ `at` while `slot` is still inside the grace window; consumed by any fire of the routine.
  retry?: { at: string; slot: string };
  // Empty-slot skip (ROUTINE_SKIP_EMPTY=1): `skipEmpty: false` opts a routine out; the raw-record
  // count of the project's replica when the last run was delivered is the fingerprint a slot is
  // compared with (routineguard.ts emptySkipDecision).
  skipEmpty?: boolean;
  lastDeliveredRawCount?: number;
}

// Per-project runtime settings (mutable, unlike the read-once projects.config.json).
// Currently just the auto-review toggle for the PR-watcher.
export interface ProjectSettings {
  autoReview?: boolean;
  autoReviewSince?: string; // ISO; only auto-review PRs opened after this (skip the backlog on enable)
  autoReviewChannel?: string; // where the poller posts reviews (set when enabled)
  // Tenant whose token posts the reviews (absent = home). Settings stay keyed by slug
  // alone, so `review auto on|off` is restricted to the project's OWNER team — see
  // commands.ts; a per-(team,slug) split is deliberate non-scope while sharing is
  // a capability, not a feature.
  autoReviewTeam?: string;
  autoReviewSurface?: string; // the surface `review auto on` was typed on (absent = the default driver)
  autoReviewEffort?: 'low' | 'med' | 'high'; // effort for auto-reviews (default med)
}

// An autofix subscription on one PR: the poller watches its CI + reviews and posts a Slack
// notification with a "Fix" button when something changes. Keyed by
// withTeam(tenant, "<Org/repo>#<number>") — the tenant prefix (absent = home) keeps two
// teams' watches on a shared repo from overwriting each other.
// The last* cursors are baselined at subscribe so only post-subscription changes notify.
export interface PrWatch {
  repo: string; // "Org/name"
  number: number;
  slug: string; // owning project
  teamId?: string; // owning tenant (absent = home); the poller posts with this team's token
  surface?: string; // owning chat surface (absent = the default driver)
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
  teamId?: string; // owning tenant (absent = home) — where the investigation thread lives
  surface?: string; // owning chat surface (absent = the default driver)
  channel: string; // Slack channel id the thread lives in
  rootTs?: string; // thread root ts → session key `thread:<rootTs>` (absent if the header failed)
  startedAt: string; // ISO, when the investigation was dispatched
  finishedAt?: string; // ISO, when the turn settled (step 1 has no failed/retry status yet)
  reportedAt?: string; // ISO, when a report was last posted back to the ticket (📝 flow)
}

interface StateShape {
  projects: Record<string, ProjectRecord>;
  chats?: Record<string, ChatRecord>;
  // Slack OAuth installations, keyed by enterpriseId ?? teamId (see installations.ts).
  // Stored opaquely (@slack/oauth Installation objects) — state.ts doesn't interpret them.
  // ⚠️ These carry live bot tokens, which is why save() writes state.json with mode 0600.
  installations?: Record<string, unknown>;
  // Teams installations: the Bot Connector base URL the tenant's activities come from — the
  // one thing a proactive send (routines, recovery) needs that no inbound activity provides.
  teams?: { serviceUrl?: string };
  // The web surface's people (OpenSpec web-chat-driver D5): the identity provider's subject → the name
  // and e-mail seen at login, so posts and `<@id>` mentions render a name after a restart too.
  webUsers?: Record<string, WebUser>;
  // Per-workspace actor access (who may drive the agent), keyed by raw tenant id.
  // Absent = the access.ts defaults (home open; client teams installer-allowlisted).
  teamAccess?: Record<string, TeamAccess>;
  routines?: Record<string, RoutineRecord>;
  projectSettings?: Record<string, ProjectSettings>;
  // "<Org/repo>#<number>" → ISO timestamp it was auto-reviewed (dedup across restarts).
  reviewedPrs?: Record<string, string>;
  prWatches?: Record<string, PrWatch>; // key = "<Org/repo>#<number>"
  // YouTrack ticket id (e.g. "ESET-42") → its investigation. Supersedes seenYouTrackTickets.
  youtrackInvestigations?: Record<string, TicketInvestigation>;
  // Legacy pre-record dedup (ticket id → ISO). Still READ for dedup back-compat; not written.
  seenYouTrackTickets?: Record<string, string>;
  // Agent messaging (OpenSpec agent-messaging; shapes in messaging/records.ts): tasks both ways, marks,
  // held messages, learned domains, daily caps and the transports' records. Absent until first used.
  messaging?: MessagingState;
}

// A person who logged in on the web surface, keyed by the user id the driver derived from the OIDC subject.
export interface WebUser {
  id: string;
  name?: string;
  email?: string;
  seenAt: string; // ISO, the last login
}

export class Store {
  private data: StateShape;

  // `path` is injectable so tests can use a throwaway file instead of the real state.json.
  constructor(private readonly path: string = statePath()) {
    this.data = existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as StateShape) : { projects: {} };
    // The dispatch primitive is retired (OpenSpec `retire-agent-dispatch` D4): its records are dropped in
    // memory on load, and the bot's next normal save persists that. Never a save here: a read-only CLI
    // (`orch routines list`, `--from-install`) loads the store too and must not rewrite state.json under the bot.
    const legacy = this.data as StateShape & { proposals?: Record<string, unknown>; dispatches?: Record<string, number> };
    if (legacy.proposals !== undefined || legacy.dispatches !== undefined) {
      const proposals = Object.keys(legacy.proposals ?? {}).length;
      const dispatches = Object.keys(legacy.dispatches ?? {}).length;
      delete legacy.proposals;
      delete legacy.dispatches;
      log.info(`state: dropping the retired dispatch records — ${proposals} proposal(s), ${dispatches} daily count(s) — on the next save`);
    }
  }

  private save() {
    // Write-then-rename so a crash mid-write can't leave a truncated state.json — an
    // in-place write that dies half-way makes the NEXT boot fail at JSON.parse, losing
    // everything. rename() on the same filesystem is atomic.
    const tmp = `${this.path}.tmp`;
    // mode 0600: installations carry live per-workspace bot tokens, so the file is
    // owner-only. rename() gives state.json the tmp file's inode (and thus its mode).
    writeFileSync(tmp, JSON.stringify(this.data, null, 2) + '\n', { mode: 0o600 });
    renameSync(tmp, this.path);
  }

  getProject(slug: string): ProjectRecord | undefined {
    return this.data.projects[slug];
  }

  // namePrefix lets dev/prod share one Docker host without colliding on containers
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
    // teamId is derived from the key here (never trusted from the caller) — the one
    // writer keeps key and field permanently in agreement. Home records stay FIELD-LESS
    // (delete, not undefined), so both writers produce the same shape.
    const parts = splitTeam(rec.threadTs);
    const next = { ...rec, teamId: parts.tenantId, surface: parts.surface };
    if (!next.teamId) delete next.teamId;
    if (!next.surface) delete next.surface;
    (this.data.chats ??= {})[rec.threadTs] = next;
    this.save();
  }

  // Merge a partial update into a chat record (creating it if absent) without clobbering
  // fields written by a different code path. A key set to `undefined` is deleted. Several
  // concerns touch one record concurrently — sessionId (persist), sessionKey/cmdId (open),
  // inflight (turn start/end) — so they must merge, not overwrite.
  patchChat(threadTs: string, slug: string, patch: Partial<ChatRecord>) {
    const chats = (this.data.chats ??= {});
    const cur = chats[threadTs] ?? { threadTs, slug, updatedAt: '' };
    // teamId comes from the key, never from the patch — see setChat.
    const { tenantId: teamId, surface } = splitTeam(threadTs);
    const next = { ...cur, ...patch, threadTs, slug, teamId, surface, updatedAt: new Date().toISOString() };
    for (const k of Object.keys(patch) as (keyof ChatRecord)[]) {
      if (patch[k] === undefined) delete next[k];
    }
    if (!teamId) delete next.teamId; // home stays field-less (uniform with bare keys)
    if (!surface) delete next.surface; // the default surface too
    chats[threadTs] = next;
    this.save();
  }

  // The idle stop stopped this project's sandbox (OpenSpec sandbox-idle-stop, design D7): every
  // session process in it ended, so no chat of the project may be reattached by pid after a bot
  // restart. Drops `sessionKey`/`cmdId` from every chat of the slug that has them and no turn in
  // flight (recovery owns those), in ONE write, and nothing else: `sessionId` stays (the next turn
  // resumes the conversation), `ledger` stays, and `updatedAt` stays — patchChat would stamp it,
  // and every stop would then restart the 45-day retention of every conversation in the project.
  forgetSessionProcesses(slug: string): number {
    let n = 0;
    for (const rec of Object.values(this.data.chats ?? {})) {
      if (rec.slug !== slug || rec.inflight || (rec.sessionKey === undefined && rec.cmdId === undefined)) continue;
      delete rec.sessionKey;
      delete rec.cmdId;
      n++;
    }
    if (n) this.save();
    return n;
  }

  // ── Teams: the service URL seen on the last inbound activity ──
  getTeamsServiceUrl(): string | undefined {
    return this.data.teams?.serviceUrl;
  }
  setTeamsServiceUrl(url: string): void {
    if (this.data.teams?.serviceUrl === url) return;
    (this.data.teams ??= {}).serviceUrl = url;
    this.save();
  }

  // ── Web: the people who logged in (name and e-mail by user id) ──
  getWebUser(id: string): WebUser | undefined {
    return this.data.webUsers?.[id];
  }
  putWebUser(rec: WebUser): void {
    const cur = this.data.webUsers?.[rec.id];
    if (cur && cur.name === rec.name && cur.email === rec.email && cur.seenAt === rec.seenAt) return;
    (this.data.webUsers ??= {})[rec.id] = rec;
    this.save();
  }
  listWebUsers(): WebUser[] {
    return Object.values(this.data.webUsers ?? {});
  }

  // ── Slack OAuth installations (keyed enterpriseId ?? teamId; see installations.ts) ──
  getInstallation(key: string): unknown | undefined {
    return this.data.installations?.[key];
  }

  setInstallation(key: string, install: unknown): void {
    (this.data.installations ??= {})[key] = install;
    this.save();
  }

  deleteInstallation(key: string): boolean {
    if (!this.data.installations?.[key]) return false;
    delete this.data.installations[key];
    this.save();
    return true;
  }

  allInstallations(): Record<string, unknown> {
    return { ...(this.data.installations ?? {}) };
  }

  // The user who installed the app in this workspace (from the OAuth installation
  // record) — seeds a client team's access allowlist/admins (access.ts).
  installerOf(key: string): string | undefined {
    const inst = this.data.installations?.[key] as { user?: { id?: string } } | undefined;
    return inst?.user?.id;
  }

  // ── per-workspace actor access (who may drive the agent — access.ts) ──────
  // Keyed by the RAW tenant id (T…/E…, including the home team's own id). Absent record
  // = the defaults in access.ts (home open, client teams allowlisted to the installer).
  getTeamAccess(tenantId: string): TeamAccess | undefined {
    return this.data.teamAccess?.[tenantId];
  }

  setTeamAccess(tenantId: string, access: TeamAccess): void {
    (this.data.teamAccess ??= {})[tenantId] = access;
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

  // A key set to `undefined` is deleted (as in patchChat) — the delivery guard clears the
  // previous run's outcome fields at every fire.
  patchRoutine(id: string, patch: Partial<RoutineRecord>): RoutineRecord | undefined {
    const cur = this.data.routines?.[id];
    if (!cur) return undefined;
    const next = { ...cur, ...patch, id };
    for (const k of Object.keys(patch) as (keyof RoutineRecord)[]) {
      if (patch[k] === undefined) delete next[k];
    }
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

  // ── per-tenant export / purge (offboarding hooks; slice 2) ───────────────
  // Both operate on the explicit teamId field (undefined = home). For a project SHARED
  // across tenants this is deliberately records-only: purging tenant X removes X's
  // conversations/routines/watches, never the other tenant's records on the same slug.

  // A JSON-serializable snapshot of everything a tenant owns — "give the client their data".
  exportTenant(tenantId: string | undefined): {
    chats: ChatRecord[];
    routines: RoutineRecord[];
    prWatches: PrWatch[];
    investigations: Record<string, TicketInvestigation>;
    installation?: unknown;
    tasks: { out: OutTask[]; in: InTask[] };
    held: HeldMessage[];
    marks: Record<string, Marks>;
  } {
    const mine = <T extends { teamId?: string }>(rs: T[]) => rs.filter((r) => r.teamId === tenantId);
    return {
      tasks: { out: mine(Object.values(this.data.messaging?.out ?? {})), in: mine(Object.values(this.data.messaging?.in ?? {})) },
      held: mine(Object.values(this.data.messaging?.held ?? {})),
      marks: Object.fromEntries(Object.entries(this.data.messaging?.marks ?? {}).filter(([k]) => splitTeam(k).tenantId === tenantId)),
      chats: mine(Object.values(this.data.chats ?? {})),
      routines: mine(Object.values(this.data.routines ?? {})),
      prWatches: mine(Object.values(this.data.prWatches ?? {})),
      investigations: Object.fromEntries(
        Object.entries(this.data.youtrackInvestigations ?? {}).filter(([, r]) => r.teamId === tenantId),
      ),
      installation: tenantId ? this.data.installations?.[tenantId] : undefined,
    };
  }

  // Remove every record a tenant owns, INCLUDING its installation (tokens). State.json
  // only — sandboxes, drafts/<slug>, queue.jsonl entries and usage logs are the caller's
  // TODO (documented in docs/multitenancy.md offboarding notes). Returns counts by class.
  purgeTenant(tenantId: string): Record<string, number> {
    const counts: Record<string, number> = { chats: 0, routines: 0, prWatches: 0, investigations: 0, installations: 0 };
    const m = this.data.messaging; // counted only where messaging was ever used
    if (m) {
      Object.assign(counts, { tasks: 0, held: 0, marks: 0 });
      for (const map of [m.out, m.in] as (Record<string, { teamId?: string }> | undefined)[]) {
        for (const [k, r] of Object.entries(map ?? {})) if (r.teamId === tenantId) { delete map![k]; counts.tasks!++; }
      }
      for (const [k, r] of Object.entries(m.held ?? {})) if (r.teamId === tenantId) { delete m.held![k]; counts.held!++; }
      for (const k of Object.keys(m.marks ?? {})) if (splitTeam(k).tenantId === tenantId) { delete m.marks![k]; counts.marks!++; }
    }
    for (const [k, r] of Object.entries(this.data.chats ?? {})) {
      if (r.teamId === tenantId) { delete this.data.chats![k]; counts.chats++; }
    }
    for (const [k, r] of Object.entries(this.data.routines ?? {})) {
      if (r.teamId === tenantId) { delete this.data.routines![k]; counts.routines++; }
    }
    for (const [k, r] of Object.entries(this.data.prWatches ?? {})) {
      if (r.teamId === tenantId) { delete this.data.prWatches![k]; counts.prWatches++; }
    }
    for (const [k, r] of Object.entries(this.data.youtrackInvestigations ?? {})) {
      if (r.teamId === tenantId) { delete this.data.youtrackInvestigations![k]; counts.investigations++; }
    }
    if (this.data.installations?.[tenantId]) { delete this.data.installations[tenantId]; counts.installations++; }
    this.save();
    return counts;
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
        // A conversation's marks end with its record (agent-messaging D14): never by age alone.
        if (this.data.messaging?.marks) delete this.data.messaging.marks[key];
        dropped++;
      }
    }
    if (dropped) this.save();
    return dropped;
  }

  // ── agent messaging (OpenSpec agent-messaging; shapes and rules in messaging/records.ts) ──────
  // Reads never create the block: an installation that never used messaging keeps a state.json
  // without it. Task, held and mark records are stamped with the tenant of their conversation key,
  // like chats, so export/purge stay a filter.
  private msg(): MessagingState {
    return (this.data.messaging ??= {});
  }
  private stamped<T extends { key: string; teamId?: string; surface?: string }>(rec: T): T {
    const parts = splitTeam(rec.key);
    const next = { ...rec, teamId: parts.tenantId, surface: parts.surface };
    if (!next.teamId) delete next.teamId;
    if (!next.surface) delete next.surface;
    return next;
  }
  private static patched<T extends object>(cur: T, patch: Partial<T>): T {
    const next = { ...cur, ...patch };
    for (const k of Object.keys(patch) as (keyof T)[]) if (patch[k] === undefined) delete next[k];
    return next;
  }

  getOutTask(id: string): OutTask | undefined {
    return this.data.messaging?.out?.[id];
  }
  putOutTask(rec: OutTask): OutTask {
    const next = this.stamped(rec);
    (this.msg().out ??= {})[rec.id] = next;
    this.save();
    return next;
  }
  /** Merge into a task (a key set to undefined is deleted). `updatedAt` moves only when the patch sets it: it means the last message. */
  patchOutTask(id: string, patch: Partial<Omit<OutTask, 'id' | 'key' | 'teamId'>>): OutTask | undefined {
    const cur = this.data.messaging?.out?.[id];
    if (!cur) return undefined;
    const next = Store.patched<OutTask>(cur, patch);
    this.msg().out![id] = next;
    this.save();
    return next;
  }

  getInTask(origin: string, id: string): InTask | undefined {
    return this.data.messaging?.in?.[inTaskKey(origin, id)];
  }
  putInTask(rec: InTask): InTask {
    const next = this.stamped(rec);
    (this.msg().in ??= {})[inTaskKey(rec.origin, rec.id)] = next;
    this.save();
    return next;
  }
  patchInTask(origin: string, id: string, patch: Partial<Omit<InTask, 'id' | 'origin' | 'key' | 'teamId'>>): InTask | undefined {
    const k = inTaskKey(origin, id);
    const cur = this.data.messaging?.in?.[k];
    if (!cur) return undefined;
    const next = Store.patched<InTask>(cur, patch);
    this.msg().in![k] = next;
    this.save();
    return next;
  }

  /** Every task record, both directions (a task inside one installation appears in both lists). */
  messagingTasks(): { out: OutTask[]; in: InTask[] } {
    return { out: Object.values(this.data.messaging?.out ?? {}), in: Object.values(this.data.messaging?.in ?? {}) };
  }

  /** Open tasks with no message for longer than `idleMs`: they end `failed: expired` on this side (D8, D10). */
  idleOpenTasks(idleMs: number, now = Date.now()): { out: OutTask[]; in: InTask[] } {
    const idle = (t: { state: OutTask['state']; updatedAt: string }) => isOpen(t) && now - Date.parse(t.updatedAt) > idleMs;
    const { out, in: inc } = this.messagingTasks();
    return { out: out.filter(idle), in: inc.filter(idle) };
  }

  /** A conversation's marks (D14); a copy, empty when it has none. */
  getMarks(key: string): Marks {
    const m = this.data.messaging?.marks?.[key];
    return m ? Object.fromEntries(Object.entries(m).map(([d, h]) => [d, [...h]])) : {};
  }
  setMarks(key: string, marks: Marks): void {
    const empty = !Object.keys(marks).length;
    if (empty && !this.data.messaging?.marks?.[key]) return;
    const all = (this.msg().marks ??= {});
    if (empty) delete all[key];
    else all[key] = marks;
    this.save();
  }

  /** The domain a peer agent's card or messages named (D14), when learned. */
  peerDomain(agent: string): string | undefined {
    return this.data.messaging?.domains?.[agent];
  }
  learnDomain(agent: string, domain: string): void {
    if (this.data.messaging?.domains?.[agent] === domain) return;
    (this.msg().domains ??= {})[agent] = domain;
    this.save();
  }

  getHeld(id: string): HeldMessage | undefined {
    return this.data.messaging?.held?.[id];
  }
  putHeld(rec: HeldMessage): HeldMessage {
    const next = this.stamped(rec);
    (this.msg().held ??= {})[rec.id] = next;
    this.save();
    return next;
  }
  patchHeld(id: string, patch: Partial<Pick<HeldMessage, 'card'>>): HeldMessage | undefined {
    const cur = this.data.messaging?.held?.[id];
    if (!cur) return undefined;
    const next = Store.patched<HeldMessage>(cur, patch);
    this.msg().held![id] = next;
    this.save();
    return next;
  }
  deleteHeld(id: string): boolean {
    if (!this.data.messaging?.held?.[id]) return false;
    delete this.data.messaging.held[id];
    this.save();
    return true;
  }
  listHeld(): HeldMessage[] {
    return Object.values(this.data.messaging?.held ?? {});
  }

  /** Messages on their way into a conversation (D11): recorded before the transport is acked. */
  putDelivery(rec: DeliveryRecord): DeliveryRecord {
    const next = this.stamped(rec);
    (this.msg().deliveries ??= {})[rec.uuid] = next;
    this.save();
    return next;
  }
  patchDelivery(uuid: string, patch: Partial<Pick<DeliveryRecord, 'injected' | 'at'>>): void {
    const cur = this.data.messaging?.deliveries?.[uuid];
    if (!cur) return;
    this.msg().deliveries![uuid] = Store.patched<DeliveryRecord>(cur, patch);
    this.save();
  }
  deleteDelivery(uuid: string): void {
    if (!this.data.messaging?.deliveries?.[uuid]) return;
    delete this.data.messaging.deliveries[uuid];
    this.save();
  }
  listDeliveries(): DeliveryRecord[] {
    return Object.values(this.data.messaging?.deliveries ?? {});
  }

  /** Daily caps (messaging/records.ts sendCountKey / acceptCountKey). */
  askCount(key: string): number {
    return this.data.messaging?.counts?.[key] ?? 0;
  }
  /** Count one more; counters of days before `oldestDay` (YYYY-MM-DD) are dropped on the way. */
  bumpAskCount(key: string, oldestDay: string): number {
    const counts = (this.msg().counts ??= {});
    const n = (counts[key] ?? 0) + 1;
    counts[key] = n;
    for (const k of Object.keys(counts)) if (countKeyDay(k) < oldestDay) delete counts[k];
    this.save();
    return n;
  }

  /** A transport's durable records (messaging/transport.ts RecordStore), kept in state.json. */
  messagingRecords(which: 'local' | 'hub'): RecordStore {
    return {
      load: (): OutboxRecord[] => [...(this.data.messaging?.outbox?.[which] ?? [])],
      save: (records: OutboxRecord[]): void => {
        if (!records.length && !this.data.messaging?.outbox?.[which]) return;
        (this.msg().outbox ??= {})[which] = [...records];
        this.save();
      },
    };
  }

  /**
   * Housekeeping (D17): drop ended tasks whose last message is older than `maxAgeMs` (30 days), and held
   * messages that old. Open tasks are never pruned here — they end by expiry first (idleOpenTasks).
   */
  pruneMessaging(maxAgeMs: number, now = Date.now()): number {
    const m = this.data.messaging;
    if (!m) return 0;
    let dropped = 0;
    const old = (iso: string) => now - Date.parse(iso) > maxAgeMs;
    for (const map of [m.out, m.in] as (Record<string, OutTask | InTask> | undefined)[]) {
      for (const [k, t] of Object.entries(map ?? {})) {
        if (!isOpen(t) && old(t.updatedAt)) {
          delete map![k];
          dropped++;
        }
      }
    }
    for (const [k, h] of Object.entries(m.held ?? {})) {
      if (old(h.createdAt)) {
        delete m.held![k];
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
