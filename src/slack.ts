import bolt from '@slack/bolt';
import type { Config } from './config.js';
import { Store } from './state.js';
import {
  loadProjects,
  resolveByChannel,
  resolveBySlug,
  type ProjectConfig,
  type ProjectsRegistry,
} from './projects.js';
import { openChat, type ChatSession } from './tasks.js';
import { makeDaytona, listSandboxStates } from './daytona.js';
import { countOpenPRs } from './github.js';
import type { AskQuestion, QuestionAnswers, OnQuestion } from './claudeSession.js';
import { log } from './log.js';

const { App } = bolt;

// Slack hard-caps a single message at 40k chars; leave headroom.
const MAX_SLACK_TEXT = 39000;
const THINKING = ':hourglass_flowing_sand: thinking…';

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
  let turnSeq = 0;

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
    const chat = await sessionFor(key, project);
    const answer = await chat.ask(question);
    persist(key, project.slug, chat);
    return answer.slice(0, MAX_SLACK_TEXT) || '(no output)';
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

    const projects: ProjectStatus[] = registry.projects.map((p, i) => ({
      slug: p.slug,
      repos: p.repos.length,
      state: states.get(`${cfg.sandbox.namePrefix}${p.slug}`),
      sessions: sessionsBySlug.get(p.slug) ?? 0,
      active: activeBySlug.get(p.slug) ?? 0,
      openPRs: prCounts[i],
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
      const answer = await chat.ask(
        question,
        (step) => {
          steps.push(step);
          void flush();
        },
        ac.signal,
        makeOnQuestion(client, channel, threadTs, ac.signal, (qid) => turnQs.add(qid)),
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
        await client.chat.postMessage({ channel: m.channel, text: info(error) });
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
  app.command('/aven', async ({ command, ack, respond, client }) => {
    await ack(); // Slack needs an ack within 3s; the real work runs after.

    // `/aven status` → a live ops snapshot (sandboxes, sessions, in-flight turns, PRs).
    // Reserved keyword, intercepted before project resolution so it works in ANY channel
    // (it's a fleet-wide view, not bound to one project).
    if ((command.text ?? '').trim().toLowerCase() === 'status') {
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

    const { project, question, error } = await pickProject(client, command.channel_id, command.text ?? '');
    if (error) {
      await respond({ response_type: 'ephemeral', text: info(error) });
      return;
    }
    if (!question) {
      await respond({ response_type: 'ephemeral', text: 'Ask me something: `/aven <your question>`' });
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

  // ── "🔀 Open a PR" button → enqueue a follow-up turn asking the agent to PR its work ──
  const FOLLOW_UP_PR_PROMPT =
    'Open a pull request for the work in this conversation: in the relevant repo, make sure your ' +
    'changes are committed on a dedicated worktree/branch forked from origin/main, push it, and open ' +
    'a PR against the default branch with the gh CLI. If there is nothing to submit yet, say so ' +
    'instead of opening an empty PR.';
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

  await app.start();
  log.info(`Slack bot running (Socket Mode) — ${summary(registry)}`);
  void resumeInflightTurns();
}

// Slack's `markdown` block renders standard Markdown (bold, headers, lists, links,
// tables) natively — so we send Claude's output verbatim instead of converting to
// the lossy legacy mrkdwn. Each markdown block caps ~12k chars; chunk longer answers.
const SLACK_MD_BLOCK_LIMIT = 11900;

// Pull GitHub PR URLs out of an answer so we can surface them as clickable buttons
// instead of leaving them buried in prose. Deduped, original order.
function prUrls(text: string): string[] {
  const m = text.match(/https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/g);
  return m ? [...new Set(m)] : [];
}

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
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Slack 'markdown' block not yet in SDK block union
function answerBlocks(answer: string, followUp?: FollowUp): any[] {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const blocks: any[] = [];
  for (let i = 0; i < answer.length; i += SLACK_MD_BLOCK_LIMIT) {
    blocks.push({ type: 'markdown', text: answer.slice(i, i + SLACK_MD_BLOCK_LIMIT) });
  }
  if (!blocks.length) blocks.push({ type: 'markdown', text: '(no output)' });

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
    return `• *${p.slug}* — ${bits.join(' · ')}`;
  });
  const health = `_Daytona ${r.daytonaOk ? '✅' : '⚠️'} · GitHub ${r.githubOk ? '✅' : '⚠️'} · Slack ✅_`;
  return [{ type: 'section', text: { type: 'mrkdwn', text: `${head}\n\n${lines.join('\n')}\n\n${health}` } }];
}

// ── App Home tab ────────────────────────────────────────────────────────────
// "Org/name" → "name", for compact display.
const shortRepo = (full: string): string => full.split('/').pop() ?? full;

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
          '• *Build / collaborate* — `@CoachAven <task>` in a project channel. I reply in a thread; keep replying (no need to re-mention) and I remember the conversation.\n' +
          '• *Quick private answer* — `/aven <question>` in a project channel. I answer privately in our DM.\n' +
          "• *Jot a note* — start a message with `!` and I'll stay out of it (no agent run).\n" +
          '• *Stop me* — hit *✖ Cancel* on any working message.\n' +
          '• *Status* — `/aven status` for a live view of sandboxes, sessions, and open PRs.',
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

// Plain-text fallback (notifications / accessibility) required alongside blocks.
function fallbackText(answer: string): string {
  const line = answer.split('\n').find((l) => l.trim()) ?? 'Answer';
  return line.replace(/[*_`#>~[\]()]/g, '').slice(0, 200) || 'Answer';
}

function fmtElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`;
}

function stripMention(text: string): string {
  return text.replace(/<@[^>]+>/g, '').trim();
}
function info(msg: string): string {
  return `:information_source: ${msg}`;
}
function errText(err: unknown): string {
  const m = err instanceof Error ? err.message : String(err);
  log.error(m);
  return `:x: ${m}`.slice(0, MAX_SLACK_TEXT);
}
function summary(reg: ProjectsRegistry): string {
  const bound = reg.projects.filter((p) => p.slackChannel).length;
  return `${reg.projects.length} project(s), ${bound} channel-bound`;
}
