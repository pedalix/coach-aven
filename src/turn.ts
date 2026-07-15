// The turn engine: everything between "a question arrived" and "the answer message is
// final". Owns the live-session cache, the per-key turn queues + cancellation, the
// agent-question (AskUserQuestion) registry, and post-restart turn recovery. Slack
// surfaces (events.ts, commands.ts, pollers.ts) call in; rendering comes from blocks.ts.

import type bolt from '@slack/bolt';
import type { Config } from './config.js';
import type { Store } from './state.js';
import { resolveBySlug, type ProjectConfig, type RegistryRef } from './projects.js';
import { openChat, type ChatSession } from './tasks.js';
import { createDriver } from './driver.js';
import { fallbackText, fmtElapsed, prUrls } from './format.js';
import { skippedNotice, type AttachmentRef } from './attachments.js';
import type { AskQuestion, QuestionAnswers, OnQuestion } from './claudeSession.js';
import { MAX_SLACK_TEXT, answerBlocks, reportPostedBlocks, statusBlocks, questionBlocks, errText } from './blocks.js';
import { QueueJournal } from './queuejournal.js';
import { isThreadKey, threadRoot, slugOfBase } from './teamkeys.js';
import { DraftStore } from './drafts.js';
import { UsageLog, aggregateUsage, usageSummaryText } from './metering.js';
import { log } from './log.js';
import { captureError, Sentry } from './sentry.js';

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

// Resolves the Slack client for a tenant (undefined = home). Throws for a tenant with
// no live installation — recovery treats that per record, never letting one uninstalled
// workspace abort the whole resume loop.
export type ClientForTeam = (tenantId?: string) => bolt.webApi.WebClient;

export interface TurnEngine {
  // Enqueue a live-status turn (the normal path for mentions, DMs, buttons, pollers).
  liveTurn(
    client: bolt.webApi.WebClient,
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
  projectBusy(slug: string): boolean;
  slugForKey(key: string): string | undefined;
  // "🔄 Restart session" → kill this thread's Claude conversation (live or persisted) and
  // clear its session fields, so the next liveTurn/runAsk on this key starts fresh.
  restartSession(key: string, project: ProjectConfig): Promise<void>;
  // Startup recovery, in order: reattach + finalize turns that were RUNNING at the last
  // stop (returns per-key promises so queued replays can wait their turn), then replay the
  // journaled turns that were still QUEUED (their user messages would otherwise be lost).
  resumeInflightTurns(clientFor: ClientForTeam): Map<string, Promise<void>>;
  resumeQueuedTurns(clientFor: ClientForTeam, recovering: Map<string, Promise<void>>): void;
  questions: QuestionRegistry;
  // A turn's tool-call trail (for the "🧭 Show steps" button) — live from the moment the
  // turn is queued, kept after it settles; undefined once evicted or after a restart.
  trail(turnId: string): TurnTrail | undefined;
  // A report-draft turn's answer text (for "✏️ Edit & send"), stored on disk
  // (drafts/<slug>/<turnId>.md) so it survives restarts; undefined once pruned past the
  // per-project cap — the click then gets the "draft expired" modal.
  ytDraft(draftId: string): string | undefined;
  // Token/cost/turn summary over the last N days (mrkdwn, for `/aven usage`).
  usageReport(days: number): string;
}

// Per-turn behavior switches. `ytDraftFor` marks a "📝 Report to YouTrack" draft turn: the
// answer renders as an editable ticket-comment draft (Edit & send button) instead of the
// normal follow-up buttons — see answerBlocks' ytDraft mode. `autoPost` (the modal's
// "post immediately" checkbox) delivers the answer straight to its destination — supplied as
// a callback by events.ts so the turn engine stays ignorant of YouTrack; when it throws, the
// answer degrades to the reviewable draft with the error attached (never silently lost).
export interface TurnOpts {
  ytDraftFor?: string;
  autoPost?: (text: string) => Promise<{ url: string; group: string }>;
}

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

export function createTurnEngine(cfg: Config, store: Store, reg: RegistryRef): TurnEngine {
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
  // Keys with a `runAsk` turn in flight (the /aven Q&A path and dreams). These bypass the
  // `queues` chain, so projectBusy() must consult this too — otherwise a dream wouldn't see a
  // live Q&A turn (or another dream) writing the same project's memory.
  const asking = new Set<string>();

  // Global concurrency cap on agent turns (multi-tenancy slice 4, "capacity"): pollers ×
  // channels × clients can otherwise stampede the sandbox fleet and the provider API.
  // Per-key queues serialize WITHIN a conversation; this caps ACROSS them. Waiting turns
  // show "⏳ waiting for a free agent slot" on their status message.
  const MAX_TURNS = Math.max(1, Math.floor(Number(process.env.TURN_MAX_CONCURRENT)) || 4);
  let turnSlots = MAX_TURNS;
  const slotWaiters: (() => void)[] = [];
  function acquireSlot(): Promise<void> {
    if (turnSlots > 0) {
      turnSlots--;
      return Promise.resolve();
    }
    return new Promise((resolve) => slotWaiters.push(resolve));
  }
  function releaseSlot(): void {
    const next = slotWaiters.shift();
    if (next) next(); // hand the slot over directly — turnSlots stays 0
    else turnSlots++;
  }

  // Per-turn token/cost accounting → usage/<month>.jsonl (multi-tenancy slice 4,
  // "whose tokens are we burning"). Best-effort by construction — see metering.ts.
  const usageLog = new UsageLog();

  // turnIds carry a per-boot prefix: they used to be `t<seq>` and reset every restart,
  // which was fine while everything keyed by them was in-memory — but drafts now live on
  // disk, and boot #2's t5 must not collide with (and clobber) boot #1's t5.
  const bootId = Date.now().toString(36);
  let turnSeq = 0;

  // Journal of queued-but-not-yet-started turns (its own file, not state.json — see
  // queuejournal.ts). Entries: added in liveTurn, retired in doTurn once the chat
  // record's `inflight` marker takes over recovery duty. Drained by resumeQueuedTurns.
  const journal = new QueueJournal();

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
  const drafts = new DraftStore();
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
    client: bolt.webApi.WebClient,
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
          const posted = await client.chat.postMessage({
            channel,
            thread_ts: threadTs,
            text: '❓ The agent has a question',
            blocks: questionBlocks(questions, new Map(), multi, qid, false),
          });
          const entry: PendingQuestion = {
            questions,
            picks: new Map(),
            multi,
            resolve,
            channel,
            ts: posted.ts as string,
            done: false,
          };
          pendingQuestions.set(qid, entry);
          // Abort on EITHER the turn cancel (✖ Cancel) OR this question being withdrawn
          // by claude (control_cancel_request → toolSignal).
          const onAbort = () => {
            if (entry.done || !pendingQuestions.delete(qid)) return;
            entry.done = true;
            markCompleted(qid);
            void client.chat
              .update({ channel, ts: entry.ts, text: '🚫 Canceled', blocks: [] })
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
    const chat = await openChat(cfg, store, {
      slug: project.slug,
      repos: project.repos,
      resumeSessionId: prior?.sessionId,
      systemPrompt: project.systemPrompt,
      slackUrl,
      mcp: project.mcp,
      driver: project.driver,
      // Survive bot restarts: reattach to the command this thread was driving (if it's
      // still running), and persist the command coords the moment a session (re)opens so
      // even a crash mid-first-turn leaves a reattachable record.
      attach: prior?.sessionKey && prior?.cmdId ? { sessionKey: prior.sessionKey, cmdId: prior.cmdId } : undefined,
      onOpen: (info) => store.patchChat(key, project.slug, { sessionKey: info.sessionKey, cmdId: info.cmdId }),
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
    store.patchChat(key, project.slug, { sessionId: undefined, sessionKey: undefined, cmdId: undefined });
  }

  // Add/remove a reaction; non-fatal (already_reacted / no_reaction / missing scope).
  async function react(
    client: bolt.webApi.WebClient,
    channel: string,
    ts: string,
    name: string,
    op: 'add' | 'remove',
  ): Promise<void> {
    try {
      if (op === 'add') await client.reactions.add({ channel, timestamp: ts, name });
      else await client.reactions.remove({ channel, timestamp: ts, name });
    } catch {
      /* non-fatal */
    }
  }

  // A message starting with this prefix is a human-only NOTE: the bot stays out entirely
  // (no turn, no agent run), just a quiet reaction to confirm it saw and skipped it. Lets
  // you jot something for yourself or a colleague mid-thread without triggering Claude.
  // `!`, not `/`-anything: a leading `/` collides with Slack's slash-command UI.
  const NOTE_PREFIX = process.env.SLACK_NOTE_PREFIX || '!';
  const NOTE_REACTION = process.env.SLACK_NOTE_REACTION || 'shushing_face';
  const isNote = (text: string): boolean => text.trim().startsWith(NOTE_PREFIX);

  // Enqueue a turn for `key` and post its status message immediately (so a queued turn
  // shows "in queue" right away). Turns for the same key run strictly one at a time;
  // canceling the running one lets the next start. msgTs is the user's message to react
  // to (undefined for /aven).
  async function liveTurn(
    client: bolt.webApi.WebClient,
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
      if (msgTs) await react(client, channel, msgTs, NOTE_REACTION, 'add');
      return;
    }
    if (msgTs) await react(client, channel, msgTs, 'eyes', 'add');
    const turnId = `t${bootId}-${++turnSeq}`;
    const ac = new AbortController();
    running.set(turnId, ac);
    // Register the (empty) trail NOW: the status message below already carries a live
    // "🧭 Show steps" button, and a click while the turn is still queued must find an
    // entry ("no steps yet"), not the "expired after a restart" fallback.
    startTrail(turnId);

    const busy = queues.has(key);
    const posted = await client.chat.postMessage({
      channel,
      thread_ts: threadTs,
      text: busy ? 'In queue…' : 'Working…',
      blocks: statusBlocks(
        busy ? '⏳ In queue — waiting for the previous message…' : `🛠 Preparing…  ·  ${ETA_HINT}`,
        turnId,
      ),
    });
    const ts = posted.ts as string;

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
      plain: !attachments?.refs.length && !opts,
    });

    const prev = queues.get(key) ?? Promise.resolve();
    const mine = prev
      .catch(() => {})
      .then(() => doTurn(client, channel, msgTs, threadTs, ts, key, project, question, turnId, ac, attachments, opts));
    queues.set(key, mine);
    void mine.finally(() => {
      running.delete(turnId);
      if (queues.get(key) === mine) queues.delete(key);
    });
    return mine;
  }

  // The actual work for one turn, run after any earlier turn for the same key. Streams
  // live status into the message `ts` and rewrites it into the answer (or cancel/error).
  async function doTurn(
    client: bolt.webApi.WebClient,
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
    const clearEyes = async () => {
      if (msgTs) await react(client, channel, msgTs, 'eyes', 'remove');
    };
    if (ac.signal.aborted) {
      journal.done(turnId); // canceled while queued — settled, nothing to replay
      await client.chat.update({ channel, ts, text: '🚫 Canceled', blocks: [] });
      await clearEyes();
      return;
    }

    // Global turn cap. If no slot is free, say so on the status message (otherwise the
    // wait reads as a mysteriously long "Preparing…"), then block until one frees up.
    if (turnSlots <= 0) {
      await client.chat
        .update({ channel, ts, text: 'In queue…', blocks: statusBlocks('⏳ Waiting for a free agent slot…', turnId) })
        .catch(() => {});
    }
    await acquireSlot();
    if (ac.signal.aborted) {
      // Canceled while waiting for a slot — same settle as canceled-while-queued.
      releaseSlot();
      journal.done(turnId);
      await client.chat.update({ channel, ts, text: '🚫 Canceled', blocks: [] });
      await clearEyes();
      return;
    }

    const start = Date.now();
    let phase = '🛠 Preparing sandbox…';
    // Registered when the turn was queued; the array is shared, so every push below shows
    // up in an already-open "🧭 Show steps" modal on its next open. (?? covers a doTurn
    // reached without liveTurn, e.g. future call sites.)
    const trail = trails.get(turnId) ?? startTrail(turnId);
    const steps = trail.steps;
    let lastRendered = '';
    let lastUpdateAt = 0;
    let finished = false;

    const render = (): string => {
      const elapsed = Date.now() - start;
      const head = `${phase}  ⏱ ${fmtElapsed(elapsed)}${elapsed < ETA_HINT_MS ? `  ·  ${ETA_HINT}` : ''}`;
      const tail = steps.slice(-6).join('\n');
      return tail ? `${head}\n${tail}` : head;
    };
    const flush = async (force = false): Promise<void> => {
      if (finished) return;
      const now = Date.now();
      if (!force && now - lastUpdateAt < 1500) return; // throttle chat.update
      const text = render();
      if (text === lastRendered) return;
      lastRendered = text;
      lastUpdateAt = now;
      try {
        await client.chat.update({ channel, ts, text, blocks: statusBlocks(text, turnId) });
      } catch {
        /* rate limit / transient — next tick retries */
      }
    };
    const heartbeat = setInterval(() => void flush(), 4000);
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
    let slackUrl: string | undefined;
    if (threadTs) {
      try {
        const pl = await client.chat.getPermalink({ channel, message_ts: threadTs });
        slackUrl = pl.permalink as string | undefined;
      } catch {
        /* no permalink (DM / missing scope) — traceability line is simply omitted */
      }
    }
    let chat: ChatSession | undefined; // hoisted so the finally can read lastUsage()
    let outcome: 'ok' | 'error' | 'canceled' = 'ok';
    try {
      const live = await sessionFor(key, project, slackUrl); // prepare (warm sandbox + clone) here
      chat = live; // `live` keeps the non-undefined narrowing inside the closures below
      // Download any inbound files into the sandbox first, then prepend a preamble naming their
      // paths so the agent Reads them. Best-effort: a failure here must not sink the whole turn.
      let prompt = question;
      if (attachments?.refs.length) {
        phase = '📎 Fetching attachments…';
        await flush(true);
        try {
          const { preamble, skipped } = await live.ingest(attachments.refs, attachments.bearer, turnId);
          if (preamble) prompt = `${preamble}\n\n${question}`;
          // Unusable files get a DETERMINISTIC reply in the thread — the preamble only tells
          // the agent, and whether the model relays a skip is up to it. Best-effort: a failed
          // notice must not sink the turn.
          if (skipped.length) {
            await client.chat
              .postMessage({ channel, thread_ts: threadTs, text: skippedNotice(skipped) })
              .catch((e) => log.error(`skip notice ${turnId}: ${e instanceof Error ? e.message : String(e)}`));
          }
        } catch (e) {
          log.error(`ingest ${turnId}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      phase = '🔎 Working…';
      await flush(true);
      // Wrap the agent turn in a Sentry span so turn latency shows up in performance (no-op
      // tracing when Sentry is off — startSpan still runs the callback).
      const answer = await Sentry.startSpan(
        { name: 'aven.turn', op: 'gen_ai.invoke_agent', attributes: { 'aven.project': project.slug } },
        () =>
          live.ask(
            prompt,
            (step) => {
              steps.push(step);
              void flush();
            },
            ac.signal,
            makeOnQuestion(client, channel, threadTs, ac.signal, (qid) => turnQs.add(qid)),
          ),
      );
      persist(key, project.slug, chat);
      if (live.contextLost()) {
        await client.chat
          .postMessage({
            channel,
            thread_ts: threadTs,
            text: '⚠️ Lost the previous session context (the sandbox was rebuilt) — starting fresh.',
          })
          .catch(() => {});
      }
      finished = true;
      clearInterval(heartbeat);
      const capped = answer.slice(0, MAX_SLACK_TEXT) || '(no output)';
      // Offer the "Open a PR" follow-up only in build channels (thread sessions), not in
      // the private /aven + DM Q&A paths where it would just be noise.
      const followUp = isThreadKey(key) ? { key, channel, threadTs } : undefined;
      // Suppress "Open a PR" once this thread has produced a PR in an earlier turn (latch below).
      const prCreated = store.getChat(key)?.prCreated === true;
      // Investigation thread → offer "📝 Report to YouTrack" (thread root ↔ ticket id via state).
      const inv = followUp ? store.investigationByRoot(threadRoot(key) ?? '') : undefined;
      const elapsedMs = Date.now() - start;
      // Skip-preview draft: deliver the answer directly (the autoPost hook), and only fall
      // back to the reviewable draft — error attached — when delivery fails.
      let blocks: ReturnType<typeof answerBlocks> | undefined;
      let text = fallbackText(capped);
      if (opts?.ytDraftFor && opts.autoPost) {
        try {
          const posted = await opts.autoPost(capped);
          blocks = reportPostedBlocks(capped, opts.ytDraftFor, posted.url, posted.group);
          text = `✅ Reported to ${opts.ytDraftFor}`;
        } catch (e) {
          const why = e instanceof Error ? e.message : String(e);
          drafts.put(project.slug, turnId, capped); // manual retry needs the text
          blocks = answerBlocks(capped, { ytDraft: { ticket: opts.ytDraftFor, draftId: turnId } });
          blocks.push({
            type: 'context',
            elements: [{ type: 'mrkdwn', text: `⚠️ Auto-post failed: ${why.slice(0, 300)} — review and send manually.` }],
          });
        }
      }
      if (opts?.ytDraftFor && !blocks) drafts.put(project.slug, turnId, capped);
      blocks ??= answerBlocks(capped, {
        followUp,
        prCreated,
        trail: { turnId, steps: steps.length, elapsedMs },
        ytReport: inv?.id,
        ytDraft: opts?.ytDraftFor ? { ticket: opts.ytDraftFor, draftId: turnId } : undefined,
      });
      await client.chat.update({ channel, ts, text, blocks });
      // Latch the flag the first turn whose answer carries a PR URL, so subsequent turns in
      // this thread stop offering the button. "View PR" still shows per-message on any answer
      // that contains a URL, so we're only dropping the redundant "Open a PR" prompt.
      if (!prCreated && prUrls(capped).length) store.patchChat(key, project.slug, { prCreated: true });
      if (msgTs) {
        await react(client, channel, msgTs, 'eyes', 'remove');
        await react(client, channel, msgTs, 'white_check_mark', 'add');
      }
    } catch (err) {
      finished = true;
      clearInterval(heartbeat);
      outcome = ac.signal.aborted ? 'canceled' : 'error';
      if (ac.signal.aborted) {
        await client.chat.update({ channel, ts, text: '🚫 Canceled', blocks: [] });
        await clearEyes();
      } else {
        await client.chat.update({ channel, ts, text: errText(err), blocks: [] });
        if (msgTs) {
          await react(client, channel, msgTs, 'eyes', 'remove');
          await react(client, channel, msgTs, 'x', 'add');
        }
      }
    } finally {
      releaseSlot();
      // Meter the turn (even canceled/errored ones — tokens may have burned before the
      // interrupt; a turn that died before sessionFor simply records no usage).
      usageLog.record({
        at: new Date().toISOString(),
        key,
        slug: project.slug,
        kind: 'turn',
        status: outcome,
        elapsedMs: Date.now() - start,
        usage: chat?.lastUsage(),
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
          await client.chat
            .update({ channel: entry.channel, ts: entry.ts, text: '⌛ Question closed', blocks: [] })
            .catch(() => {});
        }
      }
    }
  }

  // On startup, finalize any turn that was still "Working…" when the bot last stopped:
  // reattach to its command (still running, or finished during the downtime) and rewrite
  // its status message with the recovered result. Best-effort, per chat, never blocks.
  // Returns each chat's recovery promise keyed by conversation key, so resumeQueuedTurns
  // can hold a key's replays until its running turn has been recovered (else the replay
  // hits the still-busy session and errors).
  function resumeInflightTurns(clientFor: ClientForTeam): Map<string, Promise<void>> {
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
      let client: bolt.webApi.WebClient;
      try {
        client = clientFor(chat.teamId);
      } catch (e) {
        log.error(`resume ${chat.threadTs}: ${e instanceof Error ? e.message : String(e)}`);
        store.patchChat(chat.threadTs, chat.slug, { inflight: undefined });
        continue;
      }
      const recovery = (async () => {
        try {
          await client.chat
            .update({
              channel: inf.channel,
              ts: inf.statusTs,
              text: '🔄 Reconnected after a restart — recovering this turn…',
              blocks: [],
            })
            .catch(() => {});
          const cs = await sessionFor(chat.threadTs, project);
          const r = await cs.adoptInflight();
          persist(chat.threadTs, project.slug, cs);
          if (r.ok) {
            const capped = r.text.slice(0, MAX_SLACK_TEXT) || '(no output)';
            await client.chat.update({
              channel: inf.channel,
              ts: inf.statusTs,
              text: fallbackText(capped),
              blocks: answerBlocks(capped),
            });
            // A recovered turn may have opened the PR — latch so the next live turn hides "Open a PR".
            if (!chat.prCreated && prUrls(capped).length)
              store.patchChat(chat.threadTs, project.slug, { prCreated: true });
          } else {
            await client.chat.update({
              channel: inf.channel,
              ts: inf.statusTs,
              text: `⚠️ The bot restarted mid-turn and couldn't recover the live result (${r.status}). The work may have finished in the thread or a PR — send a new message to continue.`,
              blocks: [],
            });
          }
        } catch (e) {
          // A recovery failure was previously swallowed (user saw a warning, Sentry saw
          // nothing). Raise an issue so lost turns are visible in ops.
          log.error(`resume ${chat.threadTs}: ${e instanceof Error ? e.message : String(e)}`);
          captureError(e, { subsystem: 'resume', thread: chat.threadTs, slug: chat.slug });
          await client.chat
            .update({
              channel: inf.channel,
              ts: inf.statusTs,
              text: "⚠️ The bot restarted mid-turn; couldn't recover this status. Send a new message to continue.",
              blocks: [],
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

  // Replay the journaled turns that were still QUEUED (accepted, never started) at the
  // last stop — the one class of turn that used to vanish silently, leaving its "In
  // queue…" message frozen. Plain turns re-run automatically; turns that carried
  // attachments or engine-side callbacks (a YT draft's autoPost) can't be reconstructed,
  // so their status message quotes the question and asks for a resend — visibly lost
  // beats silently lost. Keys are processed sequentially (preserving enqueue order),
  // after any inflight recovery on the same key has settled.
  function resumeQueuedTurns(clientFor: ClientForTeam, recovering: Map<string, Promise<void>>): void {
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
          // Pre-liveTurn tenant check (skip, not throw): a replay for an uninstalled
          // workspace has no token to even rewrite its status message with.
          let client: bolt.webApi.WebClient;
          try {
            client = clientFor(e.teamId);
          } catch (err) {
            log.error(`replay ${e.turnId}: ${err instanceof Error ? err.message : String(err)}`);
            continue;
          }
          try {
            if (project && e.plain) {
              await client.chat
                .update({
                  channel: e.channel,
                  ts: e.statusTs,
                  text: '🔄 The bot restarted before this turn could start — rerunning it below.',
                  blocks: [],
                })
                .catch(() => {});
              // Awaiting completion serializes this key's replays — the same order the
              // queue would have run them in.
              await liveTurn(client, e.channel, e.msgTs, e.threadTs, e.key, project, e.question);
            } else {
              const why = project
                ? "its attachments/context can't be replayed"
                : 'its project is no longer configured';
              await client.chat
                .update({
                  channel: e.channel,
                  ts: e.statusTs,
                  text: `⚠️ The bot restarted before this message was processed and ${why} — please resend it:\n> ${e.question.slice(0, 500)}`,
                  blocks: [],
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
    projectBusy,
    slugForKey,
    restartSession,
    resumeInflightTurns,
    resumeQueuedTurns,
    trail: (turnId) => trails.get(turnId),
    ytDraft: (draftId) => drafts.get(draftId),
    usageReport: (days) => {
      const records = usageLog.read(days * 24 * 3600_000);
      return usageSummaryText(aggregateUsage(records, 'slug'), aggregateUsage(records, 'team'), days);
    },
    questions: {
      get: (qid) => pendingQuestions.get(qid),
      isCompleted: (qid) => completedQuestions.has(qid),
      answeredAll,
      finalize: finalizeQuestion,
    },
  };
}
