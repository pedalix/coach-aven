// The bot's background work: the routine scheduler (reports + dreams), the auto-review
// and autofix PR pollers, the YouTrack investigation poller and the sources poller (per-project
// mail/chat/calendar pulls, docs/sources.md) — plus the fire*
// helpers they share with the /aven command router (run a routine/review on demand).
// Socket Mode has no webhooks, so GitHub/YouTrack state is polled.

import { mkdirSync, watch } from 'node:fs';
import { consumeRunRequests, controlDir } from './control.js';
import type { Config } from './config.js';
import type { Store, RoutineRecord } from './state.js';
import { resolveBySlug, projectOwnerTeam, teamProjects, type ProjectConfig, type RegistryRef } from './projects.js';
import { withTeam, normalizeTenant } from './teamkeys.js';
import type { TurnEngine } from './turn.js';
import type { ChatDriver, DriverForTenant } from './chat/driver.js';
import type { Channels } from './channels.js';
import {
  routineGuard,
  plannedFires,
  routinePrompt,
  emptySkipDecision,
  fireLabel,
  fireNote,
  firePatch,
  localDate,
  skipPatch,
  type SourceFreshness,
  settlePatch,
  MANUAL_FIRE,
  type Fire,
  type RoutineOutcome,
  type SettleInfo,
} from './routineguard.js';
import { prsToReview, autofixEvents } from './pr.js';
import { reviewPrompt, routineFraming, investigationPrompt, type ReviewEffort } from './prompts.js';
import {
  listTaggedIssues,
  listComments,
  listAttachments,
  dueTickets,
  headerExtras,
  tagApplier,
  taggerMatches,
  applierName,
  type YouTrackIssue,
} from './youtrack.js';
import { listOpenPRs, getPrMeta, ciStatusForSha, listReviews } from './github.js';
import { createDriver } from './driver.js';
import { projectCwd, reapWorktrees, repoCheckout } from './project.js';
import { housekeepingScript, parseHousekeepingReport, pruneThreshold } from './housekeeping.js';
import { cliUpgradeNotice, cliPinDrift, fetchCliDistTags } from './cliversion.js';
import { dreamPrompt, dreamDigest } from './dream.js';
import { snapshotMemory } from './memjournal.js';
import { routineLabel, startRoutineTurn } from './routinerun.js';
import { shortRepo, alertOps } from './chat/slack/blocks.js';
import { log } from './log.js';
import { captureError } from './sentry.js';
import path from 'node:path';
import { FactStore } from './facts.js';
import { authCheck, configuredKinds, pullProject } from './sources/run.js';
import { authCheckDue, createSourcesTicker, type SourcesSyncState } from './sources/sync.js';
import { sourcesViews } from './sources/daemonclient.js';
import { acquireLock, describeLock } from './sources/lock.js';
import { replicaDir } from './sources/paths.js';

// Timezone the cron schedules are evaluated in. Set AVEN_TZ (IANA, e.g. Europe/Zurich)
// in the runtime .env for local times; defaults to UTC.
export const ROUTINE_TZ = process.env.AVEN_TZ || 'UTC';

// The bot's GitHub login (PRs it opens), so auto-review skips its own PRs. Matches the
// committer identity seeded in project.ts. NOTE: keep in sync if the App's bot changes.
const BOT_LOGIN = 'coach-aven[bot]';
// How often the PR pollers check (Socket Mode → poll, no webhooks).
const AUTO_REVIEW_POLL_MS = 180_000; // 3 min
const AUTOFIX_POLL_MS = 120_000; // 2 min
const YOUTRACK_POLL_MS = 120_000; // 2 min — support-ticket investigation pilot
const CLI_PIN_POLL_MS = 24 * 3_600_000; // daily — is the Claude Code pin behind npm stable?
const SOURCES_POLL_MS = 60_000; // 1 min tick; each project's own interval/backoff decides (sources/sync.ts)
/** SOURCES_DAEMON=1: a sources daemon on this host ingests every project; the bot pulls and builds none (OpenSpec sources-daemon). */
const sourcesDaemonOn = process.env.SOURCES_DAEMON === '1';

export interface Pollers {
  startAll(): void;
  // `fire` says why this fire happens (scheduled/late/retry — the scheduler's business); the
  // command and CLI paths leave it out and get a manual run.
  fireRoutine(chat: ChatDriver, r: RoutineRecord, fire?: Fire): boolean;
  fireReview(
    chat: ChatDriver,
    project: ProjectConfig,
    repo: string,
    number: number,
    channel: string,
    effort?: ReviewEffort,
    tenant?: string,
  ): boolean;
}

// Pollers are per-tenant since slice 2: every stored record (routine, watch, settings,
// investigation) carries its owning tenant, and each fire resolves THAT tenant's chat
// driver via `driverFor` — a tenant with no live installation is logged and skipped,
// never silently posted to with the home credentials. `home()` late-binds the home tenant id
// (needed for the owner-team rule on shared projects).
export function createPollers(
  cfg: Config,
  store: Store,
  reg: RegistryRef,
  driverFor: DriverForTenant,
  engine: TurnEngine,
  channels: Channels,
  home: () => string | undefined,
): Pollers {
  // Resolve a tenant's driver, or undefined with a log line (the per-record skip rule).
  const driverOrSkip = (tenantId: string | undefined, what: string): ChatDriver | undefined => {
    try {
      return driverFor(tenantId);
    } catch (e) {
      log.warn(`${what}: ${e instanceof Error ? e.message : String(e)} — skipped`);
      return undefined;
    }
  };

  // Does the record's tenant STILL have this project? Removing a tenant from the
  // workspaces block must stop its scheduled work too (an installation outlives a
  // revocation) — a live token alone is not authorization.
  const tenantHasProject = (tenantId: string | undefined, slug: string): boolean =>
    teamProjects(reg.current, tenantId ?? home(), home()).some((p) => p.slug === slug);
  // An error that escapes a poller tick is unexpected (the GitHub helpers degrade quietly on
  // their own), so it means a real bug or a systemic outage — log it AND raise a Sentry issue
  // rather than swallowing it. Used for both the first tick and every interval tick so a broken
  // poller never fails silently.
  const pollFail = (poller: string) => (e: unknown) => {
    log.error(`${poller} poll: ${e instanceof Error ? e.message : String(e)}`);
    captureError(e, { subsystem: 'poller', poller });
  };

  // A rejected fire-and-forget liveTurn (a turn that failed OUTSIDE doTurn's own try/catch —
  // rare, since doTurn renders its errors via errText) should raise a Sentry issue, not just
  // log. Mirrors pollFail; `context` identifies the turn (routine id, PR, ticket).
  const turnFail = (context: string) => (e: unknown) => {
    log.error(`${context}: ${e instanceof Error ? e.message : String(e)}`);
    captureError(e, { subsystem: 'turn', context });
  };

  // Scheduled report jobs: dedupe a routine to one fire per matched wall-clock minute
  // (overlapping ticks / a quick restart shouldn't double-post). Maps routine id → the
  // "month-day hh:mm" it last fired on.
  const firedThisMinute = new Map<string, string>();

  // Fire one routine now. A report posts a read-only digest turn (a task: a turn that may
  // commit, per the project's instructions) via the normal turn
  // machinery; a dream runs a silent memory-only pass (see fireDream). Shared by the
  // scheduler and the manual run triggers. Returns false if it can't run right now — every
  // skip is logged with its reason (the "no driver" one by driverOrSkip at the call sites).
  //
  // Routine delivery guard (ROUTINE_GUARD=1, routineguard.ts): the prompt gets the bot-rendered
  // "previous run" line, a late run / retry is labelled as such, and the run's outcome lands on
  // the routine record when the turn settles — an error rewrites the parent (routinerun.ts) and
  // may schedule the one retry the scheduler fires later. With the guard off, prompt, label,
  // stamp and engine call are the historical ones.
  const routinesInFlight = new Set<string>();
  function fireRoutine(c: ChatDriver, r: RoutineRecord, fire: Fire = MANUAL_FIRE): boolean {
    const project = resolveBySlug(reg.current, r.slug);
    if (!project) {
      log.warn(`routine ${r.id}: project ${r.slug} is no longer in the registry — skipped`);
      return false;
    }
    if (!tenantHasProject(r.teamId, r.slug)) {
      log.warn(`routine ${r.id}: tenant ${r.teamId ?? 'home'} no longer has ${r.slug} — skipped`);
      return false;
    }
    if (r.kind === 'dream') return fireDream(project, r);
    if (r.kind === 'housekeeping') return fireHousekeeping(project, r);
    const legacyKey = withTeam(r.teamId, home(), `cron:${r.id}:${r.slug}`);
    if (routinesInFlight.has(r.id)) {
      log.info(`routine ${r.id} (${r.slug}): skipped — the previous run is still in flight`);
      return false; // don't stack
    }
    routinesInFlight.add(r.id);
    const now = new Date();
    const base = routineLabel(r.kind, r.prompt);
    // Empty-slot skip (ROUTINE_SKIP_EMPTY=1, routineguard.ts): nothing new in the sources since
    // the last delivered run and nothing due in the tenant ledgers → one line, no turn, no cost.
    // Every input is read here, deterministically; the decision itself is pure and tested.
    if (routineGuard.skipEmpty && fire.mode !== 'manual' && project.sources) {
      // Local files, or the project's sources daemon's last status (sources/daemonclient.ts) — an
      // unreachable daemon reads as "unreadable", so the slot fires.
      const view = sourcesViews.view(project, localDate(r.tz, now));
      const decision = emptySkipDecision(
        {
          fire,
          routine: r,
          hasSources: true,
          ...(view.rawRecords !== undefined ? { rawCount: view.rawRecords } : {}),
          ...(view.due ? { due: view.due } : {}),
          sources: sourceFreshness(view.sync, project, now),
          intervalMinutes: project.sources.intervalMinutes ?? 15,
        },
        routineGuard,
        now,
        r.tz,
      );
      if (decision.skip) {
        store.patchRoutine(r.id, skipPatch(now, fire));
        log.info(`routine ${r.id} (${r.slug}): skipped-empty — ${decision.message}`);
        c.post({ conv: r.channel }, { kind: 'text', text: `${base} — ${decision.message}` })
          .catch((e: unknown) => log.warn(`routine ${r.id} (${r.slug}): skip line not posted: ${e instanceof Error ? e.message : String(e)}`))
          .finally(() => routinesInFlight.delete(r.id));
        return true;
      }
      log.info(`routine ${r.id} (${r.slug}): not skipped — ${decision.reason}`);
    }
    // Derived from the record BEFORE the fire stamp below clears the previous run's fields.
    const prompt = routinePrompt(routineFraming(r.kind), r, fire, routineGuard, now);
    const label = fireLabel(base, fire, r.tz, now);
    store.patchRoutine(r.id, firePatch(now, fire, routineGuard));
    log.info(`routine ${r.id} (${r.slug}): fired — ${fireNote(fire, r.tz, now)}`);
    // Settle recorder (guard only). Idempotent: the engine calls it once, but the catch below
    // may also reach it for a run that died before the engine took over (parent post failed).
    let settled = false;
    const onSettle = routineGuard.enabled
      ? async (outcome: RoutineOutcome, info: SettleInfo): Promise<void> => {
          if (settled) return;
          settled = true;
          const { patch, note } = settlePatch(fire, outcome, info, new Date(), routineGuard);
          // The delivered run's fingerprint for the empty-slot skip: the replica's raw-record count now.
          if (outcome === 'ok' && routineGuard.skipEmpty && project.sources) {
            const raw = sourcesViews.view(project, localDate(r.tz, new Date())).rawRecords;
            if (raw !== undefined) patch.lastDeliveredRawCount = raw;
          }
          store.patchRoutine(r.id, patch);
          log.info(`routine ${r.id} (${r.slug}): ${note}`);
        }
      : undefined;
    // One top-level parent per run, the turn in its thread under thread:<ts> — replies there
    // continue the same (fresh-per-run) session. See routinerun.ts.
    void startRoutineTurn(
      {
        restartSession: engine.restartSession,
        liveTurn: (k, threadTs, p, prompt, onAnswer, onTurnSettle) =>
          engine.liveTurn(c, r.channel, undefined, threadTs, k, p, prompt, undefined, {
            onAnswer,
            routine: { id: r.id, label: base },
            ...(onTurnSettle ? { onSettle: onTurnSettle } : {}),
          }),
      },
      {
        postParent: async (text) => (await c.post({ conv: r.channel }, { kind: 'text', text })).id,
        updateParent: async (ts, text) => {
          await c.update({ conv: r.channel, id: ts }, { kind: 'line', text });
        },
      },
      { legacyKey, threadKey: (ts) => withTeam(r.teamId, home(), `thread:${ts}`), label },
      project,
      prompt,
      onSettle ? { onSettle } : undefined,
    )
      .catch(async (e: unknown) => {
        turnFail(`routine ${r.id}`)(e);
        if (onSettle) await onSettle('error', { reason: e instanceof Error ? e.message.split('\n')[0]!.slice(0, 200) : String(e) });
      })
      .finally(() => routinesInFlight.delete(r.id));
    return true;
  }

  // Per configured source kind: did its last pass succeed and how old is it (the sync state: local facts or the daemon's).
  function sourceFreshness(state: SourcesSyncState, project: ProjectConfig, now: Date): SourceFreshness[] {
    return configuredKinds(project).map((kind) => {
      const s = state.lastSummary[kind];
      const at = s ? Date.parse(s.finishedAt) : NaN;
      return { kind, ok: s?.ok ?? false, ...(Number.isFinite(at) ? { ageMinutes: (now.getTime() - at) / 60_000 } : {}) };
    });
  }

  // A dream runs silently (no channel post): consolidate the project's auto memory, then log
  // a one-line digest and stash it on the routine for visibility. Skipped while the project
  // has a live turn so the two don't race on memory files. Source of truth = the sandbox
  // (warm, survives stop/start); durability of the consolidated copy is future work.
  function fireDream(project: ProjectConfig, r: RoutineRecord): boolean {
    if (engine.projectBusy(project.slug)) return false; // don't dream over a live user turn
    const key = withTeam(r.teamId, home(), `cron:${r.id}:${r.slug}`); // tenant-keyed → correct usage attribution
    store.patchRoutine(r.id, { lastRunAt: new Date().toISOString() });
    void (async () => {
      try {
        const digest = dreamDigest(
          await engine.runAsk(key, project, dreamPrompt(projectCwd(cfg, project.slug, project.repos))),
        );
        store.patchRoutine(r.id, { lastSummary: digest });
        log.info(`dream ${r.id} (${project.slug}): ${digest}`);
        // Journal the consolidated memory (the sandbox is awake from the dream just now).
        const sandbox = await createDriver(cfg, project.driver).getSandbox(`${cfg.sandbox.namePrefix}${project.slug}`);
        if (!sandbox) throw new Error('sandbox not found after dream');
        await snapshotMemory(sandbox, cfg, project.slug, project.repos, digest);
      } catch (e) {
        log.error(`dream ${r.id}: ${e instanceof Error ? e.message : String(e)}`);
      }
    })();
    return true;
  }

  // Housekeeping: the deterministic sandbox janitor (docs/housekeeping.md) — dockerd
  // guard, threshold-gated docker prune, proactive worktree reap. No LLM, silent (log +
  // the routine's lastSummary, like dreams). Skipped while the project has a live turn
  // (never reap state out from under one) and when the sandbox is asleep — a stopped
  // sandbox accumulates no new garbage, and waking the fleet nightly defeats auto-stop.
  function fireHousekeeping(project: ProjectConfig, r: RoutineRecord): boolean {
    if (engine.projectBusy(project.slug)) return false;
    store.patchRoutine(r.id, { lastRunAt: new Date().toISOString() });
    void (async () => {
      try {
        const sandbox = await createDriver(cfg, project.driver).getSandbox(`${cfg.sandbox.namePrefix}${project.slug}`);
        if (!sandbox || !sandbox.started) {
          store.patchRoutine(r.id, { lastSummary: 'sandbox asleep — skipped' });
          return;
        }
        let reaped = 0;
        for (const repo of project.repos) {
          reaped += await reapWorktrees(sandbox, repoCheckout(cfg, project.slug, repo));
        }
        const pin = project.cliVersion ?? cfg.claudeCliVersion;
        const res = await sandbox.exec(housekeepingScript(pruneThreshold(), pin, project.sandbox?.dind !== false), {
          timeout: 900,
        });
        const report = parseHousekeepingReport(res.result ?? '', reaped);
        store.patchRoutine(r.id, { lastSummary: report.digest });
        log.info(`housekeeping ${r.id} (${project.slug}): ${report.digest}`);
        // A CLI upgrade (or its failure) is fleet news, not just a digest line.
        const notice = cliUpgradeNotice(report.cli, `${cfg.sandbox.namePrefix}${project.slug}`);
        if (notice) alertOps(notice.text, notice.level);
        if (notice?.level === 'warning') captureError(new Error(notice.text), { subsystem: 'cli-upgrade', slug: project.slug });
      } catch (e) {
        log.error(`housekeeping ${r.id}: ${e instanceof Error ? e.message : String(e)}`);
      }
    })();
    return true;
  }

  // Fire a PR review (on-demand or auto): a read-only review turn keyed per PR (standing →
  // re-review keeps context). Returns false if a review for this PR is already in flight.
  function fireReview(
    c: ChatDriver,
    project: ProjectConfig,
    repo: string,
    number: number,
    channel: string,
    effort: ReviewEffort = 'med',
    tenant?: string,
  ): boolean {
    const key = withTeam(tenant, home(), `review:${repo}:${number}:${project.slug}`);
    if (engine.hasKey(key)) return false;
    // automatic: a poller's turn — an agent-messaging answer never folds into it (D11).
    void engine.liveTurn(c, channel, undefined, undefined, key, project, reviewPrompt(repo, number, effort), undefined, { automatic: true }).catch(
      turnFail(`review ${repo}#${number}`),
    );
    return true;
  }

  // Scheduler: every 60s, fire any routine due this wall-clock minute (see dueRoutines).
  // Routines live in state.json, so they need no separate restart recovery.
  // Operator-requested runs (`orch routines run <id>` writes data/control/run-<id>.json):
  // fs.watch for promptness, a 5 s poll because watch events are lossy on some filesystems
  // (WSL, network mounts). Claiming is atomic in control.ts, so the two never double-fire.
  function startControlWatcher(): void {
    const dir = controlDir();
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const drain = (): void => {
      try {
        consumeRunRequests(dir, (id) => {
          const r = store.getRoutine(id);
          if (!r) {
            log.warn(`control: run requested for unknown routine ${id} — ignored`);
            return;
          }
          const c = driverOrSkip(r.teamId, `routine ${r.id}`);
          const ok = c ? fireRoutine(c, r) : false;
          log.info(`control: routine ${id} run requested from the CLI → ${ok ? 'fired' : 'not fired (busy, disabled tenant or no client)'}`);
        });
      } catch (e) {
        pollFail('control')(e);
      }
    };
    try {
      watch(dir, () => drain());
    } catch (e) {
      log.warn(`control: fs.watch unavailable (${e instanceof Error ? e.message : String(e)}) — polling only`);
    }
    drain();
    setInterval(drain, 5_000);
  }

  // The tick's decision is plannedFires (routineguard.ts): with ROUTINE_GUARD off exactly the
  // current-minute dueRoutines; with it on also the missed slots inside the grace window (as
  // late runs — the first tick at boot is what catches a slot the bot slept through) and the
  // due retries, plus the skips to log (and stale retry records to drop).
  function startScheduler(): void {
    const tick = (): void => {
      const { fires, skips } = plannedFires(store.listRoutines(), new Date(), firedThisMinute, routineGuard);
      for (const sk of skips) {
        log.info(`routine ${sk.routine.id} (${sk.routine.slug}): skipped — ${sk.reason}`);
        if (sk.clearRetry) store.patchRoutine(sk.routine.id, { retry: undefined });
      }
      for (const f of fires) {
        if (f.key) firedThisMinute.set(f.routine.id, f.key);
        const c = driverOrSkip(f.routine.teamId, `routine ${f.routine.id}`);
        if (c) fireRoutine(c, f.routine, f);
      }
    };
    tick();
    setInterval(tick, 60_000);
  }

  // Auto-review poller: every few minutes, review new non-bot PRs in projects with
  // auto-review enabled (see prsToReview). Posts to the channel auto-review was enabled in.
  // The `since` cursor + reviewedPrs dedup live in state.json, so a restart neither
  // re-reviews the backlog nor floods.
  function startAutoReviewPoller(): void {
    const tick = async (): Promise<void> => {
      for (const project of reg.current.projects) {
        const s = store.getProjectSettings(project.slug);
        if (!s.autoReview || !s.autoReviewChannel) continue;
        // Settings are slug-keyed (one auto-review per project fleet-wide) — the enabling
        // tenant's token posts. Old records carry no team → home. A dead installation
        // skips the project rather than leaking home-token posts into a foreign channel.
        const c = driverOrSkip(s.autoReviewTeam, `auto-review ${project.slug}`);
        if (!c) continue;
        const reviewed = store.reviewedPrKeys();
        for (const repo of project.repos) {
          const prs = await listOpenPRs(cfg, repo);
          const due = prsToReview(
            prs.map((p) => ({ repo, number: p.number, author: p.author, createdAt: p.createdAt, draft: p.draft })),
            { since: s.autoReviewSince, botLogin: BOT_LOGIN, reviewed },
          );
          for (const p of due) {
            const k = `${repo}#${p.number}`;
            store.markPrReviewed(k);
            reviewed.add(k);
            if (fireReview(c, project, repo, p.number, s.autoReviewChannel, s.autoReviewEffort ?? 'med', s.autoReviewTeam))
              log.info(`auto-review ${k} (${project.slug})`);
          }
        }
      }
    };
    void tick().catch(pollFail('auto-review'));
    setInterval(() => void tick().catch(pollFail('auto-review')), AUTO_REVIEW_POLL_MS);
  }

  // Autofix watcher: every couple of minutes, check each subscribed PR's CI + reviews and
  // post a notification (with a "Fix" button) when something changed (see autofixEvents).
  // A merged/closed PR auto-unsubscribes. Tier 1: notify + one-click fix, never auto-push.
  function startAutofixPoller(): void {
    const tick = async (): Promise<void> => {
      for (const w of store.listPrWatches()) {
        // The store key carries the tenant prefix (withTeam) — recompute it the same way
        // the subscribe path did, so patch/delete hit the right record.
        const key = withTeam(w.teamId, home(), `${w.repo}#${w.number}`);
        if (!tenantHasProject(w.teamId, w.slug)) continue; // revoked tenant — stay silent
        const c = driverOrSkip(w.teamId, `autofix ${w.repo}#${w.number}`);
        if (!c) continue;
        const meta = await getPrMeta(cfg, w.repo, w.number);
        if (!meta) continue; // transient read failure — try again next tick
        if (meta.state === 'closed') {
          store.deletePrWatch(key);
          await c
            .post({ conv: w.channel }, { kind: 'text', text: `:checkered_flag: ${shortRepo(w.repo)}#${w.number} ${meta.merged ? 'merged' : 'closed'} — stopped watching.` })
            .catch(() => {});
          continue;
        }
        const ci = await ciStatusForSha(cfg, w.repo, meta.headSha);
        const reviews = await listReviews(cfg, w.repo, w.number);
        const { notes, next } = autofixEvents(w, { sha: meta.headSha, conclusion: ci }, reviews, BOT_LOGIN);
        store.patchPrWatch(key, next);
        if (notes.length) {
          await c.post({ conv: w.channel }, { kind: 'autofixNotice', watch: w, notes }).catch(() => {});
        }
      }
    };
    void tick().catch(pollFail('autofix'));
    setInterval(() => void tick().catch(pollFail('autofix')), AUTOFIX_POLL_MS);
  }

  // Ticket ids with an investigation being fired right now. The durable dedup is the
  // state.json seen-set (marked by the poller on success), but that's marked only AFTER this
  // returns; this in-memory guard covers the gap so an overlapping poller tick (one running
  // longer than the interval) can't start a second investigation for the same ticket. Added
  // before the first await, cleared in finally.
  const investigating = new Set<string>();
  // Fire a support-ticket investigation (the YouTrack-label pilot). A read-only turn keyed
  // per ticket, posted as a thread under a compact header in the project's `aven-<slug>`
  // channel. Awaits channel resolution + the ticket's comments, then hands off to the normal
  // turn machinery. Returns false if it can't even start (channel unknown, or already
  // investigating) so the poller leaves the ticket unseen and retries next tick.
  async function fireInvestigation(project: ProjectConfig, ticket: YouTrackIssue): Promise<boolean> {
    if (investigating.has(ticket.id)) return false; // an overlapping tick is already firing this ticket
    investigating.add(ticket.id);
    try {
      // Owner-team dispatch: a shared project's investigations land in ONE workspace —
      // the first tenant listing the slug (projectOwnerTeam). teamId normalizes to
      // undefined for home (the store convention).
      const owner = projectOwnerTeam(reg.current, project.slug, home());
      const teamId = normalizeTenant(owner, home());
      const chat = driverOrSkip(teamId, `youtrack ${ticket.id}`);
      if (!chat) return false;
      const channel = await channels.channelIdForSlug(chat, project, teamId);
      if (!channel) {
        log.error(`youtrack ${ticket.id}: channel ${channels.prefixFor(teamId)}${project.slug} not found — create it and invite the bot`);
        return false;
      }
      const comments = await listComments(cfg, ticket.id);
      // Keep the comment dates (day precision) — the agent needs the chronology to tell a
      // stale workaround from the latest report.
      const commentsText = comments
        .map((c) => `[${c.author || 'unknown'}${c.createdAt ? `, ${c.createdAt.slice(0, 10)}` : ''}] ${c.text}`)
        .join('\n\n');
      // Ticket file attachments (screenshots/PDFs) — downloaded into the sandbox for the agent to
      // Read, using the same YouTrack token. [] on any failure; the investigation still proceeds.
      const attachRefs = await listAttachments(cfg, ticket.id);
      const attachments = attachRefs.length ? { refs: attachRefs, bearer: cfg.youtrack!.token } : undefined;
      const mentions = (cfg.youtrack?.ping ?? []).map((u) => `<@${u}>`).join(' ');
      // WHO flagged the ticket decides the answer's language: a support agent's flag means the
      // writeup gets relayed to the customer, so it stays in the ticket's language; a teammate
      // on YOUTRACK_ENGLISH_TAGGERS is reading it themselves, so it comes back in English.
      // Unknown tagger (activities unreadable / tag older than the stream) → ticket language.
      const applier = await tagApplier(cfg, ticket.id, cfg.youtrack!.label);
      const flaggedBy = applier ? applierName(applier) : undefined;
      const replyLanguage = taggerMatches(applier, cfg.youtrack?.englishTaggers ?? []) ? 'English' : undefined;
      const prompt = investigationPrompt({ ...ticket, comments: commentsText }, mentions, { flaggedBy, replyLanguage });
      // Post a compact header FIRST, then run the whole investigation as a reply under it, so
      // each ticket is one tidy line in the channel with the live status + findings collapsed in
      // its own thread (unlike the other pollers, which post top-level).
      const ticketUrl = `${cfg.youtrack!.baseUrl.replace(/\/$/, '')}/issue/${ticket.id}`;
      const extras = headerExtras(ticket, Date.now());
      let rootTs: string | undefined;
      try {
        const root = await chat.post({ conv: channel }, { kind: 'ticketHeader', ticket, url: ticketUrl, extras });
        rootTs = root.id;
      } catch (e) {
        log.error(`youtrack ${ticket.id}: header post failed: ${e instanceof Error ? e.message : String(e)}`);
      }
      // Ticket card as the thread's first reply — description, fields, links, files — so the
      // thread is self-contained. Best-effort: a card failure must not sink the investigation.
      if (rootTs) {
        try {
          await chat.post(
            { conv: channel, thread: rootTs },
            { kind: 'ticketCard', ticket, url: ticketUrl, attachmentNames: attachRefs.map((a) => a.name), flaggedBy },
          );
        } catch (e) {
          log.error(`youtrack ${ticket.id}: card post failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      // Key the turn like a normal channel thread (`thread:<rootTs>`) instead of a one-shot: that
      // single choice makes the thread CONTINUABLE — a later reply in it resumes THIS Claude
      // session (the bot "owns" the thread via store.getChat) — and gives the finished answer its
      // follow-up buttons (answerBlocks attaches them only for `thread:` keys). Falls
      // back to a ticket-scoped key + top-level post if the header couldn't be sent (no rootTs).
      const key = withTeam(teamId, home(), rootTs ? `thread:${rootTs}` : `youtrack:${ticket.id}:${project.slug}`);
      // Persist the investigation BEFORE dispatch so the ticket→thread link and the dedup
      // survive an immediate crash; stamp finishedAt when the turn settles. `rootTs` ties the
      // ticket to `thread:<rootTs>` → chats → the Claude session.
      store.recordInvestigation(ticket.id, { slug: project.slug, teamId, channel, rootTs, startedAt: new Date().toISOString() });
      void engine.liveTurn(chat, channel, undefined, rootTs, key, project, prompt, attachments, { automatic: true }) // a poller's turn (D11)
        .catch(turnFail(`youtrack ${ticket.id}`))
        .finally(() => store.finishInvestigation(ticket.id));
      return true;
    } finally {
      investigating.delete(ticket.id);
    }
  }

  // YouTrack poller: every couple of minutes, find tickets tagged with the trigger label,
  // route each to the project owning its id prefix (project.youtrackProjects), and start a
  // read-only investigation — once per ticket (seen-set in state.json survives restarts).
  // No-op unless the pilot is configured (cfg.youtrack). See youtrack.ts for the pure parts.
  function startYouTrackPoller(): void {
    if (!cfg.youtrack) return;
    const label = cfg.youtrack.label;
    const tick = async (): Promise<void> => {
      // Nothing to route to → don't even hit the API (the common pre-mapping state).
      const mapped = reg.current.projects.filter((p) => (p.youtrackProjects ?? []).length);
      if (!mapped.length) return;
      const issues = await listTaggedIssues(cfg, label);
      if (!issues.length) return;
      const seen = store.investigatedTicketIds();
      for (const project of mapped) {
        const prefixes = project.youtrackProjects ?? [];
        for (const t of dueTickets(issues, { seen, prefixes })) {
          if (await fireInvestigation(project, t)) {
            seen.add(t.id); // fireInvestigation persisted the record; keep this tick's set current
            log.info(`youtrack investigate ${t.id} (${project.slug})`);
          }
        }
      }
    };
    void tick().catch(pollFail('youtrack'));
    setInterval(() => void tick().catch(pollFail('youtrack')), YOUTRACK_POLL_MS);
  }

  // Daily: is the Claude Code PIN itself stale against npm's `stable` dist-tag (cliversion.ts)?
  // The sandboxes converge to the pin on their own; this is the nudge to move the pin. One
  // alert per distinct message — a stale pin nags once, not every morning.
  let lastPinDriftAlert: string | undefined;
  function startCliPinCheck(): void {
    const tick = async (): Promise<void> => {
      const tags = await fetchCliDistTags();
      const drift = cliPinDrift(cfg.claudeCliVersion, tags?.stable);
      if (!drift) lastPinDriftAlert = undefined;
      else if (drift !== lastPinDriftAlert) {
        lastPinDriftAlert = drift;
        alertOps(drift, 'warning');
      }
    };
    setTimeout(() => void tick().catch(pollFail('cli-pin')), 60_000);
    setInterval(() => void tick().catch(pollFail('cli-pin')), CLI_PIN_POLL_MS);
  }

  // Sources poller: every minute ask sync.ts which projects are due (per-project interval,
  // doubling backoff on failure, 2-hourly probes of kinds awaiting re-auth) and run
  // pull → store build → replica for them, one project at a time. State is the `sources_sync`
  // facts predicate, so a restart neither re-pulls early nor forgets a dead grant. Pulls never
  // touch the sandbox: they run on this host with tokens the sandbox must not see, and the
  // replica swap is an atomic rename, so an in-flight turn is unaffected (docs/sources.md).
  //
  // Not here (OpenSpec sources-daemon): a project with `sources.daemon` — its data lives with that
  // daemon — and every project when SOURCES_DAEMON=1 (a daemon on this host ingests). Before a pass
  // the bot takes the project's data lock, so a daemon started by mistake beside it refuses to run,
  // and a project a live daemon holds is skipped (logged once).
  const facts = new FactStore();
  const lockSkipLogged = new Set<string>();
  const ingestedHere = (p: ProjectConfig): boolean => !!p.sources && !p.sources.daemon && !sourcesDaemonOn;
  function startSourcesPoller(): void {
    const ticker = createSourcesTicker({
      projects: () =>
        reg.current.projects.filter((p) => {
          if (!ingestedHere(p)) return false;
          const holder = acquireLock(p.slug, 'bot');
          if (!holder) {
            lockSkipLogged.delete(p.slug);
            return true;
          }
          if (!lockSkipLogged.has(p.slug)) {
            lockSkipLogged.add(p.slug);
            log.warn(`[sources:${p.slug}] not pulling: the data is held by ${describeLock(holder)}`);
          }
          return false;
        }),
      facts,
      now: () => new Date(),
      alert: (text) => alertOps(text, 'warning'),
      log: (line) => log.info(line),
      pull: async (p, kinds) => (await pullProject(p, { only: kinds, build: true })).summaries,
    });
    // First pass after the bot has settled (channels resolved, recovery done), then every minute.
    setTimeout(() => void ticker.tick().catch(pollFail('sources')), 30_000);
    setInterval(() => void ticker.tick().catch(pollFail('sources')), SOURCES_POLL_MS);
  }

  // Daily 06:00 (AVEN_TZ): run each configured kind's `check` (the same action the operator
  // runs by hand) and alert once per failing kind with the checker's last lines. Catches a
  // revoked grant or a blocked refresh path before the 2-hourly probe trips over it.
  let lastAuthCheckDay: string | undefined;
  function startSourcesAuthCheck(): void {
    const tick = async (): Promise<void> => {
      const due = authCheckDue(new Date(), ROUTINE_TZ, lastAuthCheckDay);
      if (!due) return;
      lastAuthCheckDay = due;
      for (const p of reg.current.projects.filter(ingestedHere)) {
        for (const kind of configuredKinds(p)) {
          const r = await authCheck(p.slug, kind, p);
          if (r.code === 0) continue;
          const tail = r.lines.filter((l) => !l.startsWith('  ')).slice(-4).join('\n');
          alertOps(`sources auth check *${p.slug}/${kind}* failed (exit ${r.code}):\n${tail}`, 'warning');
        }
      }
    };
    setInterval(() => void tick().catch(pollFail('sources-auth')), SOURCES_POLL_MS);
  }

  // Projects whose sources live with a daemon: refresh its status every minute (the views read it
  // synchronously) and pass on what the operator should hear — its own alerts, silence, recovery.
  function startDaemonWatcher(): void {
    const tick = async (): Promise<void> => {
      for (const p of reg.current.projects) {
        if (!p.sources?.daemon) continue;
        for (const n of await sourcesViews.refresh(p)) alertOps(n.text, n.level);
      }
    };
    setTimeout(() => void tick().catch(pollFail('sources-daemon')), 5_000);
    setInterval(() => void tick().catch(pollFail('sources-daemon')), SOURCES_POLL_MS);
  }

  return {
    startAll: () => {
      startScheduler();
      startControlWatcher();
      startAutoReviewPoller();
      startAutofixPoller();
      startYouTrackPoller();
      startCliPinCheck();
      startSourcesPoller();
      startSourcesAuthCheck();
      startDaemonWatcher();
    },
    fireRoutine,
    fireReview,
  };
}
