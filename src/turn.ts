// The turn engine: everything between "a question arrived" and "the answer message is
// final". Owns the live-session cache, the per-key turn queues + cancellation, the
// agent-question (AskUserQuestion) registry, and post-restart turn recovery. Slack
// surfaces (events.ts, commands.ts, pollers.ts) call in; rendering comes from blocks.ts.

import type bolt from '@slack/bolt';
import type { Config } from './config.js';
import type { Store } from './state.js';
import { resolveBySlug, type ProjectConfig, type RegistryRef } from './projects.js';
import { openChat, type ChatSession } from './tasks.js';
import { fallbackText, fmtElapsed, prUrls } from './format.js';
import type { AttachmentRef } from './attachments.js';
import type { AskQuestion, QuestionAnswers, OnQuestion } from './claudeSession.js';
import { MAX_SLACK_TEXT, answerBlocks, reportPostedBlocks, statusBlocks, questionBlocks, errText } from './blocks.js';
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
  resumeInflightTurns(client: bolt.webApi.WebClient): void;
  questions: QuestionRegistry;
  // A turn's tool-call trail (for the "🧭 Show steps" button) — live from the moment the
  // turn is queued, kept after it settles; undefined once evicted or after a restart.
  trail(turnId: string): TurnTrail | undefined;
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
  // persisted Claude conversation id.
  const live = new Map<string, ChatSession>();

  // Per-thread serialization: turns for the same key run one at a time (a chain of
  // promises). Cancellation: each turn has an AbortController keyed by a turnId carried
  // on its "✖ Cancel" button — cancel the running one and the next queued turn starts.
  const queues = new Map<string, Promise<void>>();
  const running = new Map<string, AbortController>();
  // Keys with a `runAsk` turn in flight (the /aven Q&A path and dreams). These bypass the
  // `queues` chain, so projectBusy() must consult this too — otherwise a dream wouldn't see a
  // live Q&A turn (or another dream) writing the same project's memory.
  const asking = new Set<string>();
  let turnSeq = 0;

  const pendingQuestions = new Map<string, PendingQuestion>();
  // qids that reached a terminal state normally (answered/submitted/canceled). A late
  // click on one of these is a no-op (the message already shows the right final state) —
  // distinct from an UNKNOWN qid (bot restart / genuinely old), which gets "expired".
  const completedQuestions = new Set<string>();
  let questionSeq = 0;

  // Tool-call trails, kept in memory for the "🧭 Show steps" button (events.ts opens them
  // in a modal on click). Registered the moment a turn is QUEUED — the status message
  // already carries the button, and a mid-run click must find the live trail ("no steps
  // yet"), not the "expired" fallback. Bounded — oldest evicted past the cap; a restart
  // loses them, and the button then degrades to an "expired" note, which is acceptable
  // for a peek-behind affordance.
  const trails = new Map<string, TurnTrail>();
  const MAX_TRAILS = 200;
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
    completedQuestions.add(qid);
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
            completedQuestions.add(qid);
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
    if (existing) return existing;
    const prior = store.getChat(key);
    const chat = await openChat(cfg, store, {
      slug: project.slug,
      repos: project.repos,
      resumeSessionId: prior?.sessionId,
      systemPrompt: project.systemPrompt,
      slackUrl,
      mcp: project.mcp,
      // Survive bot restarts: reattach to the command this thread was driving (if it's
      // still running), and persist the command coords the moment a session (re)opens so
      // even a crash mid-first-turn leaves a reattachable record.
      attach: prior?.sessionKey && prior?.cmdId ? { sessionKey: prior.sessionKey, cmdId: prior.cmdId } : undefined,
      onOpen: (info) => store.patchChat(key, project.slug, { sessionKey: info.sessionKey, cmdId: info.cmdId }),
    });
    live.set(key, chat);
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
    try {
      const chat = await sessionFor(key, project);
      const answer = await chat.ask(question);
      persist(key, project.slug, chat);
      return answer.slice(0, MAX_SLACK_TEXT) || '(no output)';
    } finally {
      asking.delete(key);
    }
  }

  // Map a conversation key back to its project slug. dm/cmd keys carry the slug as their
  // last segment (`dm:<channel>:<slug>`, `cmd:<user>:<slug>`); thread keys (`thread:<ts>`)
  // don't, so look the slug up in the persisted chat record.
  function slugForKey(key: string): string | undefined {
    if (key.startsWith('thread:')) return store.getChat(key)?.slug;
    const parts = key.split(':');
    return parts.length >= 3 ? parts[parts.length - 1] : undefined;
  }

  // True if any conversation for this project has a turn in flight right now — used to skip
  // a dream rather than race a live user turn on the project's memory files.
  function projectBusy(slug: string): boolean {
    for (const key of queues.keys()) if (slugForKey(key) === slug) return true;
    for (const key of asking) if (slugForKey(key) === slug) return true; // runAsk turns (Q&A, dreams)
    return false;
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
    const turnId = `t${++turnSeq}`;
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
    store.patchChat(key, project.slug, {
      inflight: { channel, statusTs: ts, msgThreadTs: threadTs, startedAt: new Date().toISOString() },
    });
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
    try {
      const chat = await sessionFor(key, project, slackUrl); // prepare (warm sandbox + clone) here
      // Download any inbound files into the sandbox first, then prepend a preamble naming their
      // paths so the agent Reads them. Best-effort: a failure here must not sink the whole turn.
      let prompt = question;
      if (attachments?.refs.length) {
        phase = '📎 Fetching attachments…';
        await flush(true);
        try {
          const preamble = await chat.ingest(attachments.refs, attachments.bearer, turnId);
          if (preamble) prompt = `${preamble}\n\n${question}`;
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
          chat.ask(
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
      if (chat.contextLost()) {
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
      const followUp = key.startsWith('thread:') ? { key, channel, threadTs } : undefined;
      // Suppress "Open a PR" once this thread has produced a PR in an earlier turn (latch below).
      const prCreated = store.getChat(key)?.prCreated === true;
      // Investigation thread → offer "📝 Report to YouTrack" (thread root ↔ ticket id via state).
      const inv = followUp ? store.investigationByRoot(key.slice('thread:'.length)) : undefined;
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
          blocks = answerBlocks(capped, { ytDraft: opts.ytDraftFor });
          blocks.push({
            type: 'context',
            elements: [{ type: 'mrkdwn', text: `⚠️ Auto-post failed: ${why.slice(0, 300)} — review and send manually.` }],
          });
        }
      }
      blocks ??= answerBlocks(capped, {
        followUp,
        prCreated,
        trail: { turnId, steps: steps.length, elapsedMs },
        ytReport: inv?.id,
        ytDraft: opts?.ytDraftFor,
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
  function resumeInflightTurns(client: bolt.webApi.WebClient): void {
    for (const chat of store.allChats()) {
      const inf = chat.inflight;
      if (!inf || !chat.sessionKey || !chat.cmdId) continue;
      const project = resolveBySlug(reg.current, chat.slug);
      if (!project) {
        store.patchChat(chat.threadTs, chat.slug, { inflight: undefined });
        continue;
      }
      void (async () => {
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
    resumeInflightTurns,
    trail: (turnId) => trails.get(turnId),
    questions: {
      get: (qid) => pendingQuestions.get(qid),
      isCompleted: (qid) => completedQuestions.has(qid),
      answeredAll,
      finalize: finalizeQuestion,
    },
  };
}
