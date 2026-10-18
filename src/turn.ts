// The turn engine: everything between "a question arrived" and "the answer message is
// final". Owns the live-session cache, the per-key turn queues + cancellation, the
// agent-question (AskUserQuestion) registry, and post-restart turn recovery. Slack
// surfaces (events.ts, commands.ts, pollers.ts) call in; rendering comes from blocks.ts.

import { randomUUID } from 'node:crypto';
import { avenSessionValue } from './gwtoken.js';
import type { ChatDriver, ConvTarget, DriverForTenant, MsgRef } from './chat/driver.js';
import type { MessageView } from './chat/views.js';
import type { Config } from './config.js';
import type { Store } from './state.js';
import { resolveBySlug, type ProjectConfig, type RegistryRef } from './projects.js';
import { openChat, type ChatSession } from './tasks.js';
import { createDriver } from './driver.js';
import { fmtElapsed, prUrls } from './format.js';
import { skippedNotice, type AttachmentRef } from './attachments.js';
import type { AskQuestion, QuestionAnswers, OnQuestion } from './claudeSession.js';
import { MAX_SLACK_TEXT, errText, alertOps } from './chat/slack/blocks.js';
import { QueueJournal } from './queuejournal.js';
import { isThreadKey, threadRoot, slugOfBase, splitTeam } from './teamkeys.js';
import type { HostCaller, HostServerRoute } from './hosttools.js';
import { DraftStore } from './drafts.js';
import { UsageLog, aggregateUsage, usageSummaryText, type TurnUsage } from './metering.js';
import { RateLimitTracker, type RateLimitInfo } from './ratelimit.js';
import { FeedbackLog, joinUsage, feedbackSummaryText, tallyFor, type FeedbackRecord, type Tally } from './feedback.js';
import { log } from './log.js';
import { captureError, Sentry } from './sentry.js';
import { emit } from './messaging/events.js';

// Pending AskUserQuestion prompts: the agent asked, we posted option buttons, and
// we're waiting for clicks. Keyed by a questionId carried on each button. `picks` maps
// a question index → the set of selected option indices (single-select = a set of 1).
export interface PendingQuestion {
  questions: AskQuestion[];
  picks: Map<number, Set<number>>;
  multi: boolean; // any question is multiSelect → needs an explicit Submit
  resolve: (a: QuestionAnswers) => void;
  channel: string;
  ts: string;
  done: boolean;
}

// The slice of the question machinery the button handlers (events.ts) need: look up a
// pending question, distinguish "answered already" from "expired", and finalize.
export interface QuestionRegistry {
  get(qid: string): PendingQuestion | undefined;
  isCompleted(qid: string): boolean;
  answeredAll(entry: PendingQuestion): boolean;
  finalize(entry: PendingQuestion, qid: string): void;
}


export interface TurnEngine {
  // Enqueue a live-status turn (the normal path for mentions, DMs, buttons, pollers).
  liveTurn(
    chat: ChatDriver,
    channel: string,
    msgTs: string | undefined,
    threadTs: string | undefined,
    key: string,
    project: ProjectConfig,
    question: string,
    attachments?: { refs: AttachmentRef[]; bearer: string },
    opts?: TurnOpts,
  ): Promise<void>;
  // Run one turn with no live UI (the /aven ephemeral fallback and dreams).
  runAsk(key: string, project: ProjectConfig, question: string): Promise<string>;
  sessionFor(key: string, project: ProjectConfig, slackUrl?: string): Promise<ChatSession>;
  persist(key: string, slug: string, chat: ChatSession): void;
  cancel(turnId: string): void; // "✖ Cancel" button → abort that turn
  hasKey(key: string): boolean; // a turn queued/running under this conversation key?
  hasLive(key: string): boolean; // an in-memory session exists for this key?
  activeKeys(): string[]; // conversation keys with a turn in flight (for /aven status)
  runningCount(): number; // turns in flight right now (for /aven status)
  // Latest subscription-quota observation from any session (ratelimit.ts; for /aven status).
  claudeQuota(): RateLimitInfo | undefined;
  projectBusy(slug: string): boolean;
  slugForKey(key: string): string | undefined;
  // "🔄 Restart session" → kill this thread's Claude conversation (live or persisted) and
  // clear its session fields, so the next liveTurn/runAsk on this key starts fresh.
  restartSession(key: string, project: ProjectConfig): Promise<void>;
  // ── agent messaging (agent-messaging D10, D11): what the deliverer sees of a conversation ──
  // The turn running on a key: when it started, whether it is automatic (TurnOpts.automatic), and
  // how many task messages were folded into it.
  turnOn(key: string): { turnId: string; startedAt: number; automatic: boolean; injected: number } | undefined;
  noteInjection(key: string): void;
  liveSession(key: string): ChatSession | undefined;
  // A `runAsk` turn (a one-off /aven answer, a dream) runs on the key: it has no place for answers.
  isAsk(key: string): boolean;
  // Cancel every turn queued or running on a key (a canceled task's shadow turn).
  cancelKey(key: string): void;
  // Close a key's session for good (an ended task's shadow conversation): the process is killed,
  // the records stay. And retire one that will not take a message any more: killed, resumed next time.
  closeSession(key: string): Promise<void>;
  retireSession(key: string, slug: string): Promise<void>;
  // Startup recovery, in order: reattach + finalize turns that were RUNNING at the last
  // stop (returns per-key promises so queued replays can wait their turn), then replay the
  // journaled turns that were still QUEUED (their user messages would otherwise be lost).
  resumeInflightTurns(driverFor: DriverForTenant): Map<string, Promise<void>>;
  resumeQueuedTurns(driverFor: DriverForTenant, recovering: Map<string, Promise<void>>): void;
  questions: QuestionRegistry;
  // A turn's tool-call trail (for the "🧭 Show steps" button) — live from the moment the
  // turn is queued, kept after it settles; undefined once evicted or after a restart.
  trail(turnId: string): TurnTrail | undefined;
  // A report-draft turn's answer text (for "✏️ Edit & send"), stored on disk
  // (drafts/<slug>/<turnId>.md) so it survives restarts; undefined once pruned past the
  // per-project cap — the click then gets the "draft expired" modal.
  ytDraft(draftId: string): string | undefined;
  // Token/cost/turn summary over the last N days (mrkdwn, for `/aven usage`), with the
  // answer-feedback cut appended — cost is only half the picture (feedback.ts).
  usageReport(days: number): string;
  // One rating click → one appended record, and back comes the turn's fresh vote count for
  // the button labels. Called by the button/modal handlers in events.ts; the write is
  // best-effort by construction, exactly like usage metering.
  recordFeedback(rec: FeedbackRecord): Tally;
}

// Per-turn behavior switches. `ytDraftFor` marks a "📝 Report to YouTrack" draft turn: the
// answer renders as an editable ticket-comment draft (Edit & send button) instead of the
// normal follow-up buttons — see answerBlocks' ytDraft mode. `autoPost` (the modal's
// "post immediately" checkbox) delivers the answer straight to its destination — supplied as
// a callback by events.ts so the turn engine stays ignorant of YouTrack; when it throws, the
// answer degrades to the reviewable draft with the error attached (never silently lost).
export type TurnOutcome = 'ok' | 'error' | 'canceled';

export interface TurnOpts {
  ytDraftFor?: string;
  autoPost?: (text: string) => Promise<{ url: string; group: string }>;
  // Called with the final answer after it is delivered (routine runs rewrite their top-level
  // parent to the answer's headline — routinerun.ts), and with what the turn used: it is metered
  // only once it settles, after this call, so a caller that reports a cost reads it here (a shadow
  // turn's task, agent-messaging D17). Errors are swallowed.
  onAnswer?: (text: string, usage?: TurnUsage) => Promise<void>;
  // Called exactly once when the turn settles — after onAnswer on success, with the error's
  // message on failure, bare on cancel. doTurn never rejects on a turn error (it renders errText
  // in the thread), so without this a caller cannot tell a failed run from a delivered one; the
  // routine delivery guard records the outcome and rewrites a failed run's parent (routinerun.ts).
  // Errors are swallowed.
  onSettle?: (outcome: TurnOutcome, reason?: string) => Promise<void>;
  // The scheduled routine this turn runs for (pollers.ts), stamped on its usage record so usage
  // and answer feedback can be cut per routine. Absent for every other turn.
  routine?: { id: string; label: string };
  // A shadow turn's provenance (agent messaging D10): the asking agent and the task id — journaled
  // with the queued turn and stamped on its usage record.
  origin?: TurnOrigin;
  // A turn that runs without a person and acts on its own — a poller's review or investigation,
  // autofix: a task message never folds into it, it waits for the turn to end (agent-messaging D11).
  automatic?: true;
  // Where an unsolicited result of this turn's session goes instead of a 🔔 Background update:
  // a shadow conversation hands it to its completion rule (agent-messaging D10).
  onIdleResult?: (text: string) => void;
  // The turn is journaled (a restart replays it): a delivery may be acked now (agent-messaging D11).
  onAccepted?: () => void;
  // The turn starts running (its slot granted): a shadow conversation sends `working` (D10).
  onStart?: () => void;
  // Answers the agent's AskUserQuestion instead of the chat's buttons: nobody can click in a shadow
  // conversation, so it goes to the asker as request_input and is answered at once (D10).
  onQuestion?: OnQuestion;
}
export type TurnOrigin = { slug: string; taskId: string };

/** A shadow conversation's key (agent-messaging D10): `[<tenant>:]a2a:<origin>:<taskId>:<slug>`. */
export const isShadowKey = (key: string): boolean => splitTeam(key).base.startsWith('a2a:');

// What the "🧭 Show steps" click renders: every step line the turn streamed (growing while
// it runs — the array is shared with doTurn), how long it took (so far), and whether it
// settled (the modal shows "still running" until then).
export interface TurnTrail {
  steps: string[];
  elapsedMs: number;
  done: boolean;
}

// Static expectation-setter on the live status ("usually 1–3 min"), shown only while the
// turn is younger than the promise — a 10-minute turn still captioned "usually 1–3 min"
// reads as broken rather than reassuring.
const ETA_HINT = 'usually 1–3 min';
const ETA_HINT_MS = 3 * 60_000;

// Injection seam for the recorded-call tests (src/chat/slack/turn.record.test.ts): a fake
// session factory instead of a real sandbox, and throwaway journal/usage/feedback/draft
// locations instead of the checkout's. Production passes nothing — every default is today's.
// The bot-served MCP servers a session registers over its control channel (hostrouter.ts);
// absent → none, and every session is byte-identical to one without host tools.
export interface HostRoutes {
  routesFor(caller: HostCaller, project: ProjectConfig): HostServerRoute[];
}

export interface TurnDeps {
  openChat?: typeof openChat;
  hostRoutes?: HostRoutes;
  journal?: QueueJournal;
  usageLog?: UsageLog;
  feedbackLog?: FeedbackLog;
  drafts?: DraftStore;
  // Agent messaging's shadow conversations (agent-messaging D10, task 5.7): their chat driver, the
  // options a replayed shadow turn needs (callbacks, origin), and what a recovered one hands its
  // result to. Without it an `a2a:` key is recovered like any other.
  shadow?: {
    driver: ChatDriver;
    opts: (key: string) => TurnOpts | undefined;
    recovered: (key: string, r: { ok: boolean; status: string; text: string }) => Promise<void>;
  };
}

export function createTurnEngine(cfg: Config, store: Store, reg: RegistryRef, deps: TurnDeps = {}): TurnEngine {
  const openSession = deps.openChat ?? openChat;
  // Live in-memory sessions keyed by conversation, to avoid re-preparing the sandbox
  // every turn. On a cache miss (e.g. after a restart) we rebuild, resuming the
  // persisted Claude conversation id. LRU-capped: entries otherwise accumulate one per
  // thread ever touched, forever. Evicting is safe — the persisted sessionKey/cmdId lets
  // sessionFor reattach to a still-running claude, and a dead one rebuilds via --resume.
  const live = new Map<string, ChatSession>();
  const MAX_LIVE = 100;
  function touchLive(key: string, chat: ChatSession): void {
    live.delete(key); // re-insert → newest in the Map's insertion order (poor-man's LRU)
    live.set(key, chat);
    for (const k of live.keys()) {
      if (live.size <= MAX_LIVE) break;
      if (queues.has(k) || asking.has(k)) continue; // never evict under an active turn
      live.delete(k);
    }
  }

  // Per-thread serialization: turns for the same key run one at a time (a chain of
  // promises). Cancellation: each turn has an AbortController keyed by a turnId carried
  // on its "✖ Cancel" button — cancel the running one and the next queued turn starts.
  const queues = new Map<string, Promise<void>>();
  const running = new Map<string, AbortController>();
  // turnIds accepted (status message posted) but not yet claimed by doTurn — still behind
  // an earlier turn in this key's queue, or about to wait for a global slot. A cancel
  // during this window is handled by liveTurn's own abort listener (settles immediately)
  // instead of doTurn's normal checks, which wouldn't run until whatever's ahead of it
  // finishes — on a stuck turn, up to the full 15-minute STREAM_MAX_MS. doTurn deletes its
  // own turnId the moment it starts, handing ownership of any future cancel back to itself.
  const queued = new Set<string>();
  // Keys with a `runAsk` turn in flight (the /aven Q&A path and dreams). These bypass the
  // `queues` chain, so projectBusy() must consult this too — otherwise a dream wouldn't see a
  // live Q&A turn (or another dream) writing the same project's memory.
  const asking = new Set<string>();
  // Agent messaging (D11): the turn running on each key, and every turn accepted per key.
  const current = new Map<string, { turnId: string; startedAt: number; automatic: boolean; injected: number }>();
  const turnsByKey = new Map<string, Set<string>>();

  // Global concurrency cap on agent turns (multi-tenancy slice 4, "capacity"): pollers ×
  // channels × clients can otherwise stampede the sandbox fleet and the provider API.
  // Per-key queues serialize WITHIN a conversation; this caps ACROSS them. Waiting turns
  // show "⏳ waiting for a free agent slot" on their status message.
  const MAX_TURNS = Math.max(1, Math.floor(Number(process.env.TURN_MAX_CONCURRENT)) || 4);
  let turnSlots = MAX_TURNS;
  const slotWaiters: (() => void)[] = [];
  // signal makes the wait abort-aware: canceling a turn that's stuck waiting for a slot
  // (because unrelated turns elsewhere hold all of them) rejects immediately instead of
  // sitting until one of those unrelated turns happens to finish.
  function acquireSlot(signal?: AbortSignal): Promise<void> {
    if (turnSlots > 0) {
      turnSlots--;
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const waiter = () => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      };
      const onAbort = () => {
        const i = slotWaiters.indexOf(waiter);
        if (i !== -1) slotWaiters.splice(i, 1);
        reject(new Error('canceled'));
      };
      slotWaiters.push(waiter);
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
    });
  }
  function releaseSlot(): void {
    const next = slotWaiters.shift();
    if (next) next(); // hand the slot over directly — turnSlots stays 0
    else turnSlots++;
  }
  // Shadow turns (agent-messaging D10 "Slots and sessions") take the global slots like any turn,
  // but at most half of them (at least one): a fan-out or another installation's routine cannot
  // take every slot from this installation's people. A second gate in front of the global one.
  let shadowSlots = Math.max(1, Math.floor(MAX_TURNS / 2));
  const shadowWaiters: (() => void)[] = [];
  function acquireShadowSlot(signal?: AbortSignal): Promise<void> {
    if (shadowSlots > 0) {
      shadowSlots--;
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const waiter = () => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      };
      const onAbort = () => {
        const i = shadowWaiters.indexOf(waiter);
        if (i !== -1) shadowWaiters.splice(i, 1);
        reject(new Error('canceled'));
      };
      shadowWaiters.push(waiter);
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
    });
  }
  function releaseShadowSlot(): void {
    const next = shadowWaiters.shift();
    if (next) next();
    else shadowSlots++;
  }

  // Per-turn token/cost accounting → usage/<month>.jsonl (multi-tenancy slice 4,
  // "whose tokens are we burning"). Best-effort by construction — see metering.ts.
  const usageLog = deps.usageLog ?? new UsageLog();
  // Subscription-quota state — ONE tracker for the whole engine (every project runs on the
  // same plan), fed by each session's rate_limit_event; warns the alert channel on the
  // allowed → warning → rejected transitions and once on recovery (ratelimit.ts).
  const rateLimits = new RateLimitTracker();
  // The value half of the same story: what an answer was worth, joined to what it cost.
  const feedbackLog = deps.feedbackLog ?? new FeedbackLog();

  // turnIds carry a per-boot prefix: they used to be `t<seq>` and reset every restart,
  // which was fine while everything keyed by them was in-memory — but drafts now live on
  // disk, and boot #2's t5 must not collide with (and clobber) boot #1's t5.
  const bootId = Date.now().toString(36);
  let turnSeq = 0;

  // Journal of queued-but-not-yet-started turns (its own file, not state.json — see
  // queuejournal.ts). Entries: added in liveTurn, retired in doTurn once the chat
  // record's `inflight` marker takes over recovery duty. Drained by resumeQueuedTurns.
  const journal = deps.journal ?? new QueueJournal();

  const pendingQuestions = new Map<string, PendingQuestion>();
  // qids that reached a terminal state normally (answered/submitted/canceled). A late
  // click on one of these is a no-op (the message already shows the right final state) —
  // distinct from an UNKNOWN qid (bot restart / genuinely old), which gets "expired".
  // Bounded like trails: without a cap this set grows by one entry per question forever.
  const completedQuestions = new Set<string>();
  const MAX_COMPLETED_QS = 500;
  function markCompleted(qid: string): void {
    completedQuestions.add(qid);
    for (const k of completedQuestions.keys()) {
      if (completedQuestions.size <= MAX_COMPLETED_QS) break;
      completedQuestions.delete(k);
    }
  }
  let questionSeq = 0;

  // Tool-call trails, kept in memory for the "🧭 Show steps" button (events.ts opens them
  // in a modal on click). Registered the moment a turn is QUEUED — the status message
  // already carries the button, and a mid-run click must find the live trail ("no steps
  // yet"), not the "expired" fallback. Bounded — oldest evicted past the cap; a restart
  // loses them, and the button then degrades to an "expired" note, which is acceptable
  // for a peek-behind affordance.
  const trails = new Map<string, TurnTrail>();
  const MAX_TRAILS = 200;
  // Report drafts by turnId, for "✏️ Edit & send" — on disk (drafts/<slug>/<turnId>.md,
  // see drafts.ts) so a deploy no longer kills every pending draft's button.
  const drafts = deps.drafts ?? new DraftStore();
  function startTrail(turnId: string): TurnTrail {
    const trail: TurnTrail = { steps: [], elapsedMs: 0, done: false };
    trails.set(turnId, trail);
    for (const k of trails.keys()) {
      if (trails.size <= MAX_TRAILS) break;
      trails.delete(k);
    }
    return trail;
  }

  function answeredAll(entry: PendingQuestion): boolean {
    return entry.questions.every((_, qi) => (entry.picks.get(qi)?.size ?? 0) > 0);
  }
  // Resolve a question: project picks → answers (question text → comma-joined labels,
  // the verified wire format), mark done, and remove from the registry.
  function finalizeQuestion(entry: PendingQuestion, qid: string): void {
    entry.done = true;
    pendingQuestions.delete(qid);
    markCompleted(qid);
    const answers: QuestionAnswers = {};
    entry.questions.forEach((q, qi) => {
      const set = entry.picks.get(qi);
      if (set && set.size) {
        answers[q.question] = [...set]
          .map((oi) => q.options[oi]?.label)
          .filter(Boolean)
          .join(', ');
      }
    });
    entry.resolve(answers);
  }

  // Build the onQuestion handler for a turn: post the agent's questions as Slack option
  // buttons and resolve once answered (single-select: on click; multi-select: on Submit).
  // Aborting the turn rejects it (the interrupt then tears the turn down). `track`
  // records the questionId so the turn can purge a still-open question when it settles.
  function makeOnQuestion(
    driver: ChatDriver,
    channel: string,
    threadTs: string | undefined,
    signal: AbortSignal,
    track: (qid: string) => void,
  ): OnQuestion {
    return (questions, toolSignal) =>
      new Promise<QuestionAnswers>((resolve, reject) => {
        const qid = `q${++questionSeq}`;
        track(qid);
        const multi = questions.some((q) => q.multiSelect);
        void (async () => {
          const posted = await driver.post(
            { conv: channel, thread: threadTs },
            { kind: 'question', questions, picks: new Map(), multi, qid, done: false },
          );
          const entry: PendingQuestion = {
            questions,
            picks: new Map(),
            multi,
            resolve,
            channel,
            ts: posted.id,
            done: false,
          };
          pendingQuestions.set(qid, entry);
          // Abort on EITHER the turn cancel (✖ Cancel) OR this question being withdrawn
          // by claude (control_cancel_request → toolSignal).
          const onAbort = () => {
            if (entry.done || !pendingQuestions.delete(qid)) return;
            entry.done = true;
            markCompleted(qid);
            void driver
              .update({ conv: channel, id: entry.ts }, { kind: 'text', text: '🚫 Canceled' })
              .catch(() => {});
            reject(new Error('canceled'));
          };
          if (signal.aborted || toolSignal?.aborted) onAbort();
          else {
            signal.addEventListener('abort', onAbort, { once: true });
            toolSignal?.addEventListener('abort', onAbort, { once: true });
          }
        })().catch(reject);
      });
  }

  async function sessionFor(
    key: string,
    project: ProjectConfig,
    slackUrl?: string,
  ): Promise<ChatSession> {
    const existing = live.get(key);
    if (existing) {
      touchLive(key, existing);
      return existing;
    }
    const prior = store.getChat(key);
    // Who the bot-served tools see as the caller: this session's own project, conversation and
    // tenant — fixed here, never taken from anything the agent writes (hosttools.ts).
    const tenantId = splitTeam(key).tenantId;
    const caller: HostCaller = { slug: project.slug, conversationKey: key, ...(tenantId ? { teamId: tenantId } : {}) };
    const chat = await openSession(cfg, store, {
      slug: project.slug,
      repos: project.repos,
      resumeSessionId: prior?.sessionId,
      hostServers: deps.hostRoutes?.routesFor(caller, project) ?? [],
      systemPrompt: project.systemPrompt,
      gitFlow: project.gitFlow,
      slackUrl,
      mcp: project.mcp,
      avenSession: avenSessionValue(key),
      driver: project.driver,
      sandbox: project.sandbox,
      scrubSecrets: project.scrubSecrets,
      sources: project.sources !== undefined,
      ...(project.messaging?.send ? { messagingSend: true } : {}),
      // CLI pin: per-project canary override, else the fleet pin. Install only when no OTHER
      // conversation on this project has a turn in flight (this key's own turn is the one
      // opening the session) — see provisionTooling.
      cliVersion: project.cliVersion ?? cfg.claudeCliVersion,
      upgradeCli: !projectBusyExcept(project.slug, key),
      // Survive bot restarts: reattach to the command this thread was driving (if it's
      // still running), and persist the command coords the moment a session (re)opens so
      // even a crash mid-first-turn leaves a reattachable record.
      attach: prior?.sessionKey && prior?.cmdId ? { sessionKey: prior.sessionKey, cmdId: prior.cmdId } : undefined,
      onOpen: (info) => store.patchChat(key, project.slug, { sessionKey: info.sessionKey, cmdId: info.cmdId, ...(info.ledger || prior?.ledger ? { ledger: info.ledger ? true : undefined } : {}) }),
      // The message ledger (agent-messaging D13): a fresh session of a project with a `messaging`
      // configuration is spawned with it; a reattach follows the mode its process was spawned with.
      ledger: project.messaging !== undefined,
      attachLedger: prior?.ledger === true,
      onLedgerMismatch: ({ expected, actual }) =>
        emit('ask.inject.result_mismatch', { key, expected: expected ?? 'none', actual: actual.join(',') }),
      onRateLimit: (info) => {
        const alert = rateLimits.observe(info, project.slug);
        if (alert) alertOps(alert.text, alert.level === 'recovered' ? 'info' : 'warning');
      },
      // A background Task/Agent that finishes after its turn settled makes the CLI run a
      // whole extra turn on its own — real tokens with no liveTurn/runAsk around them to
      // meter it. Record it against this conversation as kind 'background'. No turnId: the
      // session can't tell which earlier turn launched the work (same reason the
      // 🔔 Background update carries no rating buttons).
      onIdleUsage: ({ usage, isError, durationMs }) =>
        usageLog.record({
          at: new Date().toISOString(),
          key,
          slug: project.slug,
          kind: 'background',
          status: isError ? 'error' : 'ok',
          elapsedMs: durationMs,
          usage,
        }),
    });
    touchLive(key, chat);
    return chat;
  }

  function persist(key: string, slug: string, chat: ChatSession): void {
    const att = chat.attachInfo();
    store.patchChat(key, slug, {
      sessionId: chat.sessionId(),
      sessionKey: att?.sessionKey,
      cmdId: att?.cmdId,
    });
  }

  // Run one turn (no live UI); persists the session id under `key`. Used by /aven's
  // ephemeral fallback where we can't stream progress.
  async function runAsk(key: string, project: ProjectConfig, question: string): Promise<string> {
    asking.add(key); // mark in flight so projectBusy() sees it (dreams + /aven Q&A)
    await acquireSlot(); // asks and dreams count against the same global cap
    const start = Date.now();
    let chat: ChatSession | undefined;
    let status: 'ok' | 'error' = 'error';
    try {
      chat = await sessionFor(key, project);
      const answer = await chat.ask(question);
      persist(key, project.slug, chat);
      status = 'ok';
      return answer.slice(0, MAX_SLACK_TEXT) || '(no output)';
    } finally {
      releaseSlot();
      asking.delete(key);
      usageLog.record({
        at: new Date().toISOString(),
        key,
        slug: project.slug,
        kind: 'ask',
        status,
        elapsedMs: Date.now() - start,
        usage: chat?.lastUsage(),
      });
    }
  }

  // Map a conversation key back to its project slug. dm/cmd keys carry the slug as their
  // last segment (`dm:<channel>:<slug>`, `cmd:<user>:<slug>`); thread keys (`thread:<ts>`)
  // don't, so look the slug up in the persisted chat record.
  function slugForKey(key: string): string | undefined {
    // Thread keys carry no slug — resolve via the ChatRecord, stored under the FULL
    // (possibly tenant-prefixed) key. Every other shape embeds the slug (teamkeys.ts).
    if (isThreadKey(key)) return store.getChat(key)?.slug;
    return slugOfBase(key);
  }

  // True if any conversation for this project has a turn in flight right now — used to skip
  // a dream rather than race a live user turn on the project's memory files.
  function projectBusy(slug: string): boolean {
    for (const key of queues.keys()) if (slugForKey(key) === slug) return true;
    for (const key of asking) if (slugForKey(key) === slug) return true; // runAsk turns (Q&A, dreams)
    return false;
  }
  // projectBusy minus one conversation — "is anyone ELSE working on this project?", for a
  // step the calling turn wants to run only when it has the sandbox to itself (CLI upgrade).
  function projectBusyExcept(slug: string, except: string): boolean {
    for (const key of queues.keys()) if (key !== except && slugForKey(key) === slug) return true;
    for (const key of asking) if (key !== except && slugForKey(key) === slug) return true;
    return false;
  }

  // Forget this key's Claude conversation. Prefers the live ChatSession's own close() (it
  // knows its sandbox handle already); falls back to killing the PERSISTED session-command
  // directly when nothing's cached (evicted, or the bot restarted since). Either way, unlike
  // touchLive's LRU eviction or state.ts's pruneChats — which deliberately leave the
  // sandbox-side process for the sandbox's own idle lifecycle to reap — this is an explicit
  // "throw the conversation away", so it kills the process now rather than orphaning it.
  async function restartSession(key: string, project: ProjectConfig): Promise<void> {
    const cached = live.get(key);
    if (cached) {
      await cached.close().catch(() => {});
      live.delete(key);
    } else {
      const rec = store.getChat(key);
      if (rec?.sessionKey) {
        try {
          const driver = createDriver(cfg, project.driver);
          const handle = await driver.getSandbox(`${cfg.sandbox.namePrefix}${project.slug}`);
          await handle?.deleteSession(rec.sessionKey);
        } catch (e) {
          log.error(`restartSession ${key}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    }
    store.patchChat(key, project.slug, { sessionId: undefined, sessionKey: undefined, cmdId: undefined, ledger: undefined });
    // A fresh session has none of the old session's data in its context: its marks end here
    // (agent-messaging D14 "Fresh session"). A no-op for a conversation that was never marked.
    store.setMarks(key, {});
  }

  // A message starting with this prefix is a human-only NOTE: the bot stays out entirely
  // (no turn, no agent run), just a quiet reaction to confirm it saw and skipped it. Lets
  // you jot something for yourself or a colleague mid-thread without triggering Claude.
  // `!`, not `/`-anything: a leading `/` collides with Slack's slash-command UI.
  // (The acknowledgement itself is the chat driver's — a reaction on Slack.)
  const NOTE_PREFIX = process.env.SLACK_NOTE_PREFIX || '!';
  const isNote = (text: string): boolean => text.trim().startsWith(NOTE_PREFIX);

  // Enqueue a turn for `key` and post its status message immediately (so a queued turn
  // shows "in queue" right away). Turns for the same key run strictly one at a time;
  // canceling the running one lets the next start. msgTs is the user's message to react
  // to (undefined for /aven).
  async function liveTurn(
    chat: ChatDriver,
    channel: string,
    msgTs: string | undefined,
    threadTs: string | undefined,
    key: string,
    project: ProjectConfig,
    question: string,
    // Inbound files to download into the sandbox before the turn runs (Slack uploads /
    // YouTrack ticket files). Optional so the many other call sites are unaffected.
    attachments?: { refs: AttachmentRef[]; bearer: string },
    opts?: TurnOpts,
  ): Promise<void> {
    if (isNote(question)) {
      // Human-only note — leave the agent out entirely; just acknowledge we skipped it.
      if (msgTs) await chat.mark({ conv: channel, id: msgTs }, 'note', 'add');
      return;
    }
    if (msgTs) await chat.mark({ conv: channel, id: msgTs }, 'working', 'add');
    const turnId = `t${bootId}-${++turnSeq}`;
    const ac = new AbortController();
    running.set(turnId, ac);
    queued.add(turnId);
    // Register the (empty) trail NOW: the status message below already carries a live
    // "🧭 Show steps" button, and a click while the turn is still queued must find an
    // entry ("no steps yet"), not the "expired after a restart" fallback.
    startTrail(turnId);

    const busy = queues.has(key);
    const posted = await chat.post(
      { conv: channel, thread: threadTs },
      {
        kind: 'status',
        line: busy ? '⏳ In queue — waiting for the previous message…' : `🛠 Preparing…  ·  ${ETA_HINT}`,
        turnId,
        notify: busy ? 'In queue…' : 'Working…',
        ...(busy ? { queued: true as const } : {}),
      },
    );
    const ts = posted.id;

    // Journal the accepted turn so a restart can't silently swallow it while it waits in
    // the queue. Retired in doTurn once the `inflight` marker takes over. plain=false when
    // the turn carries things a replay can't reconstruct (attachment bearer, opts callbacks).
    journal.add({
      turnId,
      key,
      slug: project.slug,
      channel,
      statusTs: ts,
      threadTs,
      msgTs,
      question,
      // onAnswer alone keeps a turn replayable (a replay just skips the parent's headline update).
      plain: !attachments?.refs.length && (!opts || (!opts.ytDraftFor && !opts.autoPost)),
      ...(opts?.origin ? { origin: opts.origin } : {}),
    });
    if (opts?.onAccepted) {
      try {
        opts.onAccepted();
      } catch (e) {
        log.error(`onAccepted ${turnId}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    // Cancel while still queued (doTurn hasn't claimed this turnId yet) — settle right
    // here rather than leaving "⏳ In queue…" frozen until doTurn eventually runs.
    ac.signal.addEventListener(
      'abort',
      () => {
        if (!queued.delete(turnId)) return; // doTurn already claimed it — it owns the settle now
        journal.done(turnId);
        void chat.update({ conv: channel, id: ts }, { kind: 'text', text: '🚫 Canceled' }).catch(() => {});
        if (msgTs) void chat.mark({ conv: channel, id: msgTs }, 'working', 'remove');
        if (opts?.onSettle) void opts.onSettle('canceled').catch(() => {});
      },
      { once: true },
    );

    const prev = queues.get(key) ?? Promise.resolve();
    const mine = prev
      .catch(() => {})
      .then(() => doTurn(chat, channel, msgTs, threadTs, ts, key, project, question, turnId, ac, attachments, opts));
    queues.set(key, mine);
    const ofKey = turnsByKey.get(key) ?? new Set<string>();
    ofKey.add(turnId);
    turnsByKey.set(key, ofKey);
    void mine.finally(() => {
      running.delete(turnId);
      if (queues.get(key) === mine) queues.delete(key);
      ofKey.delete(turnId);
      if (!ofKey.size && turnsByKey.get(key) === ofKey) turnsByKey.delete(key);
    });
    return mine;
  }

  // The actual work for one turn, run after any earlier turn for the same key. Streams
  // live status into the message `ts` and rewrites it into the answer (or cancel/error).
  async function doTurn(
    chat: ChatDriver,
    channel: string,
    msgTs: string | undefined,
    threadTs: string | undefined,
    ts: string,
    key: string,
    project: ProjectConfig,
    question: string,
    turnId: string,
    ac: AbortController,
    attachments?: { refs: AttachmentRef[]; bearer: string },
    opts?: TurnOpts,
  ): Promise<void> {
    // Claim this turnId from `queued` — from here on, a cancel is OUR job to settle (via
    // the checks below or the live interrupt path), not liveTurn's abort listener.
    queued.delete(turnId);
    const status = { conv: channel, id: ts }; // this turn's working message
    const where = { conv: channel, thread: threadTs }; // its thread, for new messages
    // While the conversation holds another domain's data (agent-messaging D14), every post and
    // update of this turn carries the marker, so the project's own chat sources skip it. Read at
    // each call: an answer folded in mid-turn marks the rest of it. Unmarked → the same objects.
    const mark = <T extends ConvTarget | MsgRef>(x: T): T => (Object.keys(store.getMarks(key)).length ? { ...x, marked: true } : x);
    const userMsg = msgTs ? { conv: channel, id: msgTs } : undefined;
    const clearEyes = async () => {
      if (userMsg) await chat.mark(userMsg, 'working', 'remove');
    };
    // Shared by every "this turn never got to run" exit below — same settle, same journal
    // retirement, whether it was canceled before doTurn started or while waiting for a slot.
    const settleCanceled = async (): Promise<void> => {
      journal.done(turnId);
      await chat.update(mark(status), { kind: 'text', text: '🚫 Canceled' });
      await clearEyes();
      if (opts?.onSettle) await opts.onSettle('canceled').catch(() => {});
    };
    if (ac.signal.aborted) {
      await settleCanceled(); // canceled between liveTurn posting and doTurn claiming it
      return;
    }

    // Global turn cap. If no slot is free, say so on the status message (otherwise the
    // wait reads as a mysteriously long "Preparing…"), then block until one frees up.
    // acquireSlot is abort-aware, so a cancel here rejects immediately rather than waiting
    // on some UNRELATED turn elsewhere to free a slot.
    if (turnSlots <= 0) {
      await chat
        .update(status, { kind: 'status', line: '⏳ Waiting for a free agent slot…', turnId, notify: 'In queue…' })
        .catch(() => {});
    }
    const shadowTurn = isShadowKey(key);
    try {
      if (shadowTurn) await acquireShadowSlot(ac.signal);
    } catch {
      await settleCanceled();
      return;
    }
    try {
      await acquireSlot(ac.signal);
    } catch {
      if (shadowTurn) releaseShadowSlot();
      await settleCanceled(); // canceled while waiting for a slot — never acquired one, nothing to release
      return;
    }
    if (ac.signal.aborted) {
      // Rare race: canceled the instant the slot was granted — release it immediately
      // rather than let a dead turn hold a slot another turn is waiting on.
      releaseSlot();
      if (shadowTurn) releaseShadowSlot();
      await settleCanceled();
      return;
    }

    const start = Date.now();
    // What the deliverer sees of this turn (agent-messaging D11). Automatic: flagged by its caller,
    // or a turn that posts to YouTrack on its own.
    current.set(key, { turnId, startedAt: start, automatic: opts?.automatic === true || !!opts?.ytDraftFor || !!opts?.autoPost, injected: 0 });
    if (opts?.onStart) {
      try {
        opts.onStart();
      } catch (e) {
        log.error(`onStart ${turnId}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    let phase = '🛠 Preparing sandbox…';
    // Registered when the turn was queued; the array is shared, so every push below shows
    // up in an already-open "🧭 Show steps" modal on its next open. (?? covers a doTurn
    // reached without liveTurn, e.g. future call sites.)
    const trail = trails.get(turnId) ?? startTrail(turnId);
    const steps = trail.steps;
    let lastRendered = '';
    let lastUpdateAt = 0;
    let finished = false;
    // Set when the turn outlives the soft deadline: the status message stops ticking and
    // turns into the static background card, and the outcome is delivered as a NEW thread
    // message instead of rewriting it. See goBackground() below.
    let background = false;

    const render = (): string => {
      const elapsed = Date.now() - start;
      const head = `${phase}  ⏱ ${fmtElapsed(elapsed)}${elapsed < ETA_HINT_MS ? `  ·  ${ETA_HINT}` : ''}`;
      const tail = steps.slice(-6).join('\n');
      return tail ? `${head}\n${tail}` : head;
    };
    const flush = async (force = false): Promise<void> => {
      if (finished || background) return; // background froze the message — no more ticking
      const now = Date.now();
      if (!force && now - lastUpdateAt < 1500) return; // throttle chat.update
      const text = render();
      if (text === lastRendered) return;
      lastRendered = text;
      lastUpdateAt = now;
      try {
        await chat.update(mark(status), { kind: 'status', line: text, turnId, notify: text });
      } catch {
        /* rate limit / transient — next tick retries */
      }
    };
    // flush() calls are otherwise fire-and-forget, so a status tick fired just before the turn
    // finishes can still be in flight when the final "answered" chat.update goes out — two
    // concurrent requests racing to the same message, with no guaranteed arrival order. Routing
    // every call through this chain serializes the requests; awaiting it below before the final
    // update guarantees any last tick is sent and resolved first, so the final update is always
    // the one Slack applies last.
    let pendingFlush: Promise<void> = Promise.resolve();
    const scheduleFlush = (force = false): Promise<void> => {
      pendingFlush = pendingFlush.then(() => flush(force));
      return pendingFlush;
    };
    const heartbeat = setInterval(() => void scheduleFlush(), 4000);
    // Soft deadline reached. The turn keeps running to the hard cap, but the UI stops
    // pretending an answer is seconds away: kill the heartbeat, freeze the message into the
    // static background card (🧭 Show steps stays live, ✖ Cancel still works). Queued
    // flushes no-op from here (`background` is set before the chain is extended), and the
    // card goes through pendingFlush so it can't race a tick already in flight.
    const goBackground = (): void => {
      if (background || finished) return;
      background = true;
      clearInterval(heartbeat);
      const card = { kind: 'background', turnId, elapsedMs: Date.now() - start } as const;
      pendingFlush = pendingFlush.then(() =>
        chat
          .update(status, card)
          .then(
            () => {},
            () => {}, // transient Slack failure — the card is cosmetic, the turn runs on
          ),
      );
    };
    // Where the turn's outcome goes. While the message is still live it rewrites itself, as
    // always. Once backgrounded, we promised a new message in the thread — so post one (it
    // pings; chat.update does not) and collapse the card to a pointer at it.
    const deliver = async (view: MessageView, label: string): Promise<void> => {
      if (!background) {
        await chat.update(mark(status), view);
        return;
      }
      await chat.post(mark(where), view);
      await chat
        .update(status, { kind: 'backgroundDone', label, steps: steps.length, elapsedMs: Date.now() - start })
        .catch(() => {});
    };
    const turnQs = new Set<string>(); // questionIds this turn opened (for cleanup on settle)

    // Mark this turn in flight so a restart can reattach and finalize THIS status message
    // (channel, ts) instead of leaving it frozen on "Working…". Cleared in finally.
    // Ordering: inflight FIRST, then retire the journal entry — a crash in between leaves
    // both active, which resumeQueuedTurns dedupes by statusTs; the reverse order would
    // leave a gap where the turn is in neither and vanishes.
    store.patchChat(key, project.slug, {
      inflight: { channel, statusTs: ts, msgThreadTs: threadTs, startedAt: new Date().toISOString() },
    });
    journal.done(turnId);
    // Best-effort permalink to this thread so the agent can link a PR back to the Slack
    // discussion. Only meaningful for channel threads (threadTs set); DMs have none.
    const slackUrl = threadTs ? await chat.permalink({ conv: channel, id: threadTs }) : undefined;
    let session: ChatSession | undefined; // hoisted so the finally can read lastUsage()
    let outcome: TurnOutcome = 'ok';
    let failure: string | undefined; // the error's message, for onSettle
    try {
      const live = await sessionFor(key, project, slackUrl); // prepare (warm sandbox + clone) here
      session = live; // `live` keeps the non-undefined narrowing inside the closures below
      // With the message ledger the turn's message carries a uuid, kept beside the inflight marker,
      // so a restart's recovery settles this turn only on its own result (agent-messaging D13).
      const uuid = live.hasLedger() ? randomUUID() : undefined;
      if (uuid) {
        const inf = store.getChat(key)?.inflight;
        if (inf) store.patchChat(key, project.slug, { inflight: { ...inf, uuid } });
      }
      // A background Task/Agent this turn launches may finish AFTER this turn's own
      // answer is already posted — see ClaudeSession.onIdleResult. Re-registered on every
      // live turn so it always targets the CURRENT channel/thread.
      if (opts?.onIdleResult) live.setIdleNotify(opts.onIdleResult);
      else live.setIdleNotify((text) => {
        const capped = text.slice(0, MAX_SLACK_TEXT) || '(no output)';
        const msg = `🔔 *Background update*\n${capped}`;
        void chat
          // No rating buttons here on purpose: this callback is re-registered per live turn,
          // so a background result that lands during a LATER turn would be attributed to that
          // later turn — a rating on it would land on the wrong turnId. Ratings come back
          // once onIdleResult carries the turn that actually launched the work.
          .post(mark(where), { kind: 'answer', markdown: msg })
          .catch((e) => log.error(`idle-notify ${key}: ${e instanceof Error ? e.message : String(e)}`));
      });
      // Download any inbound files into the sandbox first, then prepend a preamble naming their
      // paths so the agent Reads them. Best-effort: a failure here must not sink the whole turn.
      let prompt = question;
      if (attachments?.refs.length) {
        phase = '📎 Fetching attachments…';
        await scheduleFlush(true);
        try {
          const { preamble, skipped } = await live.ingest(attachments.refs, attachments.bearer, turnId);
          if (preamble) prompt = `${preamble}\n\n${question}`;
          // Unusable files get a DETERMINISTIC reply in the thread — the preamble only tells
          // the agent, and whether the model relays a skip is up to it. Best-effort: a failed
          // notice must not sink the turn.
          if (skipped.length) {
            await chat
              .post(mark(where), { kind: 'text', text: skippedNotice(skipped) })
              .catch((e) => log.error(`skip notice ${turnId}: ${e instanceof Error ? e.message : String(e)}`));
          }
        } catch (e) {
          log.error(`ingest ${turnId}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      phase = '🔎 Working…';
      await scheduleFlush(true);
      // Wrap the agent turn in a Sentry span so turn latency shows up in performance (no-op
      // tracing when Sentry is off — startSpan still runs the callback).
      const answer = await Sentry.startSpan(
        { name: 'aven.turn', op: 'gen_ai.invoke_agent', attributes: { 'aven.project': project.slug } },
        () =>
          live.ask(
            prompt,
            (step) => {
              steps.push(step);
              void scheduleFlush();
            },
            ac.signal,
            opts?.onQuestion ?? makeOnQuestion(chat, channel, threadTs, ac.signal, (qid) => turnQs.add(qid)),
            // Soft deadline reached: the turn continues to the hard cap — flip the working
            // message to the background card instead of erroring out. No extra thread
            // notice: the card says it, and the answer itself will arrive as a new message.
            goBackground,
            uuid,
          ),
      );
      persist(key, project.slug, live);
      if (live.contextLost()) {
        await chat
          .post(mark(where), {
            kind: 'text',
            text: '⚠️ Lost the previous session context (the sandbox was rebuilt) — starting fresh.',
          })
          .catch(() => {});
      }
      clearInterval(heartbeat);
      await pendingFlush; // let any in-flight status tick land before the final "answered" update
      finished = true;
      const capped = answer.slice(0, MAX_SLACK_TEXT) || '(no output)';
      // Follow-up buttons (Report to YouTrack) only in build channels (thread sessions), not
      // in the private /aven + DM Q&A paths where they would just be noise.
      const followUp = isThreadKey(key) ? { key, channel, threadTs } : undefined;
      // Investigation thread → offer "📝 Report to YouTrack" (thread root ↔ ticket id via state).
      const inv = followUp ? store.investigationByRoot(threadRoot(key) ?? '') : undefined;
      const elapsedMs = Date.now() - start;
      // Skip-preview draft: deliver the answer directly (the autoPost hook), and only fall
      // back to the reviewable draft — error attached — when delivery fails.
      let view: MessageView | undefined;
      if (opts?.ytDraftFor && opts.autoPost) {
        try {
          const posted = await opts.autoPost(capped);
          view = { kind: 'reported', markdown: capped, ticket: opts.ytDraftFor, url: posted.url, group: posted.group };
        } catch (e) {
          const why = e instanceof Error ? e.message : String(e);
          drafts.put(project.slug, turnId, capped); // manual retry needs the text
          view = {
            kind: 'answer',
            markdown: capped,
            opts: { ytDraft: { ticket: opts.ytDraftFor, draftId: turnId } },
            notice: `⚠️ Auto-post failed: ${why.slice(0, 300)} — review and send manually.`,
          };
        }
      }
      if (opts?.ytDraftFor && !view) drafts.put(project.slug, turnId, capped);
      view ??= {
        kind: 'answer',
        markdown: capped,
        opts: {
          followUp,
          trail: { turnId, steps: steps.length, elapsedMs },
          ytReport: inv?.id,
          ytDraft: opts?.ytDraftFor ? { ticket: opts.ytDraftFor, draftId: turnId } : undefined,
          rate: { turnId, slug: project.slug, key },
        },
      };
      await deliver(view, '✅ Done — answer posted below');
      if (opts?.onAnswer) await opts.onAnswer(capped, session?.lastUsage()).catch(() => {});
      // Latch the flag the first turn whose answer carries a PR URL — the session panel
      // shows whether this thread has produced a PR.
      if (!store.getChat(key)?.prCreated && prUrls(capped).length)
        store.patchChat(key, project.slug, { prCreated: true });
      if (userMsg) {
        await chat.mark(userMsg, 'working', 'remove');
        await chat.mark(userMsg, 'done', 'add');
      }
    } catch (err) {
      clearInterval(heartbeat);
      await pendingFlush; // let any in-flight status tick land before the final canceled/error update
      finished = true;
      outcome = ac.signal.aborted ? 'canceled' : 'error';
      if (ac.signal.aborted) {
        // Cancel always lands in place: the user just clicked ✖ on this very message.
        await chat.update(mark(status), { kind: 'text', text: '🚫 Canceled' });
        await clearEyes();
      } else {
        failure = err instanceof Error ? err.message : String(err);
        // A failure after the turn went background needs the same ping the answer gets —
        // an hour-old message rewriting itself to an error notifies nobody.
        await deliver({ kind: 'text', text: errText(err) }, '⚠️ Failed — details below');
        if (userMsg) {
          await chat.mark(userMsg, 'working', 'remove');
          await chat.mark(userMsg, 'failed', 'add');
        }
      }
    } finally {
      releaseSlot();
      if (shadowTurn) releaseShadowSlot();
      if (current.get(key)?.turnId === turnId) current.delete(key);
      // Meter the turn (even canceled/errored ones — tokens may have burned before the
      // interrupt; a turn that died before sessionFor simply records no usage).
      usageLog.record({
        at: new Date().toISOString(),
        key,
        turnId,
        slug: project.slug,
        kind: 'turn',
        status: outcome,
        elapsedMs: Date.now() - start,
        usage: session?.lastUsage(),
        ...(opts?.routine ? { routineId: opts.routine.id, routineLabel: opts.routine.label } : {}),
        ...(opts?.origin ? { originSlug: opts.origin.slug, taskId: opts.origin.taskId } : {}),
      });
      // Settled either way (answer/cancel/error) — freeze the trail's clock and stop the
      // modal saying "still running". The steps stay: the answer rewrite would otherwise
      // erase the only record of HOW the answer was reached (the #1 trust complaint).
      trail.done = true;
      trail.elapsedMs = Date.now() - start;
      store.patchChat(key, project.slug, { inflight: undefined }); // turn settled — clear marker
      // Purge any question this turn left open (errored/timed out without an answer or
      // cancel) so its buttons don't linger as dead clicks.
      for (const qid of turnQs) {
        const entry = pendingQuestions.get(qid);
        if (entry && !entry.done) {
          entry.done = true;
          pendingQuestions.delete(qid);
          await chat
            .update({ conv: entry.channel, id: entry.ts }, { kind: 'text', text: '⌛ Question closed' })
            .catch(() => {});
        }
      }
      // Last: the caller's settle hook, once the answer/error is delivered and the state is
      // consistent (a routine records its outcome and may schedule its retry from here).
      if (opts?.onSettle) await opts.onSettle(outcome, failure).catch(() => {});
    }
  }

  // On startup, finalize any turn that was still "Working…" when the bot last stopped:
  // reattach to its command (still running, or finished during the downtime) and rewrite
  // its status message with the recovered result. Best-effort, per chat, never blocks.
  // Returns each chat's recovery promise keyed by conversation key, so resumeQueuedTurns
  // can hold a key's replays until its running turn has been recovered (else the replay
  // hits the still-busy session and errors).
  function resumeInflightTurns(driverFor: DriverForTenant): Map<string, Promise<void>> {
    const recovering = new Map<string, Promise<void>>();
    for (const chat of store.allChats()) {
      const inf = chat.inflight;
      if (!inf || !chat.sessionKey || !chat.cmdId) continue;
      const project = resolveBySlug(reg.current, chat.slug);
      if (!project) {
        store.patchChat(chat.threadTs, chat.slug, { inflight: undefined });
        continue;
      }
      // The record's own workspace token finalizes its status message. A tenant with no
      // installation (uninstalled since) clears the marker — leaving it would make every
      // future boot retry forever (pruneChats skips inflight records).
      // A shadow conversation (agent-messaging D10) has no chat to finalize: its result goes to the
      // task's completion rule, and the turn is metered with the task's origin (recovery writes no
      // usage record for other turns).
      const shadow = isShadowKey(chat.threadTs) ? deps.shadow : undefined;
      if (shadow) {
        recovering.set(chat.threadTs, recoverShadow(chat.threadTs, project, inf.uuid, shadow));
        continue;
      }
      let driver: ChatDriver;
      try {
        driver = driverFor(chat.teamId);
      } catch (e) {
        log.error(`resume ${chat.threadTs}: ${e instanceof Error ? e.message : String(e)}`);
        store.patchChat(chat.threadTs, chat.slug, { inflight: undefined });
        continue;
      }
      const status: MsgRef = { conv: inf.channel, id: inf.statusTs, ...(inf.msgThreadTs ? { thread: inf.msgThreadTs } : {}) };
      const recovery = (async () => {
        try {
          await driver
            .update(status, { kind: 'text', text: '🔄 Reconnected after a restart — recovering this turn…' })
            .catch(() => {});
          const cs = await sessionFor(chat.threadTs, project);
          // Recovered turns get the live path's treatment at the soft deadline: the status
          // message goes static ("in the background") and the result arrives as a new thread
          // message. No buttons here — the recovered turn has no AbortController to cancel
          // and its step trail died with the old process, so the card is text only.
          let background = false;
          const r = await cs.adoptInflight(
            undefined,
            () => {
              background = true;
              void driver
                .update(status, {
                  kind: 'text',
                  text:
                    '🌙 *Working in the background* — the recovered turn is taking longer than usual. ' +
                    "I'll post the result in this thread as a new message when it's done.",
                })
                .catch(() => {});
            },
            inf.uuid, // with the message ledger: settle only on this turn's own result
          );
          persist(chat.threadTs, project.slug, cs);
          if (r.ok) {
            const capped = r.text.slice(0, MAX_SLACK_TEXT) || '(no output)';
            if (background) {
              await driver.post({ conv: inf.channel, thread: inf.msgThreadTs }, { kind: 'answer', markdown: capped });
              await driver.update(status, { kind: 'text', text: '✅ Done — answer posted below' }).catch(() => {});
            } else {
              await driver.update(status, { kind: 'answer', markdown: capped });
            }
            // A recovered turn may have opened the PR — latch so the session panel reflects it.
            if (!chat.prCreated && prUrls(capped).length)
              store.patchChat(chat.threadTs, project.slug, { prCreated: true });
          } else {
            await driver.update(status, {
              kind: 'text',
              text: `⚠️ The bot restarted mid-turn and couldn't recover the live result (${r.status}). The work may have finished in the thread or a PR — send a new message to continue.`,
            });
          }
        } catch (e) {
          // A recovery failure was previously swallowed (user saw a warning, Sentry saw
          // nothing). Raise an issue so lost turns are visible in ops.
          log.error(`resume ${chat.threadTs}: ${e instanceof Error ? e.message : String(e)}`);
          captureError(e, { subsystem: 'resume', thread: chat.threadTs, slug: chat.slug });
          await driver
            .update(status, {
              kind: 'text',
              text: "⚠️ The bot restarted mid-turn; couldn't recover this status. Send a new message to continue.",
            })
            .catch(() => {});
        } finally {
          store.patchChat(chat.threadTs, chat.slug, { inflight: undefined });
        }
      })();
      recovering.set(chat.threadTs, recovery);
    }
    return recovering;
  }

  async function recoverShadow(key: string, project: ProjectConfig, uuid: string | undefined, shadow: NonNullable<TurnDeps['shadow']>): Promise<void> {
    const start = Date.now();
    let r: { ok: boolean; status: string; text: string } = { ok: false, status: 'error', text: '' };
    let cs: ChatSession | undefined;
    try {
      cs = await sessionFor(key, project);
      r = await cs.adoptInflight(undefined, undefined, uuid);
      persist(key, project.slug, cs);
    } catch (e) {
      log.error(`resume ${key}: ${e instanceof Error ? e.message : String(e)}`);
      captureError(e, { subsystem: 'resume', thread: key, slug: project.slug });
      r = { ok: false, status: 'error', text: e instanceof Error ? e.message : String(e) };
    } finally {
      store.patchChat(key, project.slug, { inflight: undefined });
    }
    const origin = shadow.opts(key)?.origin;
    usageLog.record({
      at: new Date().toISOString(),
      key,
      slug: project.slug,
      kind: 'turn',
      status: r.ok ? 'ok' : r.status === 'canceled' ? 'canceled' : 'error',
      elapsedMs: Date.now() - start,
      usage: cs?.lastUsage(),
      ...(origin ? { originSlug: origin.slug, taskId: origin.taskId } : {}),
    });
    await shadow.recovered(key, r).catch((e) => log.error(`resume ${key}: ${e instanceof Error ? e.message : String(e)}`));
  }

  // Replay the journaled turns that were still QUEUED (accepted, never started) at the
  // last stop — the one class of turn that used to vanish silently, leaving its "In
  // queue…" message frozen. Plain turns re-run automatically; turns that carried
  // attachments or engine-side callbacks (a YT draft's autoPost) can't be reconstructed,
  // so their status message quotes the question and asks for a resend — visibly lost
  // beats silently lost. Keys are processed sequentially (preserving enqueue order),
  // after any inflight recovery on the same key has settled.
  function resumeQueuedTurns(driverFor: DriverForTenant, recovering: Map<string, Promise<void>>): void {
    const pending = journal.drain();
    const byKey = new Map<string, typeof pending>();
    for (const e of pending) {
      // The turn that STARTED before the restart may appear in BOTH stores if the crash
      // hit the tiny inflight-then-retire-journal overlap — inflight recovery owns it.
      if (store.getChat(e.key)?.inflight?.statusTs === e.statusTs) continue;
      const list = byKey.get(e.key) ?? [];
      list.push(e);
      byKey.set(e.key, list);
    }
    for (const [key, entries] of byKey) {
      void (async () => {
        await recovering.get(key)?.catch(() => {});
        for (const e of entries) {
          const project = resolveBySlug(reg.current, e.slug);
          // A queued shadow turn (agent-messaging D10) replays through the shadow driver with the
          // options its task record gives back (callbacks, origin); a task that ended has none.
          if (isShadowKey(e.key) && deps.shadow) {
            const opts = deps.shadow.opts(e.key);
            if (!project || !opts) {
              log.info(`replay ${e.turnId}: the task of ${e.key} ended — not replayed`);
              continue;
            }
            try {
              await liveTurn(deps.shadow.driver, e.channel, e.msgTs, e.threadTs, e.key, project, e.question, undefined, opts);
            } catch (err) {
              log.error(`replay ${e.turnId}: ${err instanceof Error ? err.message : String(err)}`);
            }
            continue;
          }
          // Pre-liveTurn tenant check (skip, not throw): a replay for an uninstalled
          // workspace has no token to even rewrite its status message with.
          let driver: ChatDriver;
          try {
            driver = driverFor(e.teamId);
          } catch (err) {
            log.error(`replay ${e.turnId}: ${err instanceof Error ? err.message : String(err)}`);
            continue;
          }
          try {
            const status = { conv: e.channel, id: e.statusTs };
            if (project && e.plain) {
              await driver
                .update(status, { kind: 'text', text: '🔄 The bot restarted before this turn could start — rerunning it below.' })
                .catch(() => {});
              // Awaiting completion serializes this key's replays — the same order the
              // queue would have run them in.
              await liveTurn(driver, e.channel, e.msgTs, e.threadTs, e.key, project, e.question);
            } else {
              const why = project
                ? "its attachments/context can't be replayed"
                : 'its project is no longer configured';
              await driver
                .update(status, {
                  kind: 'text',
                  text: `⚠️ The bot restarted before this message was processed and ${why} — please resend it:\n> ${e.question.slice(0, 500)}`,
                })
                .catch(() => {});
            }
          } catch (err) {
            log.error(`replay ${e.turnId}: ${err instanceof Error ? err.message : String(err)}`);
            captureError(err, { subsystem: 'replay', key: e.key, slug: e.slug });
          }
        }
      })();
    }
  }

  return {
    liveTurn,
    runAsk,
    sessionFor,
    persist,
    cancel: (turnId) => running.get(turnId)?.abort(),
    hasKey: (key) => queues.has(key),
    hasLive: (key) => live.has(key),
    activeKeys: () => [...queues.keys()],
    runningCount: () => running.size,
    claudeQuota: () => rateLimits.latest(),
    projectBusy,
    slugForKey,
    restartSession,
    turnOn: (key) => current.get(key),
    noteInjection: (key) => {
      const c = current.get(key);
      if (c) c.injected++;
    },
    liveSession: (key) => live.get(key),
    isAsk: (key) => asking.has(key),
    cancelKey: (key) => {
      for (const turnId of turnsByKey.get(key) ?? []) running.get(turnId)?.abort();
    },
    closeSession: async (key) => {
      const s = live.get(key);
      live.delete(key);
      await s?.close().catch(() => {});
    },
    retireSession: async (key, slug) => {
      const s = live.get(key);
      live.delete(key);
      await s?.close().catch(() => {});
      store.patchChat(key, slug, { sessionKey: undefined, cmdId: undefined }); // the sessionId stays: the next turn resumes
    },
    resumeInflightTurns,
    resumeQueuedTurns,
    trail: (turnId) => trails.get(turnId),
    ytDraft: (draftId) => drafts.get(draftId),
    usageReport: (days) => {
      const window = days * 24 * 3600_000;
      const records = usageLog.read(window);
      const cost = usageSummaryText(
        aggregateUsage(records, 'slug'),
        aggregateUsage(records, 'team'),
        days,
        aggregateUsage(records, 'routine'), // empty until the scheduler stamps routine turns
      );
      // Only live turns can be rated (dreams and /aven asks post no message), so they are
      // the honest denominator for coverage.
      const rateable = records.filter((r) => r.kind === 'turn').length;
      const value = feedbackSummaryText(joinUsage(feedbackLog.read(window), records), rateable, days);
      return `${cost}\n\n${value}`;
    },
    recordFeedback: (rec) => {
      feedbackLog.record(rec);
      return tallyFor(feedbackLog.forTurn(rec.turnId));
    },
    questions: {
      get: (qid) => pendingQuestions.get(qid),
      isCompleted: (qid) => completedQuestions.has(qid),
      answeredAll,
      finalize: finalizeQuestion,
    },
  };
}
