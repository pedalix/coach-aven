// The bot's background work: the routine scheduler (reports + dreams), the auto-review
// and autofix PR pollers, and the YouTrack investigation poller — plus the fire*
// helpers they share with the /aven command router (run a routine/review on demand).
// Socket Mode has no webhooks, so GitHub/YouTrack state is polled.

import type bolt from '@slack/bolt';
import type { Config } from './config.js';
import type { Store, RoutineRecord } from './state.js';
import { resolveBySlug, type ProjectConfig, type RegistryRef } from './projects.js';
import type { TurnEngine } from './turn.js';
import type { Channels } from './channels.js';
import { dueRoutines } from './schedule.js';
import { prsToReview, autofixEvents } from './pr.js';
import { reviewPrompt, REPORT_FRAMING, investigationPrompt, type ReviewEffort } from './prompts.js';
import { listTaggedIssues, listComments, listAttachments, dueTickets, headerExtras, type YouTrackIssue } from './youtrack.js';
import { ticketCardBlocks } from './blocks.js';
import { listOpenPRs, getPrMeta, ciStatusForSha, listReviews } from './github.js';
import { createDriver } from './driver.js';
import { projectCwd, reapWorktrees, repoCheckout } from './project.js';
import { housekeepingScript, parseHousekeepingReport, pruneThreshold } from './housekeeping.js';
import { dreamPrompt, dreamDigest } from './dream.js';
import { snapshotMemory } from './memjournal.js';
import { autofixNotifyBlocks, shortRepo } from './blocks.js';
import { log } from './log.js';
import { captureError } from './sentry.js';

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

export interface Pollers {
  startAll(): void;
  fireRoutine(client: bolt.webApi.WebClient, r: RoutineRecord): boolean;
  fireReview(
    client: bolt.webApi.WebClient,
    project: ProjectConfig,
    repo: string,
    number: number,
    channel: string,
    effort?: ReviewEffort,
  ): boolean;
}

export function createPollers(
  cfg: Config,
  store: Store,
  reg: RegistryRef,
  client: bolt.webApi.WebClient,
  engine: TurnEngine,
  channels: Channels,
): Pollers {
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

  // Fire one routine now. A report posts a read-only digest turn via the normal turn
  // machinery; a dream runs a silent memory-only pass (see fireDream). Shared by the
  // scheduler and the manual run triggers. Returns false if it can't run right now.
  function fireRoutine(c: bolt.webApi.WebClient, r: RoutineRecord): boolean {
    const project = resolveBySlug(reg.current, r.slug);
    if (!project) return false; // project removed from the registry
    if (r.kind === 'dream') return fireDream(project, r);
    if (r.kind === 'housekeeping') return fireHousekeeping(project, r);
    const key = `cron:${r.id}:${r.slug}`;
    if (engine.hasKey(key)) return false; // previous run still in flight — don't stack
    store.patchRoutine(r.id, { lastRunAt: new Date().toISOString() });
    void engine.liveTurn(c, r.channel, undefined, undefined, key, project, REPORT_FRAMING + r.prompt).catch(
      turnFail(`routine ${r.id}`),
    );
    return true;
  }

  // A dream runs silently (no channel post): consolidate the project's auto memory, then log
  // a one-line digest and stash it on the routine for visibility. Skipped while the project
  // has a live turn so the two don't race on memory files. Source of truth = the sandbox
  // (warm, survives stop/start); durability of the consolidated copy is future work.
  function fireDream(project: ProjectConfig, r: RoutineRecord): boolean {
    if (engine.projectBusy(project.slug)) return false; // don't dream over a live user turn
    const key = `cron:${r.id}:${r.slug}`;
    store.patchRoutine(r.id, { lastRunAt: new Date().toISOString() });
    void (async () => {
      try {
        const digest = dreamDigest(
          await engine.runAsk(key, project, dreamPrompt(projectCwd(cfg, project.slug, project.repos))),
        );
        store.patchRoutine(r.id, { lastSummary: digest });
        log.info(`dream ${r.id} (${project.slug}): ${digest}`);
        // Journal the consolidated memory (the sandbox is awake from the dream just now).
        const sandbox = await createDriver(cfg).getSandbox(`${cfg.sandbox.namePrefix}${project.slug}`);
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
        const sandbox = await createDriver(cfg).getSandbox(`${cfg.sandbox.namePrefix}${project.slug}`);
        if (!sandbox || !sandbox.started) {
          store.patchRoutine(r.id, { lastSummary: 'sandbox asleep — skipped' });
          return;
        }
        let reaped = 0;
        for (const repo of project.repos) {
          reaped += await reapWorktrees(sandbox, repoCheckout(cfg, project.slug, repo));
        }
        const res = await sandbox.exec(housekeepingScript(pruneThreshold()), { timeout: 600 });
        const report = parseHousekeepingReport(res.result ?? '', reaped);
        store.patchRoutine(r.id, { lastSummary: report.digest });
        log.info(`housekeeping ${r.id} (${project.slug}): ${report.digest}`);
      } catch (e) {
        log.error(`housekeeping ${r.id}: ${e instanceof Error ? e.message : String(e)}`);
      }
    })();
    return true;
  }

  // Fire a PR review (on-demand or auto): a read-only review turn keyed per PR (standing →
  // re-review keeps context). Returns false if a review for this PR is already in flight.
  function fireReview(
    c: bolt.webApi.WebClient,
    project: ProjectConfig,
    repo: string,
    number: number,
    channel: string,
    effort: ReviewEffort = 'med',
  ): boolean {
    const key = `review:${repo}:${number}:${project.slug}`;
    if (engine.hasKey(key)) return false;
    void engine.liveTurn(c, channel, undefined, undefined, key, project, reviewPrompt(repo, number, effort)).catch(
      turnFail(`review ${repo}#${number}`),
    );
    return true;
  }

  // Scheduler: every 60s, fire any routine due this wall-clock minute (see dueRoutines).
  // Routines live in state.json, so they need no separate restart recovery.
  function startScheduler(): void {
    const tick = (): void => {
      for (const { routine, key } of dueRoutines(store.listRoutines(), new Date(), firedThisMinute)) {
        firedThisMinute.set(routine.id, key);
        fireRoutine(client, routine);
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
            if (fireReview(client, project, repo, p.number, s.autoReviewChannel, s.autoReviewEffort ?? 'med'))
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
        const key = `${w.repo}#${w.number}`;
        const meta = await getPrMeta(cfg, w.repo, w.number);
        if (!meta) continue; // transient read failure — try again next tick
        if (meta.state === 'closed') {
          store.deletePrWatch(key);
          await client.chat
            .postMessage({ channel: w.channel, text: `:checkered_flag: ${shortRepo(w.repo)}#${w.number} ${meta.merged ? 'merged' : 'closed'} — stopped watching.` })
            .catch(() => {});
          continue;
        }
        const ci = await ciStatusForSha(cfg, w.repo, meta.headSha);
        const reviews = await listReviews(cfg, w.repo, w.number);
        const { notes, next } = autofixEvents(w, { sha: meta.headSha, conclusion: ci }, reviews, BOT_LOGIN);
        store.patchPrWatch(key, next);
        if (notes.length) {
          await client.chat
            .postMessage({ channel: w.channel, text: `${shortRepo(w.repo)}#${w.number}: ${notes.join('; ')}`, blocks: autofixNotifyBlocks(w, notes) })
            .catch(() => {});
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
  // per ticket, posted as a thread under a compact header in the project's `bluefin-aven-<slug>`
  // channel. Awaits channel resolution + the ticket's comments, then hands off to the normal
  // turn machinery. Returns false if it can't even start (channel unknown, or already
  // investigating) so the poller leaves the ticket unseen and retries next tick.
  async function fireInvestigation(project: ProjectConfig, ticket: YouTrackIssue): Promise<boolean> {
    if (investigating.has(ticket.id)) return false; // an overlapping tick is already firing this ticket
    investigating.add(ticket.id);
    try {
      const channel = await channels.channelIdForSlug(client, project);
      if (!channel) {
        log.error(`youtrack ${ticket.id}: channel ${channels.prefix}${project.slug} not found — create it and invite the bot`);
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
      const prompt = investigationPrompt({ ...ticket, comments: commentsText }, mentions);
      // Post a compact header FIRST, then run the whole investigation as a reply under it, so
      // each ticket is one tidy line in the channel with the live status + findings collapsed in
      // its own thread (unlike the other pollers, which post top-level).
      const ticketUrl = `${cfg.youtrack!.baseUrl.replace(/\/$/, '')}/issue/${ticket.id}`;
      const extras = headerExtras(ticket, Date.now());
      let rootTs: string | undefined;
      try {
        const root = await client.chat.postMessage({
          channel,
          text: `:ticket: <${ticketUrl}|${ticket.id}> — ${ticket.summary}${extras ? `  ·  ${extras}` : ''}`,
        });
        rootTs = root.ts as string | undefined;
      } catch (e) {
        log.error(`youtrack ${ticket.id}: header post failed: ${e instanceof Error ? e.message : String(e)}`);
      }
      // Ticket card as the thread's first reply — description, fields, links, files — so the
      // thread is self-contained. Best-effort: a card failure must not sink the investigation.
      if (rootTs) {
        try {
          await client.chat.postMessage({
            channel,
            thread_ts: rootTs,
            text: `${ticket.id}: ${ticket.summary}`,
            blocks: ticketCardBlocks(ticket, ticketUrl, attachRefs.map((a) => a.name)),
          });
        } catch (e) {
          log.error(`youtrack ${ticket.id}: card post failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      // Key the turn like a normal channel thread (`thread:<rootTs>`) instead of a one-shot: that
      // single choice makes the thread CONTINUABLE — a later reply in it resumes THIS Claude
      // session (the bot "owns" the thread via store.getChat) — and gives the finished answer the
      // "Open a PR" follow-up button (answerBlocks attaches it only for `thread:` keys). Falls
      // back to a ticket-scoped key + top-level post if the header couldn't be sent (no rootTs).
      const key = rootTs ? `thread:${rootTs}` : `youtrack:${ticket.id}:${project.slug}`;
      // Persist the investigation BEFORE dispatch so the ticket→thread link and the dedup
      // survive an immediate crash; stamp finishedAt when the turn settles. `rootTs` ties the
      // ticket to `thread:<rootTs>` → chats → the Claude session.
      store.recordInvestigation(ticket.id, { slug: project.slug, channel, rootTs, startedAt: new Date().toISOString() });
      void engine.liveTurn(client, channel, undefined, rootTs, key, project, prompt, attachments)
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

  return {
    startAll: () => {
      startScheduler();
      startAutoReviewPoller();
      startAutofixPoller();
      startYouTrackPoller();
    },
    fireRoutine,
    fireReview,
  };
}
