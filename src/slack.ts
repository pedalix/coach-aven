import bolt from '@slack/bolt';
import type { Config } from './config.js';
import { Store, type RoutineRecord, type PrWatch } from './state.js';
import {
  loadProjects,
  resolveByChannel,
  resolveBySlug,
  type ProjectConfig,
  type ProjectsRegistry,
} from './projects.js';
import { openChat, type ChatSession } from './tasks.js';
import { parseSchedule, dueRoutines, groupRoutinesBySlug } from './schedule.js';
import { prUrls, fallbackText, fmtElapsed, stripMention, mdToMrkdwn, parseTopics } from './format.js';
import { resolvePr, prsToReview, autofixEvents } from './pr.js';
import {
  reviewPrompt,
  autofixPrompt,
  REPORT_FRAMING,
  FOLLOW_UP_PR_PROMPT,
  parseEffort,
  type ReviewEffort,
} from './prompts.js';
import { makeDaytona, listSandboxStates, exec } from './daytona.js';
import { projectCwd } from './project.js';
import { memoryFilePath } from './memory.js';
import { dreamPrompt, dreamDigest } from './dream.js';
import { snapshotMemory, memoryRepoDir, readSnapshotFile, snapshotLog } from './memjournal.js';
import { countOpenPRs, listOpenPRs, getPrMeta, ciStatusForSha, listReviews } from './github.js';
import type { AskQuestion, QuestionAnswers, OnQuestion } from './claudeSession.js';
import { log } from './log.js';
import { captureError, Sentry } from './sentry.js';

const { App } = bolt;

// Slack hard-caps a single message at 40k chars; leave headroom.
const MAX_SLACK_TEXT = 39000;
const THINKING = ':hourglass_flowing_sand: thinking…';

// The slash command this bot answers to. DEV runs a SEPARATE Slack app in the same
// workspace (e.g. devcoachaven), and Slack forbids two apps owning the same command — so
// dev sets SLACK_COMMAND (e.g. /dev-aven) to match its app's manifest. Default: /aven.
// Used for both the Bolt registration and every user-facing help string.
const CMD = ((c) => (c.startsWith('/') ? c : `/${c}`))((process.env.SLACK_COMMAND || '/aven').trim());

// One Slack bot, MANY channels. Each channel is bound to a project (channel = context =
// the project's own isolated sandbox, proj-<slug>); naming convention bluefin-{project}.
// The channel determines which repo the bot works against. Two modes:
//   • @mention / thread reply → public, shared thread (collaborate, build features)
//   • /aven slash / DM        → private answer (quick Q&A)
// Each thread/DM is its own Claude session (no shared context), resumed via --resume.
export async function runSlack(cfg: Config): Promise<void> {
  if (!cfg.slack) {
    throw new Error('Set SLACK_BOT_TOKEN and SLACK_APP_TOKEN to run the Slack bot.');
  }
  const registry = loadProjects(cfg.projectsConfigPath);
  const store = new Store();
  const app = new App({
    token: cfg.slack.botToken,
    appToken: cfg.slack.appToken,
    socketMode: true,
  });

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

  // Operator error alerts → a Slack channel (set AVEN_ALERT_CHANNEL to a channel id the bot is
  // in). Free-tier Sentry can't alert to Slack; the bot is already a Slack app, so it self-reports.
  // Best-effort + deduped (skip a repeat of the same message within the window) to avoid storms.
  const ALERT_CHANNEL = process.env.AVEN_ALERT_CHANNEL;
  const ALERT_DEDUPE_MS = 60_000;
  const recentAlerts = new Map<string, number>();
  if (ALERT_CHANNEL) {
    alertSink = (text: string) => {
      const now = Date.now();
      const last = recentAlerts.get(text);
      if (last && now - last < ALERT_DEDUPE_MS) return; // same error just posted — skip
      recentAlerts.set(text, now);
      if (recentAlerts.size > 200) recentAlerts.clear(); // bound the map
      void app.client.chat
        .postMessage({ channel: ALERT_CHANNEL, text: `:rotating_light: CoachAven error: ${text}`.slice(0, 2000) })
        .catch(() => {}); // never let an alert failure cascade (no log.error here → no loop)
    };
  }

  // Scheduled report jobs: dedupe a routine to one fire per matched wall-clock minute
  // (overlapping ticks / a quick restart shouldn't double-post). Maps routine id → the
  // "month-day hh:mm" it last fired on.
  const firedThisMinute = new Map<string, string>();

  // DM project picks awaiting a dropdown choice: a DM with no project hint posts a picker;
  // the original question is parked here under a short id until the user selects a project.
  const pendingDmPicks = new Map<string, { channel: string; user: string; question: string }>();
  let dmPickSeq = 0;

  // Pending AskUserQuestion prompts: the agent asked, we posted option buttons, and
  // we're waiting for clicks. Keyed by a questionId carried on each button. `picks` maps
  // a question index → the set of selected option indices (single-select = a set of 1).
  interface PendingQuestion {
    questions: AskQuestion[];
    picks: Map<number, Set<number>>;
    multi: boolean; // any question is multiSelect → needs an explicit Submit
    resolve: (a: QuestionAnswers) => void;
    channel: string;
    ts: string;
    done: boolean;
  }
  const pendingQuestions = new Map<string, PendingQuestion>();
  // qids that reached a terminal state normally (answered/submitted/canceled). A late
  // click on one of these is a no-op (the message already shows the right final state) —
  // distinct from an UNKNOWN qid (bot restart / genuinely old), which gets "expired".
  const completedQuestions = new Set<string>();
  let questionSeq = 0;

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

  // Channels auto-bind by name: a channel named `${CHANNEL_PREFIX}<slug>` (e.g.
  // bluefin-aven-caldora) maps to the project with that slug — no channel ids to wire.
  // An explicit `slackChannel` id in the registry still overrides. Names cached per id.
  const CHANNEL_PREFIX = process.env.SLACK_CHANNEL_PREFIX || 'bluefin-aven-';
  const nameCache = new Map<string, string | undefined>();
  async function channelName(
    client: bolt.webApi.WebClient,
    channelId: string,
  ): Promise<string | undefined> {
    if (nameCache.has(channelId)) return nameCache.get(channelId);
    let name: string | undefined;
    try {
      const r = await client.conversations.info({ channel: channelId });
      name = (r.channel as { name?: string } | undefined)?.name;
    } catch {
      name = undefined; // DM / no access
    }
    nameCache.set(channelId, name);
    return name;
  }

  // Resolve the project for a turn: explicit channel-id binding wins → else the
  // `bluefin-aven-<slug>` channel-name wildcard → else a leading <slug> token (handy in
  // DMs) → else the sole project. Returns an error listing slugs when ambiguous.
  async function pickProject(
    client: bolt.webApi.WebClient,
    channel: string,
    text: string,
  ): Promise<{ project?: ProjectConfig; question: string; error?: string }> {
    let project = resolveByChannel(registry, channel);
    let question = text.trim();
    if (!project) {
      const name = await channelName(client, channel);
      if (name && name.startsWith(CHANNEL_PREFIX)) {
        project = resolveBySlug(registry, name.slice(CHANNEL_PREFIX.length));
      }
    }
    if (!project) {
      const m = question.match(/^(\S+)\s+([\s\S]+)$/);
      if (m) {
        const bySlug = resolveBySlug(registry, m[1]);
        if (bySlug) {
          project = bySlug;
          question = m[2].trim();
        }
      }
    }
    if (!project && registry.projects.length === 1) project = registry.projects[0];
    if (!project) {
      const slugs = registry.projects.map((p) => p.slug).join(', ');
      return {
        question,
        error: `This channel isn't bound to a project. Use a \`${CHANNEL_PREFIX}{project}\` channel (e.g. \`${CHANNEL_PREFIX}${registry.projects[0]?.slug ?? 'caldora'}\`), or prefix your question with a slug — one of: ${slugs}.`,
      };
    }
    return { project, question };
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

  // Read a file from a project's Claude Code auto-memory dir (the sandbox copy). By default
  // we do NOT wake a stopped sandbox — this box can't run the whole fleet warm, so forcing a
  // start just to read can fail under resource pressure (and it's slow). `wake` (only set by
  // `/aven memory live`) opts into starting it. `filePath` is already sanitized. Raw Daytona
  // errors are wrapped so the user never sees an axios 500. Throws a friendly message otherwise.
  async function readMemory(project: ProjectConfig, filePath: string, wake: boolean): Promise<string> {
    const daytona = makeDaytona(cfg);
    const name = `${cfg.sandbox.namePrefix}${project.slug}`;
    let sandbox = await daytona.get(name).catch(() => {
      throw new Error('No sandbox for this project yet — nothing remembered.');
    });
    if (sandbox.state !== 'started') {
      if (!wake) {
        throw new Error(
          `💤 The *${project.slug}* sandbox is asleep, so I can't read its live memory right now. ` +
            `Use \`${CMD} memory live\` to wake it, or just @-mention me — and once a dream runs, ` +
            `\`${CMD} memory\` serves the snapshot without waking it.`,
        );
      }
      try {
        await daytona.start(sandbox, 180);
        sandbox = await daytona.get(name);
      } catch (e) {
        log.error(`readMemory start ${name}: ${e instanceof Error ? e.message : String(e)}`);
        throw new Error(`Couldn't wake the *${project.slug}* sandbox just now — try again in a moment.`);
      }
    }
    let r;
    try {
      r = await exec(sandbox, `cat ${filePath} 2>/dev/null || true`);
    } catch (e) {
      log.error(`readMemory exec ${name}: ${e instanceof Error ? e.message : String(e)}`);
      throw new Error(`Couldn't read memory from the *${project.slug}* sandbox just now — try again in a moment.`);
    }
    const out = (r.result ?? '').trim().slice(0, MAX_SLACK_TEXT);
    if (!out) throw new Error('Nothing remembered yet for this project.');
    return out;
  }

  // Map a conversation key back to its project slug. dm/cmd keys carry the slug as their
  // last segment (`dm:<channel>:<slug>`, `cmd:<user>:<slug>`); thread keys (`thread:<ts>`)
  // don't, so look the slug up in the persisted chat record.
  function slugForKey(key: string): string | undefined {
    if (key.startsWith('thread:')) return store.getChat(key)?.slug;
    const parts = key.split(':');
    return parts.length >= 3 ? parts[parts.length - 1] : undefined;
  }

  // Gather a live snapshot for `/aven status`: per-project sandbox state (Daytona),
  // session count (state.json), conversations with a turn in flight (the in-memory
  // queues), and open-PR counts (GitHub). Every external call is best-effort so a single
  // failing dependency degrades to a ⚠️ rather than erroring the whole command.
  async function collectStatus(): Promise<StatusReport> {
    const activeBySlug = new Map<string, number>();
    for (const key of queues.keys()) {
      const slug = slugForKey(key);
      if (slug) activeBySlug.set(slug, (activeBySlug.get(slug) ?? 0) + 1);
    }
    const sessionsBySlug = new Map<string, number>();
    for (const c of store.allChats()) sessionsBySlug.set(c.slug, (sessionsBySlug.get(c.slug) ?? 0) + 1);

    let states = new Map<string, string>();
    let daytonaOk = true;
    try {
      states = await listSandboxStates(makeDaytona(cfg));
    } catch {
      daytonaOk = false;
    }

    const prCounts = await Promise.all(
      registry.projects.map((p) => countOpenPRs(cfg, p.repos).catch(() => undefined)),
    );
    const githubOk = prCounts.some((n) => n !== undefined);

    // Routine counts per project (report jobs vs dream jobs) for the at-a-glance status line.
    const jobsBySlug = new Map<string, { jobs: number; dreams: number }>();
    for (const r of store.listRoutines()) {
      const c = jobsBySlug.get(r.slug) ?? { jobs: 0, dreams: 0 };
      if (r.kind === 'dream') c.dreams++;
      else c.jobs++;
      jobsBySlug.set(r.slug, c);
    }

    const projects: ProjectStatus[] = registry.projects.map((p, i) => ({
      slug: p.slug,
      repos: p.repos.length,
      state: states.get(`${cfg.sandbox.namePrefix}${p.slug}`),
      sessions: sessionsBySlug.get(p.slug) ?? 0,
      active: activeBySlug.get(p.slug) ?? 0,
      openPRs: prCounts[i],
      jobs: jobsBySlug.get(p.slug)?.jobs ?? 0,
      dreams: jobsBySlug.get(p.slug)?.dreams ?? 0,
    }));
    return { projects, turnsInFlight: running.size, daytonaOk, githubOk };
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

    const busy = queues.has(key);
    const posted = await client.chat.postMessage({
      channel,
      thread_ts: threadTs,
      text: busy ? 'In queue…' : 'Working…',
      blocks: statusBlocks(
        busy ? '⏳ In queue — waiting for the previous message…' : '🛠 Preparing…',
        turnId,
      ),
    });
    const ts = posted.ts as string;

    const prev = queues.get(key) ?? Promise.resolve();
    const mine = prev
      .catch(() => {})
      .then(() => doTurn(client, channel, msgTs, threadTs, ts, key, project, question, turnId, ac));
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
    const steps: string[] = [];
    let lastRendered = '';
    let lastUpdateAt = 0;
    let finished = false;

    const render = (): string => {
      const head = `${phase}  ⏱ ${fmtElapsed(Date.now() - start)}`;
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
      phase = '🔎 Working…';
      await flush(true);
      // Wrap the agent turn in a Sentry span so turn latency shows up in performance (no-op
      // tracing when Sentry is off — startSpan still runs the callback).
      const answer = await Sentry.startSpan(
        { name: 'aven.turn', op: 'gen_ai.invoke_agent', attributes: { 'aven.project': project.slug } },
        () =>
          chat.ask(
            question,
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
      await client.chat.update({
        channel,
        ts,
        text: fallbackText(capped),
        blocks: answerBlocks(capped, followUp),
      });
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

  // Resolve our own bot user id so the message handler can ignore the very messages
  // that already trigger app_mention (avoids double-processing).
  const authTest = await app.client.auth.test({ token: cfg.slack.botToken });
  const botUserId = authTest.user_id as string | undefined;

  // ── @mention → public thread (one session per thread) ───────────────────────
  app.event('app_mention', async ({ event, client }) => {
    const e = event as { channel: string; ts: string; thread_ts?: string; text?: string };
    const threadTs = e.thread_ts || e.ts;
    const { project, question, error } = await pickProject(client, e.channel, stripMention(e.text ?? ''));
    if (error) {
      await client.chat.postMessage({ channel: e.channel, thread_ts: threadTs, text: info(error) });
      return;
    }
    if (!question) return;
    await liveTurn(client, e.channel, e.ts, threadTs, `thread:${threadTs}`, project!, question);
  });

  // ── thread reply (owned) → continue;  DM → private conversation ─────────────
  app.message(async ({ message, client }) => {
    const m = message as {
      subtype?: string;
      bot_id?: string;
      channel: string;
      channel_type?: string;
      user?: string;
      text?: string;
      ts: string;
      thread_ts?: string;
    };
    if (m.subtype || m.bot_id) return; // ignore edits/joins/bot messages
    if (botUserId && m.text?.includes(`<@${botUserId}>`)) return; // app_mention handles these

    // Direct message → private; needs a project hint (slug) since DMs aren't bound.
    if (m.channel_type === 'im') {
      const { project, question, error } = await pickProject(client, m.channel, m.text ?? '');
      if (error) {
        // No project hint → offer a dropdown instead of demanding a slug prefix. Park the
        // question; the dm_pick_project handler runs it once a project is chosen.
        if (m.user && question && registry.projects.length > 1) {
          const pid = `dp${++dmPickSeq}`;
          pendingDmPicks.set(pid, { channel: m.channel, user: m.user, question });
          await client.chat.postMessage({
            channel: m.channel,
            text: 'Which project?',
            blocks: dmPickerBlocks(pid, registry.projects),
          });
        } else {
          await client.chat.postMessage({ channel: m.channel, text: info(error) });
        }
        return;
      }
      if (!question || !m.user) return;
      await liveTurn(client, m.channel, m.ts, undefined, `dm:${m.channel}:${project!.slug}`, project!, question);
      return;
    }

    // Public channel/group: only continue a thread we already own (no re-@mention).
    if (!m.thread_ts) return;
    const key = `thread:${m.thread_ts}`;
    if (!live.has(key) && !store.getChat(key)) return;
    const { project, question, error } = await pickProject(client, m.channel, m.text ?? '');
    if (error || !question || !project) return;
    await liveTurn(client, m.channel, m.ts, m.thread_ts, key, project, question);
  });

  // ── /aven → private answer in the user's DM (per project) ───────────────────
  app.command(CMD, async ({ command, ack, respond, client }) => {
    await ack(); // Slack needs an ack within 3s; the real work runs after.

    const cmdText = (command.text ?? '').trim();
    const verb = cmdText.split(/\s+/)[0]?.toLowerCase();

    // `/aven status` → a live ops snapshot (sandboxes, sessions, in-flight turns, PRs).
    // Reserved keyword, intercepted before project resolution so it works in ANY channel
    // (it's a fleet-wide view, not bound to one project).
    if (verb === 'status') {
      await respond({ response_type: 'ephemeral', text: ':bar_chart: Gathering status…' });
      try {
        const report = await collectStatus();
        await respond({
          response_type: 'ephemeral',
          replace_original: true,
          text: 'CoachAven status',
          blocks: statusReportBlocks(report),
        });
      } catch (err) {
        await respond({ response_type: 'ephemeral', replace_original: true, text: errText(err) });
      }
      return;
    }

    // `/aven access` → what this channel's project gives me (repos + MCP tools).
    if (verb === 'access') {
      await respond({ response_type: 'ephemeral', ...(await handleAccess(client, command.channel_id)) });
      return;
    }

    // `/aven schedule <when> | <prompt>` → create a read-only report job in this channel.
    if (verb === 'schedule') {
      const r = await handleSchedule(client, command.channel_id, command.user_id, cmdText);
      await respond({ response_type: 'ephemeral', ...r });
      return;
    }
    // `/aven routines [run|on|off|rm <id>]` → list/manage this channel's report jobs.
    if (verb === 'routines') {
      const rargs = cmdText.split(/\s+/).slice(1);
      if (rargs[0]?.toLowerCase() === 'run') {
        // Fire a job on demand (testing / "run the digest now") — needs the client, so
        // it's handled here rather than in the pure handleRoutines.
        const id = rargs[1];
        const r = id ? store.getRoutine(id) : undefined;
        if (!r || r.channel !== command.channel_id) {
          await respond({ response_type: 'ephemeral', text: `:x: No job \`${id ?? ''}\` in this channel.` });
          return;
        }
        const ok = fireRoutine(client, r);
        await respond({
          response_type: 'ephemeral',
          text: ok ? `:rocket: Running *${r.id}* now…` : `:hourglass_flowing_sand: *${r.id}* is already running.`,
        });
        return;
      }
      await respond({ response_type: 'ephemeral', ...handleRoutines(command.channel_id, cmdText) });
      return;
    }
    // `/aven dream [on|off|now]` → nightly memory consolidation (Dreaming) for this project.
    if (verb === 'dream') {
      const { project } = await pickProject(client, command.channel_id, '');
      const sub = cmdText.split(/\s+/)[1]?.toLowerCase();
      if (sub === 'now') {
        const r = store.listRoutines({ channel: command.channel_id }).find((x) => x.kind === 'dream');
        if (!r) {
          await respond({ response_type: 'ephemeral', text: `:information_source: No dream here yet — \`${CMD} dream on\` first.` });
          return;
        }
        const ok = fireRoutine(client, r);
        await respond({
          response_type: 'ephemeral',
          text: ok
            ? ':crescent_moon: Dreaming now… (silent — check `' + CMD + ' dream` for the digest)'
            : ':hourglass_flowing_sand: A turn is in flight for this project — try again shortly.',
        });
        return;
      }
      await respond({ response_type: 'ephemeral', ...handleDream(command.channel_id, command.user_id, project?.slug, cmdText) });
      return;
    }

    // `/aven memory [topic|log|live]` → read the agent's learned memory (read-only, private).
    // Default reads the journaled host snapshot (no sandbox wake); `live` forces the sandbox's
    // current state, `log` shows the snapshot history. (`/aven prompt` shows the deliberate layer.)
    if (verb === 'memory') {
      const { project, error } = await pickProject(client, command.channel_id, '');
      if (error || !project) {
        await respond({ response_type: 'ephemeral', text: info(error ?? 'No project bound to this channel.') });
        return;
      }
      const args = cmdText.split(/\s+/);
      const sub = args[1]?.toLowerCase();

      if (sub === 'log') {
        try {
          const lines = await snapshotLog(memoryRepoDir(project.slug));
          const body = lines.length
            ? lines.map((l) => `• ${l}`).join('\n')
            : '_No snapshots yet — memory is journaled after each dream (`' + CMD + ' dream`)._';
          await respond({
            response_type: 'ephemeral',
            text: `*Memory journal — ${project.slug}*\n${body}`.slice(0, MAX_SLACK_TEXT),
          });
        } catch (err) {
          await respond({ response_type: 'ephemeral', text: errText(err) });
        }
        return;
      }

      const live = sub === 'live';
      const topic = live ? args[2] : args[1];
      const file = memoryFilePath(projectCwd(cfg, project.slug, project.repos), topic);
      if (!file) {
        await respond({ response_type: 'ephemeral', text: ':x: Invalid topic name (use letters, digits, `_` or `-`).' });
        return;
      }
      const fileName = file.split('/').pop() as string;

      // Render: the index (no topic) gets a drill-down button per topic file it links; a
      // specific topic is just text. `note` is an optional footer (e.g. the snapshot caveat).
      const deliver = async (content: string, note: string) => {
        const topics = topic ? [] : parseTopics(content);
        if (topics.length) {
          await respond({
            response_type: 'ephemeral',
            replace_original: true,
            text: `Memory — ${project.slug}`,
            blocks: [
              { type: 'section', text: { type: 'mrkdwn', text: `${mdToMrkdwn(content)}${note}`.slice(0, 2900) } },
              ...topicButtons(project.slug, topics),
            ],
          });
        } else {
          await respond({
            response_type: 'ephemeral',
            replace_original: true,
            text: `${mdToMrkdwn(content)}${note}`.slice(0, MAX_SLACK_TEXT),
          });
        }
      };

      // Prefer the journaled host copy (no sandbox wake) unless `live` was requested.
      if (!live) {
        try {
          const snap = await readSnapshotFile(memoryRepoDir(project.slug), fileName);
          if (snap) {
            await deliver(snap, `\n\n_(last dream snapshot — \`${CMD} memory live\` for the sandbox's current state)_`);
            return;
          }
        } catch {
          /* no journal yet → fall through to the live read */
        }
      }

      await respond({ response_type: 'ephemeral', text: ':brain: Reading memory…' });
      try {
        await deliver(await readMemory(project, file, live), '');
      } catch (err) {
        await respond({ response_type: 'ephemeral', replace_original: true, text: errText(err) });
      }
      return;
    }

    // `/aven prompt` → show this project's system prompt (the deliberate layer). Read-only;
    // editing it from Slack is a separate runtime-config feature (see docs/runtime-config.md).
    if (verb === 'prompt') {
      const { project, error } = await pickProject(client, command.channel_id, '');
      if (error || !project) {
        await respond({ response_type: 'ephemeral', text: info(error ?? 'No project bound to this channel.') });
        return;
      }
      const body = project.systemPrompt?.trim()
        ? project.systemPrompt.trim()
        : "_No project-specific prompt set — the orchestrator base prompt and each repo's CLAUDE.md still apply._";
      await respond({
        response_type: 'ephemeral',
        text: `*System prompt — ${project.slug}*\n\n${mdToMrkdwn(body)}`.slice(0, MAX_SLACK_TEXT),
      });
      return;
    }

    // `/aven review <PR url|#num>` → on-demand, read-only PR review. The PR's repo picks
    // the project, so this works in DMs and any channel (not just a project-bound one).
    if (verb === 'review') {
      const arg = cmdText.slice('review'.length).trim();

      // `/aven review auto [on|off]` → per-project auto-review toggle (channel-bound).
      if (arg.split(/\s+/)[0]?.toLowerCase() === 'auto') {
        const { project, error } = await pickProject(client, command.channel_id, '');
        if (error || !project) {
          await respond({ response_type: 'ephemeral', text: info(error ?? 'Run `review auto` in a project channel.') });
          return;
        }
        const words = arg.split(/\s+/);
        const onoff = words[1]?.toLowerCase();
        if (onoff === 'on') {
          store.patchProjectSettings(project.slug, {
            autoReview: true,
            autoReviewSince: new Date().toISOString(),
            autoReviewChannel: command.channel_id,
            autoReviewEffort: parseEffort(words[2]) ?? 'med',
          });
          const eff = store.getProjectSettings(project.slug).autoReviewEffort;
          await respond({ response_type: 'ephemeral', text: `:white_check_mark: Auto-review *ON* (${eff}) for *${project.slug}* — I'll review new (non-bot) PRs here as they open.` });
        } else if (onoff === 'off') {
          store.patchProjectSettings(project.slug, { autoReview: false });
          await respond({ response_type: 'ephemeral', text: `:white_check_mark: Auto-review *OFF* for *${project.slug}*.` });
        } else {
          const s = store.getProjectSettings(project.slug);
          await respond({ response_type: 'ephemeral', text: `Auto-review for *${project.slug}*: ${s.autoReview ? `:large_green_circle: ON (${s.autoReviewEffort ?? 'med'})` : ':white_circle: OFF'}. Toggle: \`${CMD} review auto on|off [low|med|high]\`.` });
        }
        return;
      }

      if (!arg) {
        await respond({ response_type: 'ephemeral', text: `:information_source: Usage: \`${CMD} review <PR url or #number> [low|med|high]\` (or \`${CMD} review auto on|off\`)` });
        return;
      }
      // An optional trailing low|med|high token sets the effort; the rest is the PR ref.
      const tokens = arg.split(/\s+/);
      const effort: ReviewEffort = parseEffort(tokens[tokens.length - 1]) ?? 'med';
      const refText = parseEffort(tokens[tokens.length - 1]) ? tokens.slice(0, -1).join(' ') : arg;
      const channelSlug = (await pickProject(client, command.channel_id, '')).project?.slug;
      const t = resolvePr(refText, registry.projects, channelSlug);
      if ('error' in t) {
        await respond({ response_type: 'ephemeral', text: `:x: ${t.error}` });
        return;
      }
      const project = resolveBySlug(registry, t.slug);
      if (!project) {
        await respond({ response_type: 'ephemeral', text: `:x: Unknown project ${t.slug}.` });
        return;
      }
      const fired = fireReview(client, project, t.repo, t.number, command.channel_id, effort);
      await respond({
        response_type: 'ephemeral',
        text: fired
          ? `:eyes: Reviewing ${shortRepo(t.repo)}#${t.number} (${effort})…`
          : `:hourglass_flowing_sand: Already reviewing ${shortRepo(t.repo)}#${t.number}.`,
      });
      return;
    }

    // `/aven autofix <PR>` → watch a PR's CI + reviews and ping here with a Fix button.
    //   `/aven autofix off <PR>` unsubscribes; `/aven autofix list` lists this channel's.
    if (verb === 'autofix') {
      const arg = cmdText.slice('autofix'.length).trim();
      const first = arg.split(/\s+/)[0]?.toLowerCase();

      if (first === 'list') {
        const ws = store.listPrWatches({ channel: command.channel_id });
        const body = ws.length
          ? ws.map((w) => `• *${shortRepo(w.repo)}#${w.number}*`).join('\n')
          : `_No PRs watched here._ Subscribe: \`${CMD} autofix <PR url or #number>\``;
        await respond({ response_type: 'ephemeral', text: `*Watched PRs*\n${body}` });
        return;
      }

      const channelSlug = (await pickProject(client, command.channel_id, '')).project?.slug;
      const refText = first === 'off' ? arg.slice('off'.length).trim() : arg;
      if (!refText) {
        await respond({ response_type: 'ephemeral', text: `:information_source: Usage: \`${CMD} autofix <PR url or #number>\` (\`off <PR>\`, \`list\`)` });
        return;
      }
      const t = resolvePr(refText, registry.projects, channelSlug);
      if ('error' in t) {
        await respond({ response_type: 'ephemeral', text: `:x: ${t.error}` });
        return;
      }
      const watchKey = `${t.repo}#${t.number}`;

      if (first === 'off') {
        const removed = store.deletePrWatch(watchKey);
        await respond({
          response_type: 'ephemeral',
          text: removed ? `:white_check_mark: Stopped watching ${shortRepo(t.repo)}#${t.number}.` : `:information_source: Not watching ${shortRepo(t.repo)}#${t.number}.`,
        });
        return;
      }

      // Subscribe: baseline the cursors off the PR's current CI + reviews so only changes ping.
      const meta = await getPrMeta(cfg, t.repo, t.number);
      if (!meta) {
        await respond({ response_type: 'ephemeral', text: `:x: Couldn't read ${shortRepo(t.repo)}#${t.number} — check the number.` });
        return;
      }
      if (meta.state === 'closed') {
        await respond({ response_type: 'ephemeral', text: `:information_source: ${shortRepo(t.repo)}#${t.number} is already ${meta.merged ? 'merged' : 'closed'}.` });
        return;
      }
      const ci = await ciStatusForSha(cfg, t.repo, meta.headSha);
      const reviews = await listReviews(cfg, t.repo, t.number);
      store.setPrWatch(watchKey, {
        repo: t.repo,
        number: t.number,
        slug: t.slug,
        channel: command.channel_id,
        createdBy: command.user_id,
        createdAt: new Date().toISOString(),
        lastCiSha: meta.headSha,
        lastCiConclusion: ci,
        lastReviewId: reviews.reduce((m, r) => Math.max(m, r.id), 0),
      });
      await respond({
        response_type: 'ephemeral',
        text: `:eye: Watching *${shortRepo(t.repo)}#${t.number}* — I'll ping here on CI failures or new reviews, with a *Fix* button. (CI now: ${ci})`,
      });
      return;
    }

    const { project, question, error } = await pickProject(client, command.channel_id, command.text ?? '');
    if (error) {
      await respond({ response_type: 'ephemeral', text: info(error) });
      return;
    }
    if (!question) {
      await respond({ response_type: 'ephemeral', text: `Ask me something: \`${CMD} <your question>\`` });
      return;
    }
    const key = `cmd:${command.user_id}:${project!.slug}`;
    let dm: string | undefined;
    try {
      const im = await client.conversations.open({ users: command.user_id });
      dm = im.channel?.id;
    } catch {
      dm = undefined; // no im:write — fall back to ephemeral below
    }

    if (dm) {
      await respond({ response_type: 'ephemeral', text: ':envelope_with_arrow: Answering you in DM…' });
      await liveTurn(client, dm, undefined, undefined, key, project!, question);
      return;
    }
    // Fallback: private (ephemeral) answer right here in the channel.
    await respond({ response_type: 'ephemeral', text: THINKING });
    try {
      const answer = await runAsk(key, project!, question);
      await respond({
        response_type: 'ephemeral',
        replace_original: true,
        text: fallbackText(answer),
        blocks: answerBlocks(answer),
      });
    } catch (err) {
      await respond({ response_type: 'ephemeral', replace_original: true, text: errText(err) });
    }
  });

  // ── "✖ Cancel" button → abort that turn (the queued next one then starts) ───
  app.action('cancel_turn', async ({ ack, action }) => {
    await ack();
    const turnId = (action as { value?: string }).value;
    if (turnId) running.get(turnId)?.abort();
  });

  // ── "🔗 View PR" link button → opens the URL itself; just ack the interaction ──
  app.action(/^pr_link:/, async ({ ack }) => {
    await ack();
  });

  // ── DM project dropdown → run the parked question against the chosen project ──
  app.action('dm_pick_project', async ({ ack, action, client, body }) => {
    await ack();
    const sel = (action as { selected_option?: { value?: string } }).selected_option?.value ?? '';
    const i = sel.indexOf(':'); // value = "<pid>:<slug>"
    const pid = sel.slice(0, i);
    const slug = sel.slice(i + 1);
    const pending = pendingDmPicks.get(pid);
    const project = slug ? resolveBySlug(registry, slug) : undefined;
    const b = body as { message?: { ts?: string } };
    if (!pending || !project) {
      if (b.message?.ts) {
        await client.chat
          .update({ channel: (body as { channel?: { id?: string } }).channel?.id ?? '', ts: b.message.ts, text: '⌛ This picker expired — send your message again.', blocks: [] })
          .catch(() => {});
      }
      return;
    }
    pendingDmPicks.delete(pid);
    if (b.message?.ts) {
      await client.chat
        .update({ channel: pending.channel, ts: b.message.ts, text: `▶️ Running on *${slug}*…`, blocks: [] })
        .catch(() => {});
    }
    await liveTurn(client, pending.channel, undefined, undefined, `dm:${pending.channel}:${slug}`, project, pending.question);
  });

  // ── "🔀 Open a PR" button → enqueue a follow-up turn asking the agent to PR its work ──
  app.action('make_pr', async ({ ack, action, client }) => {
    await ack();
    let v: { key: string; channel: string; threadTs?: string };
    try {
      v = JSON.parse((action as { value?: string }).value ?? '');
    } catch {
      return;
    }
    const slug = slugForKey(v.key);
    const project = slug ? resolveBySlug(registry, slug) : undefined;
    if (!project) return;
    await liveTurn(client, v.channel, undefined, v.threadTs, v.key, project, FOLLOW_UP_PR_PROMPT);
  });

  // ── autofix "🔧 Fix it" button → enqueue a WRITE turn to address the PR feedback ──
  app.action('autofix_apply', async ({ ack, action, client }) => {
    await ack();
    let v: { slug: string; repo: string; number: number; channel: string };
    try {
      v = JSON.parse((action as { value?: string }).value ?? '');
    } catch {
      return;
    }
    const project = resolveBySlug(registry, v.slug);
    if (!project) return;
    const key = `autofix:${v.repo}:${v.number}:${v.slug}`;
    if (queues.has(key)) return; // a fix is already running for this PR
    await liveTurn(client, v.channel, undefined, undefined, key, project, autofixPrompt(v.repo, v.number));
  });

  // ── memory topic button → open that section file (journal copy first, no sandbox wake) ──
  app.action(/^mem_open:/, async ({ ack, action, respond }) => {
    await ack();
    let v: { s: string; f: string };
    try {
      v = JSON.parse((action as { value?: string }).value ?? '');
    } catch {
      return;
    }
    const project = resolveBySlug(registry, v.s);
    const fp = project && memoryFilePath(projectCwd(cfg, project.slug, project.repos), v.f);
    if (!project || !fp) return;
    try {
      let text = await readSnapshotFile(memoryRepoDir(project.slug), v.f).catch(() => null);
      if (text == null) text = await readMemory(project, fp, false); // not journaled → live (no wake)
      await respond({
        response_type: 'ephemeral',
        replace_original: false,
        text: `*${v.f}*\n\n${mdToMrkdwn(text)}`.slice(0, MAX_SLACK_TEXT),
      });
    } catch (err) {
      await respond({ response_type: 'ephemeral', replace_original: false, text: errText(err) });
    }
  });

  // ── App Home tab → a self-documenting dashboard: projects, channels, how to use me ──
  app.event('app_home_opened', async ({ event, client }) => {
    const e = event as { user: string; tab?: string };
    if (e.tab && e.tab !== 'home') return; // ignore the messages-tab open
    try {
      await client.views.publish({
        user_id: e.user,
        view: { type: 'home', blocks: homeBlocks(registry, CHANNEL_PREFIX) },
      });
    } catch (err) {
      log.error(`home publish failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  // Update a stale/expired question message (click landed but the entry is gone — turn
  // ended, bot restarted, etc.) so the user gets feedback instead of a dead button.
  async function markStale(client: bolt.webApi.WebClient, body: unknown): Promise<void> {
    const b = body as { channel?: { id?: string }; message?: { ts?: string } };
    if (b.channel?.id && b.message?.ts) {
      await client.chat
        .update({ channel: b.channel.id, ts: b.message.ts, text: '⌛ This question has expired', blocks: [] })
        .catch(() => {});
    }
  }

  // ── option button → toggle/select; resolve single-select on click, multi on Submit ──
  // action_id is `answer_q:<qid>:<qi>:<oi>` (unique per button); match the family.
  app.action(/^answer_q:/, async ({ ack, action, client, body }) => {
    await ack();
    let v: { qid: string; qi: number; oi: number };
    try {
      v = JSON.parse((action as { value?: string }).value ?? '');
    } catch {
      return;
    }
    const entry = pendingQuestions.get(v.qid);
    if (!entry || entry.done) {
      if (!completedQuestions.has(v.qid)) await markStale(client, body);
      return;
    }

    const q = entry.questions[v.qi];
    let set = entry.picks.get(v.qi) ?? new Set<number>();
    if (q?.multiSelect) {
      if (set.has(v.oi)) set.delete(v.oi);
      else set.add(v.oi);
    } else {
      set = new Set([v.oi]); // single-select: replace
    }
    entry.picks.set(v.qi, set);

    // Single-select group auto-resolves once every question has a pick; multi waits for Submit.
    if (!entry.multi && answeredAll(entry)) {
      await client.chat
        .update({ channel: entry.channel, ts: entry.ts, text: '✅ Answered', blocks: questionBlocks(entry.questions, entry.picks, entry.multi, v.qid, true) })
        .catch(() => {});
      finalizeQuestion(entry, v.qid);
    } else {
      await client.chat
        .update({ channel: entry.channel, ts: entry.ts, text: '❓ The agent has a question', blocks: questionBlocks(entry.questions, entry.picks, entry.multi, v.qid, false) })
        .catch(() => {});
    }
  });

  // ── Submit button (multi-select) → resolve once every question has ≥1 selection ──
  app.action(/^submit_q:/, async ({ ack, action, client, body }) => {
    await ack();
    let v: { qid: string };
    try {
      v = JSON.parse((action as { value?: string }).value ?? '');
    } catch {
      return;
    }
    const entry = pendingQuestions.get(v.qid);
    if (!entry || entry.done) {
      if (!completedQuestions.has(v.qid)) await markStale(client, body);
      return;
    }
    if (!answeredAll(entry)) return; // ignore until every question has a selection
    await client.chat
      .update({ channel: entry.channel, ts: entry.ts, text: '✅ Answered', blocks: questionBlocks(entry.questions, entry.picks, entry.multi, v.qid, true) })
      .catch(() => {});
    finalizeQuestion(entry, v.qid);
  });

  // On startup, finalize any turn that was still "Working…" when the bot last stopped:
  // reattach to its command (still running, or finished during the downtime) and rewrite
  // its status message with the recovered result. Best-effort, per chat, never blocks.
  async function resumeInflightTurns(): Promise<void> {
    const client = app.client;
    for (const chat of store.allChats()) {
      const inf = chat.inflight;
      if (!inf || !chat.sessionKey || !chat.cmdId) continue;
      const project = resolveBySlug(registry, chat.slug);
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
          } else {
            await client.chat.update({
              channel: inf.channel,
              ts: inf.statusTs,
              text: `⚠️ The bot restarted mid-turn and couldn't recover the live result (${r.status}). The work may have finished in the thread or a PR — send a new message to continue.`,
              blocks: [],
            });
          }
        } catch {
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

  // ── /aven access → show what this channel's project exposes (repos + MCP) ────
  async function handleAccess(
    client: bolt.webApi.WebClient,
    channelId: string,
  ): Promise<{ text: string; blocks?: unknown[] }> {
    const { project } = await pickProject(client, channelId, '');
    if (!project) {
      return {
        text: `:information_source: This channel isn't bound to a project. Use a \`${CHANNEL_PREFIX}<slug>\` channel, or ask in one of: ${registry.projects.map((p) => p.slug).join(', ')}.`,
      };
    }
    return { text: `Access for ${project.slug}`, blocks: accessBlocks(project) };
  }

  // ── /aven schedule → create a read-only report job bound to this channel ─────
  // Returns an ephemeral payload (text + optional blocks). The project is resolved from
  // the channel binding only (not the text), so a job can't be created in an unbound chat.
  async function handleSchedule(
    client: bolt.webApi.WebClient,
    channelId: string,
    userId: string,
    cmdText: string,
  ): Promise<{ text: string; blocks?: unknown[] }> {
    const usage =
      `Usage: \`${CMD} schedule <when> | <what to report>\`\n` +
      '`<when>` = `daily 9:00`, `weekdays 9:00`, `weekly mon 9:00`, or `cron 0 9 * * 1-5`' +
      ` (times in ${ROUTINE_TZ}).`;
    const rest = cmdText.slice('schedule'.length).trim();
    const bar = rest.indexOf('|');
    if (bar < 0) return { text: `:information_source: ${usage}` };
    const when = rest.slice(0, bar).trim();
    const prompt = rest.slice(bar + 1).trim();
    if (!when || !prompt) return { text: `:information_source: ${usage}` };

    const sched = parseSchedule(when);
    if ('error' in sched) return { text: `:x: ${sched.error}` };

    const { project } = await pickProject(client, channelId, '');
    if (!project) {
      return {
        text: ':x: Schedule a job from a project channel (e.g. `' + `${CHANNEL_PREFIX}${registry.projects[0]?.slug ?? 'caldora'}` + '`).',
      };
    }
    const rec = store.addRoutine({
      slug: project.slug,
      channel: channelId,
      cron: sched.cron,
      tz: ROUTINE_TZ,
      spec: sched.spec,
      prompt,
      enabled: true,
      createdBy: userId,
    });
    return {
      text:
        `:white_check_mark: Scheduled *${rec.id}* — \`${rec.spec}\` (${ROUTINE_TZ}) for *${project.slug}*. ` +
        `I'll post the digest here. Read-only — I won't change code or open PRs.\n_Manage:_ \`${CMD} routines\``,
    };
  }

  // ── /aven routines [on|off|rm <id>] → list/manage this channel's report jobs ──
  function handleRoutines(channelId: string, cmdText: string): { text: string; blocks?: unknown[] } {
    const args = cmdText.split(/\s+/).slice(1); // drop the "routines" verb
    const sub = args[0]?.toLowerCase();
    if (!sub) {
      return { text: 'Scheduled jobs', blocks: routineListBlocks(store.listRoutines({ channel: channelId })) };
    }
    if (sub === 'all') {
      // Fleet-wide view: every project's jobs, grouped by project (works from any channel).
      return { text: 'All scheduled jobs', blocks: allRoutinesBlocks(groupRoutinesBySlug(store.listRoutines())) };
    }
    const id = args[1];
    if (!id) return { text: `:information_source: Usage: \`${CMD} routines all | run|on|off|rm <id>\`` };
    const r = store.getRoutine(id);
    if (!r || r.channel !== channelId) return { text: `:x: No job \`${id}\` in this channel.` };
    if (sub === 'off') {
      store.patchRoutine(id, { enabled: false });
      return { text: `:white_check_mark: Paused *${id}*.` };
    }
    if (sub === 'on') {
      store.patchRoutine(id, { enabled: true });
      return { text: `:white_check_mark: Resumed *${id}*.` };
    }
    if (sub === 'rm' || sub === 'remove' || sub === 'delete') {
      store.deleteRoutine(id);
      return { text: `:white_check_mark: Deleted *${id}*.` };
    }
    return { text: `:information_source: Usage: \`${CMD} routines all | run|on|off|rm <id>\`` };
  }

  // ── /aven dream [on|off] → enable/disable nightly memory consolidation for this project ──
  // 'now' is handled in the command handler (it needs the client to fire). Bare = status.
  // One dream routine per project channel (kind: 'dream'); reuses the routine scheduler.
  const DREAM_DEFAULT_CRON = '0 3 * * *'; // 03:00 daily, in ROUTINE_TZ
  function handleDream(channelId: string, userId: string, slug: string | undefined, cmdText: string): { text: string } {
    if (!slug) return { text: `:x: Use \`${CMD} dream\` from a project channel.` };
    const sub = cmdText.split(/\s+/)[1]?.toLowerCase();
    const existing = store.listRoutines({ channel: channelId }).find((r) => r.kind === 'dream');
    if (sub === 'off') {
      if (!existing) return { text: ':information_source: No dreaming scheduled here.' };
      store.patchRoutine(existing.id, { enabled: false });
      return { text: `:white_check_mark: Dreaming paused for *${slug}*.` };
    }
    if (sub === 'on') {
      if (existing) {
        store.patchRoutine(existing.id, { enabled: true });
        return { text: `:crescent_moon: Dreaming on for *${slug}* — \`${existing.spec}\` (${existing.tz}).` };
      }
      const rec = store.addRoutine({
        slug,
        channel: channelId,
        cron: DREAM_DEFAULT_CRON,
        tz: ROUTINE_TZ,
        spec: 'daily 3:00',
        prompt: '',
        enabled: true,
        createdBy: userId,
        kind: 'dream',
      });
      return {
        text: `:crescent_moon: Dreaming on for *${slug}* — \`${rec.spec}\` (${ROUTINE_TZ}). I'll quietly consolidate memory; \`${CMD} dream\` shows the last digest.`,
      };
    }
    // bare / status
    if (!existing) {
      return { text: `:crescent_moon: No dreaming for *${slug}*. Enable nightly memory consolidation: \`${CMD} dream on\`.` };
    }
    const state = existing.enabled ? '🟢 on' : '⚪️ off';
    const last = existing.lastRunAt ? `\nLast run: ${existing.lastRunAt.slice(0, 16).replace('T', ' ')}` : '';
    const digest = existing.lastSummary ? `\nLast: _${existing.lastSummary}_` : '';
    return {
      text: `:crescent_moon: *Dreaming — ${slug}* ${state} · \`${existing.spec}\` (${existing.tz})${last}${digest}\n_Manage:_ \`${CMD} dream on|off|now\``,
    };
  }

  // True if any conversation for this project has a turn in flight right now — used to skip
  // a dream rather than race a live user turn on the project's memory files.
  function projectBusy(slug: string): boolean {
    for (const key of queues.keys()) if (slugForKey(key) === slug) return true;
    for (const key of asking) if (slugForKey(key) === slug) return true; // runAsk turns (Q&A, dreams)
    return false;
  }

  // Fire one routine now. A report posts a read-only digest turn via the normal turn
  // machinery; a dream runs a silent memory-only pass (see fireDream). Shared by the
  // scheduler and the manual run triggers. Returns false if it can't run right now.
  function fireRoutine(client: bolt.webApi.WebClient, r: RoutineRecord): boolean {
    const project = resolveBySlug(registry, r.slug);
    if (!project) return false; // project removed from the registry
    if (r.kind === 'dream') return fireDream(project, r);
    const key = `cron:${r.id}:${r.slug}`;
    if (queues.has(key)) return false; // previous run still in flight — don't stack
    store.patchRoutine(r.id, { lastRunAt: new Date().toISOString() });
    void liveTurn(client, r.channel, undefined, undefined, key, project, REPORT_FRAMING + r.prompt).catch((e) =>
      log.error(`routine ${r.id}: ${e instanceof Error ? e.message : String(e)}`),
    );
    return true;
  }

  // A dream runs silently (no channel post): consolidate the project's auto memory, then log
  // a one-line digest and stash it on the routine for visibility. Skipped while the project
  // has a live turn so the two don't race on memory files. Source of truth = the sandbox
  // (warm, survives stop/start); durability of the consolidated copy is future work.
  function fireDream(project: ProjectConfig, r: RoutineRecord): boolean {
    if (projectBusy(project.slug)) return false; // don't dream over a live user turn
    const key = `cron:${r.id}:${r.slug}`;
    store.patchRoutine(r.id, { lastRunAt: new Date().toISOString() });
    void (async () => {
      try {
        const digest = dreamDigest(await runAsk(key, project, dreamPrompt(projectCwd(cfg, project.slug, project.repos))));
        store.patchRoutine(r.id, { lastSummary: digest });
        log.info(`dream ${r.id} (${project.slug}): ${digest}`);
        // Journal the consolidated memory (the sandbox is awake from the dream just now).
        const sandbox = await makeDaytona(cfg).get(`${cfg.sandbox.namePrefix}${project.slug}`);
        await snapshotMemory(sandbox, cfg, project.slug, project.repos, digest);
      } catch (e) {
        log.error(`dream ${r.id}: ${e instanceof Error ? e.message : String(e)}`);
      }
    })();
    return true;
  }

  // Fire a PR review (on-demand or auto): a read-only review turn keyed per PR (standing →
  // re-review keeps context). Returns false if a review for this PR is already in flight.
  function fireReview(
    client: bolt.webApi.WebClient,
    project: ProjectConfig,
    repo: string,
    number: number,
    channel: string,
    effort: ReviewEffort = 'med',
  ): boolean {
    const key = `review:${repo}:${number}:${project.slug}`;
    if (queues.has(key)) return false;
    void liveTurn(client, channel, undefined, undefined, key, project, reviewPrompt(repo, number, effort)).catch((e) =>
      log.error(`review ${repo}#${number}: ${e instanceof Error ? e.message : String(e)}`),
    );
    return true;
  }

  // Scheduler: every 60s, fire any routine due this wall-clock minute (see dueRoutines).
  // Routines live in state.json, so they need no separate restart recovery.
  function startScheduler(): void {
    const client = app.client;
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
    const client = app.client;
    const tick = async (): Promise<void> => {
      for (const project of registry.projects) {
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
    void tick().catch((e) => log.error(`auto-review poll: ${e instanceof Error ? e.message : String(e)}`));
    setInterval(() => void tick().catch(() => {}), AUTO_REVIEW_POLL_MS);
  }

  // Autofix watcher: every couple of minutes, check each subscribed PR's CI + reviews and
  // post a notification (with a "Fix" button) when something changed (see autofixEvents).
  // A merged/closed PR auto-unsubscribes. Tier 1: notify + one-click fix, never auto-push.
  function startAutofixPoller(): void {
    const client = app.client;
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
    void tick().catch((e) => log.error(`autofix poll: ${e instanceof Error ? e.message : String(e)}`));
    setInterval(() => void tick().catch(() => {}), AUTOFIX_POLL_MS);
  }

  await app.start();
  log.info(`Slack bot running (Socket Mode) — ${summary(registry)}`);
  void resumeInflightTurns();
  startScheduler();
  startAutoReviewPoller();
  startAutofixPoller();
}

// Slack's `markdown` block renders standard Markdown (bold, headers, lists, links,
// tables) natively — so we send Claude's output verbatim instead of converting to
// the lossy legacy mrkdwn. Each markdown block caps ~12k chars; chunk longer answers.
const SLACK_MD_BLOCK_LIMIT = 11900;

// Context a completed answer needs to offer a one-click "Open a PR" follow-up: which
// conversation to enqueue the turn under, and where to post it.
interface FollowUp {
  key: string;
  channel: string;
  threadTs?: string;
}

// Render the answer as markdown block(s), then an action row: link buttons to any PR(s)
// the agent opened, or — if it didn't open one — an "Open a PR" button that enqueues a
// follow-up turn (only when `followUp` context is supplied, i.e. a live thread/DM turn).
// Chunk text into Slack `markdown` blocks (each caps ~12k chars). Used by answerBlocks for the
// bot's answers (delivered via chat.update, which accepts `markdown` blocks). NOT for the
// ephemeral `respond` path — that rejects `markdown` blocks, so /aven memory|prompt use text.
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Slack 'markdown' block not yet in SDK block union
function markdownBlocks(text: string): any[] {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const blocks: any[] = [];
  for (let i = 0; i < text.length; i += SLACK_MD_BLOCK_LIMIT) {
    blocks.push({ type: 'markdown', text: text.slice(i, i + SLACK_MD_BLOCK_LIMIT) });
  }
  if (!blocks.length) blocks.push({ type: 'markdown', text: '(no output)' });
  return blocks;
}

// Drill-down buttons for a memory index: one button per topic file, carrying {s:slug, f:file}
// for the `mem_open:` handler. Capped at 24 (Slack's 25-element actions-block limit). `actions`
// buttons — unlike the `markdown` block — render fine over the ephemeral respond path.
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Slack block union
function topicButtons(slug: string, topics: { title: string; file: string }[]): any[] {
  return [
    {
      type: 'actions',
      elements: topics.slice(0, 24).map((t, i) => ({
        type: 'button',
        text: { type: 'plain_text', text: (t.title || t.file).slice(0, 75) },
        action_id: `mem_open:${i}`,
        value: JSON.stringify({ s: slug, f: t.file }),
      })),
    },
  ];
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Slack 'markdown' block not yet in SDK block union
function answerBlocks(answer: string, followUp?: FollowUp): any[] {
  const blocks = markdownBlocks(answer);

  const prs = prUrls(answer);
  if (prs.length) {
    blocks.push({
      type: 'actions',
      elements: prs.slice(0, 5).map((url, i) => ({
        type: 'button',
        text: { type: 'plain_text', text: prs.length === 1 ? '🔗 View PR' : `🔗 PR #${url.split('/').pop()}` },
        url,
        action_id: `pr_link:${i}`,
      })),
    });
  } else if (followUp) {
    blocks.push({
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: '🔀 Open a PR' },
          action_id: 'make_pr',
          value: JSON.stringify({ key: followUp.key, channel: followUp.channel, threadTs: followUp.threadTs }),
        },
      ],
    });
  }
  return blocks;
}
// Live status as a section + a "✖ Cancel" button carrying the turnId. Used while a turn
// runs; replaced by the answer (markdown blocks) or a plain status on cancel/error.
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Slack block union
function statusBlocks(text: string, turnId: string): any[] {
  return [
    { type: 'section', text: { type: 'mrkdwn', text: text || '…' } },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: '✖ Cancel' },
          action_id: 'cancel_turn',
          value: turnId,
        },
      ],
    },
  ];
}

// Render an AskUserQuestion prompt as Slack blocks: each question is a section listing
// its options; unanswered questions show option buttons, answered ones show the pick.
// (v1 treats every question as single-select — one click answers it.)
// Render an AskUserQuestion prompt as Slack blocks. `picks` = chosen option indices per
// question (selected options get a ✓). When `done`, render a buttonless summary. For
// multi-select questions a single "Submit" button finalizes. Button `value` carries ONLY
// indices {qid,qi,oi} (never the label) so it can't blow Slack's 2000-char value cap.
// Slack allows max 25 elements per actions block; we cap options at 24 and note any drop.
const MAX_OPTION_BUTTONS = 24;
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Slack block union
function questionBlocks(
  questions: AskQuestion[],
  picks: Map<number, Set<number>>,
  multi: boolean,
  qid: string,
  done: boolean,
): any[] {
  const intro = done
    ? '✅ *Answered*'
    : `❓ *The agent needs your input*${multi ? '  _(pick one or more, then Submit)_' : ''}`;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const blocks: any[] = [{ type: 'section', text: { type: 'mrkdwn', text: intro } }];

  questions.forEach((q, qi) => {
    const set = picks.get(qi) ?? new Set<number>();
    const head = `*${q.header ? `${q.header}: ` : ''}${q.question}*`;
    const shown = q.options.slice(0, MAX_OPTION_BUTTONS);
    const dropped = q.options.length - shown.length;
    const optLines = shown
      .map((o, oi) => `${set.has(oi) ? '✅' : '•'} *${o.label}*${o.description ? ` — ${o.description}` : ''}`)
      .join('\n');
    const note = dropped > 0 ? `\n_(+${dropped} more not shown — reply in thread to pick)_` : '';
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `${head}\n${optLines}${note}` } });
    if (!done) {
      blocks.push({
        type: 'actions',
        block_id: `${qid}:${qi}`,
        // action_id must be UNIQUE within a message — Slack rejects duplicates. Routed via
        // the `answer_q:` regex handler; value carries only indices (label-length-safe).
        elements: shown.map((o, oi) => ({
          type: 'button',
          text: { type: 'plain_text', text: o.label.slice(0, 75) },
          action_id: `answer_q:${qid}:${qi}:${oi}`,
          value: JSON.stringify({ qid, qi, oi }),
        })),
      });
    }
  });

  if (multi && !done) {
    blocks.push({
      type: 'actions',
      block_id: `${qid}:submit`,
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Submit' },
          style: 'primary',
          action_id: `submit_q:${qid}`,
          value: JSON.stringify({ qid }),
        },
      ],
    });
  }
  return blocks;
}

// ── `/aven status` rendering ────────────────────────────────────────────────
interface ProjectStatus {
  slug: string;
  repos: number;
  state?: string; // Daytona sandbox state; undefined = sandbox never created
  sessions: number; // conversations bound to this project in state.json
  active: number; // conversations with a turn in flight right now
  openPRs?: number; // undefined = couldn't be determined
  jobs: number; // scheduled report routines
  dreams: number; // scheduled dream routines
}
interface StatusReport {
  projects: ProjectStatus[];
  turnsInFlight: number;
  daytonaOk: boolean;
  githubOk: boolean;
}

function stateLabel(state?: string): string {
  if (!state) return '🌑 not created';
  if (state === 'started') return '✅ started';
  if (state === 'stopped') return '💤 stopped';
  return `⚠️ ${state}`;
}
const plural = (n: number, w: string): string => `${n} ${w}${n === 1 ? '' : 's'}`;

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Slack block union
function statusReportBlocks(r: StatusReport): any[] {
  const head = `*CoachAven — live*  ·  ${plural(r.projects.length, 'project')} · ${plural(r.turnsInFlight, 'turn')} in flight`;
  const lines = r.projects.map((p) => {
    const bits = [stateLabel(p.state), plural(p.repos, 'repo'), plural(p.sessions, 'session'), `${p.active} active`];
    if (p.openPRs !== undefined) bits.push(plural(p.openPRs, 'open PR'));
    if (p.jobs) bits.push(plural(p.jobs, 'job'));
    if (p.dreams) bits.push(`${p.dreams} 🌙`);
    return `• *${p.slug}* — ${bits.join(' · ')}`;
  });
  const health = `_Daytona ${r.daytonaOk ? '✅' : '⚠️'} · GitHub ${r.githubOk ? '✅' : '⚠️'} · Slack ✅_`;
  return [{ type: 'section', text: { type: 'mrkdwn', text: `${head}\n\n${lines.join('\n')}\n\n${health}` } }];
}

// "Org/name" → "name", for compact display.
const shortRepo = (full: string): string => full.split('/').pop() ?? full;

// ── /aven access ────────────────────────────────────────────────────────────
// What a channel's project exposes: its repos and MCP tools (Claude Tag's "what can you
// access here?"). Transparency for onboarding — read-only.
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Slack block union
function accessBlocks(project: ProjectConfig): any[] {
  const repos = project.repos.map((r) => `\`${shortRepo(r)}\``).join(', ');
  const mcp = project.mcp?.length ? project.mcp.map((m) => `\`${m.name}\``).join(', ') : '_none_';
  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text:
          `*${project.slug}* — this channel's project\n` +
          `*Repos:* ${repos}\n` +
          `*Tools (MCP):* ${mcp}\n\n` +
          '_I work in a dedicated branch and open a PR for review — never pushing straight to the default branch._',
      },
    },
  ];
}

// ── DM project picker ───────────────────────────────────────────────────────
// Dropdown of projects for a DM with no slug hint. Each option carries the parked
// question's id so the handler can run it: value = "<pid>:<slug>".
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Slack block union
function dmPickerBlocks(pid: string, projects: ProjectConfig[]): any[] {
  return [
    { type: 'section', text: { type: 'mrkdwn', text: "Which project should I work on? _(DMs aren't tied to a channel.)_" } },
    {
      type: 'actions',
      elements: [
        {
          type: 'static_select',
          action_id: 'dm_pick_project',
          placeholder: { type: 'plain_text', text: 'Pick a project' },
          options: projects.slice(0, 100).map((p) => ({
            text: { type: 'plain_text', text: p.slug },
            value: `${pid}:${p.slug}`,
          })),
        },
      ],
    },
  ];
}

// ── App Home tab ────────────────────────────────────────────────────────────

// The Home tab: what I am, every project + the channel that drives it, and a usage
// cheat-sheet. Self-serve onboarding so colleagues don't have to read the README.
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Slack block union
function homeBlocks(reg: ProjectsRegistry, prefix: string): any[] {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const blocks: any[] = [
    { type: 'header', text: { type: 'plain_text', text: '🧭 CoachAven' } },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: "I'm a coding agent living in your project channels — mention me to investigate, build, and open PRs without leaving Slack.",
      },
    },
    { type: 'divider' },
    { type: 'section', text: { type: 'mrkdwn', text: `*Projects* (${reg.projects.length})` } },
  ];
  for (const p of reg.projects) {
    const channel = p.slackChannel ? '_(custom channel)_' : `#${prefix}${p.slug}`;
    const repos = p.repos.map((r) => `\`${shortRepo(r)}\``).join(', ');
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `• *${p.slug}* — ${channel}\n   ${plural(p.repos.length, 'repo')}: ${repos}` },
    });
  }
  blocks.push(
    { type: 'divider' },
    { type: 'section', text: { type: 'mrkdwn', text: '*How to use me*' } },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text:
          '• *Build / collaborate* — @-mention me with a task in a project channel. I reply in a thread; keep replying (no need to re-mention) and I remember the conversation.\n' +
          `• *Quick private answer* — \`${CMD} <question>\` in a project channel. I answer privately in our DM.\n` +
          "• *DM me directly* — just message me in a DM; if it's not clear which project you mean, I'll show a picker.\n" +
          `• *Schedule a digest* — \`${CMD} schedule weekdays 9:00 | what to report\` posts a recurring read-only summary here; manage with \`${CMD} routines\` (\`${CMD} routines all\` lists every project's jobs).\n` +
          "• *Jot a note* — start a message with `!` and I'll stay out of it (no agent run).\n" +
          '• *Stop me* — hit *✖ Cancel* on any working message.\n' +
          `• *Review a PR* — \`${CMD} review <PR url or #number> [low|med|high]\` posts a read-only review here (works in DMs too). \`${CMD} review auto on|off [effort]\` reviews new PRs automatically.\n` +
          `• *Watch a PR* — \`${CMD} autofix <PR>\` pings here on CI failures / new reviews with a *Fix* button (\`${CMD} autofix off <PR>\` / \`list\`).\n` +
          `• *What's here* — \`${CMD} access\` shows this channel's repos + tools.\n` +
          `• *Inspect my context* — \`${CMD} memory\` shows what I've learned, with a button per topic to drill in (\`${CMD} memory <topic>\` also works, \`${CMD} memory live\` reads the sandbox now, \`${CMD} memory log\` shows snapshot history); \`${CMD} prompt\` shows my system prompt.\n` +
          `• *Memory upkeep* — \`${CMD} dream on\`/\`off\` schedules (or pauses) nightly memory consolidation; \`${CMD} dream\` for status, \`${CMD} dream now\` to run it once.\n` +
          `• *Status* — \`${CMD} status\` for a live view of sandboxes, sessions, and open PRs.`,
      },
    },
    {
      type: 'context',
      elements: [
        { type: 'mrkdwn', text: 'I work on a dedicated branch and open a PR for review — I never push straight to the default branch.' },
      ],
    },
  );
  return blocks;
}

// ── Scheduled report jobs ─────────────────────────────────────────────────
// Timezone the cron schedules are evaluated in. Set AVEN_TZ (IANA, e.g. Europe/Zurich)
// in the runtime .env for local times; defaults to UTC.
const ROUTINE_TZ = process.env.AVEN_TZ || 'UTC';

// Prepended to every scheduled turn: these jobs report, they don't change anything.
// (Tools aren't hard-gated, so this is a strong instruction, not an enforced sandbox.)
// The bot's GitHub login (PRs it opens), so auto-review skips its own PRs. Matches the
// committer identity seeded in project.ts. NOTE: keep in sync if the App's bot changes.
const BOT_LOGIN = 'coach-aven[bot]';
// How often the PR pollers check (Socket Mode → poll, no webhooks).
const AUTO_REVIEW_POLL_MS = 180_000; // 3 min
const AUTOFIX_POLL_MS = 120_000; // 2 min

// Slack notification for an autofix watch event: what changed + a "Fix it" button that
// enqueues the write-turn (the button value carries everything the action handler needs).
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Slack block union
function autofixNotifyBlocks(w: PrWatch, notes: string[]): any[] {
  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `:wrench: *${w.repo.split('/')[1] ?? w.repo}#${w.number}* — ${notes.join('; ')}\n<https://github.com/${w.repo}/pull/${w.number}|View PR>`,
      },
    },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: '🔧 Fix it' },
          style: 'primary',
          action_id: 'autofix_apply',
          value: JSON.stringify({ slug: w.slug, repo: w.repo, number: w.number, channel: w.channel }),
        },
      ],
    },
  ];
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Slack block union
function routineListBlocks(rs: RoutineRecord[]): any[] {
  if (!rs.length) {
    return [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `_No scheduled jobs in this channel._\nCreate one: \`${CMD} schedule weekdays 9:00 | one-line status on open PRs and active threads\``,
        },
      },
    ];
  }
  const lines = rs.map((r) => {
    const dot = r.enabled ? '🟢' : '⚪️';
    const last = r.lastRunAt ? ` · last ${r.lastRunAt.slice(0, 16).replace('T', ' ')}` : '';
    if (r.kind === 'dream') {
      const s = r.lastSummary ? `\n   _${r.lastSummary}_` : '';
      return `${dot} *${r.id}* 🌙 dream — \`${r.spec}\` (${r.tz})${last}${s}`;
    }
    const p = r.prompt.length > 90 ? `${r.prompt.slice(0, 87)}…` : r.prompt;
    return `${dot} *${r.id}* — \`${r.spec}\` (${r.tz})${last}\n   ${p}`;
  });
  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Scheduled jobs*\n${lines.join('\n')}\n\n_Manage:_ \`${CMD} routines run|off|on|rm <id>\` (\`run\` = fire now) · \`${CMD} routines all\` for every project`,
      },
    },
  ];
}

// Fleet-wide view: every project's scheduled jobs, grouped by project, one section per project
// (avoids the 3000-char section cap when there are many). Channel shown as <#id> so it links.
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Slack block union
function allRoutinesBlocks(groups: { slug: string; routines: RoutineRecord[] }[]): any[] {
  const total = groups.reduce((n, g) => n + g.routines.length, 0);
  if (!total) {
    return [{ type: 'section', text: { type: 'mrkdwn', text: `_No scheduled jobs in any project yet._` } }];
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const blocks: any[] = [
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `*All scheduled jobs* · ${plural(total, 'job')} across ${plural(groups.length, 'project')}` },
    },
  ];
  for (const { slug, routines } of groups) {
    const lines = routines.map((r) => {
      const dot = r.enabled ? '🟢' : '⚪️';
      const kind = r.kind === 'dream' ? '🌙 dream' : 'digest';
      const last = r.lastRunAt ? ` · last ${r.lastRunAt.slice(0, 16).replace('T', ' ')}` : '';
      return `   ${dot} *${r.id}* ${kind} — \`${r.spec}\` in <#${r.channel}>${last}`;
    });
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `*${slug}*\n${lines.join('\n')}`.slice(0, 2900) } });
  }
  return blocks;
}

function info(msg: string): string {
  return `:information_source: ${msg}`;
}
// Set by runSlack when AVEN_ALERT_CHANNEL is configured: mirror operator-visible errors to a
// Slack channel (free-tier alerting that Sentry's free plan can't do). errText is the central
// error formatter, so every turn/command failure flows through here.
let alertSink: ((text: string) => void) | undefined;
function errText(err: unknown): string {
  const m = err instanceof Error ? err.message : String(err);
  log.error(m);
  captureError(err); // central error formatter → Sentry issue (with stack), no-op if Sentry off
  alertSink?.(m); // mirror to the alert channel if configured (no-op otherwise)
  return `:x: ${m}`.slice(0, MAX_SLACK_TEXT);
}
function summary(reg: ProjectsRegistry): string {
  const bound = reg.projects.filter((p) => p.slackChannel).length;
  return `${reg.projects.length} project(s), ${bound} channel-bound`;
}
