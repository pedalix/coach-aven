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
  let questionSeq = 0;

  function answeredAll(entry: PendingQuestion): boolean {
    return entry.questions.every((_, qi) => (entry.picks.get(qi)?.size ?? 0) > 0);
  }
  // Resolve a question: project picks → answers (question text → comma-joined labels,
  // the verified wire format), mark done, and remove from the registry.
  function finalizeQuestion(entry: PendingQuestion, qid: string): void {
    entry.done = true;
    pendingQuestions.delete(qid);
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
    return (questions) =>
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
          const onAbort = () => {
            if (entry.done || !pendingQuestions.delete(qid)) return;
            entry.done = true;
            void client.chat
              .update({ channel, ts: entry.ts, text: '🚫 Canceled', blocks: [] })
              .catch(() => {});
            reject(new Error('canceled'));
          };
          if (signal.aborted) onAbort();
          else signal.addEventListener('abort', onAbort, { once: true });
        })().catch(reject);
      });
  }

  async function sessionFor(key: string, project: ProjectConfig): Promise<ChatSession> {
    const existing = live.get(key);
    if (existing) return existing;
    const prior = store.getChat(key);
    const chat = await openChat(cfg, store, {
      slug: project.slug,
      repos: project.repos,
      resumeSessionId: prior?.sessionId,
    });
    live.set(key, chat);
    return chat;
  }

  function persist(key: string, slug: string, chat: ChatSession): void {
    store.setChat({
      threadTs: key,
      slug,
      sessionId: chat.sessionId(),
      updatedAt: new Date().toISOString(),
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

    try {
      const chat = await sessionFor(key, project); // prepare (warm sandbox + clone) here
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
      await client.chat.update({ channel, ts, text: fallbackText(capped), blocks: answerBlocks(capped) });
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
    if (!entry || entry.done) return void markStale(client, body);

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
    if (!entry || entry.done) return void markStale(client, body);
    if (!answeredAll(entry)) return; // ignore until every question has a selection
    await client.chat
      .update({ channel: entry.channel, ts: entry.ts, text: '✅ Answered', blocks: questionBlocks(entry.questions, entry.picks, entry.multi, v.qid, true) })
      .catch(() => {});
    finalizeQuestion(entry, v.qid);
  });

  await app.start();
  log.info(`Slack bot running (Socket Mode) — ${summary(registry)}`);
}

// Slack's `markdown` block renders standard Markdown (bold, headers, lists, links,
// tables) natively — so we send Claude's output verbatim instead of converting to
// the lossy legacy mrkdwn. Each markdown block caps ~12k chars; chunk longer answers.
const SLACK_MD_BLOCK_LIMIT = 11900;
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Slack 'markdown' block not yet in SDK block union
function answerBlocks(answer: string): any[] {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const blocks: any[] = [];
  for (let i = 0; i < answer.length; i += SLACK_MD_BLOCK_LIMIT) {
    blocks.push({ type: 'markdown', text: answer.slice(i, i + SLACK_MD_BLOCK_LIMIT) });
  }
  return blocks.length ? blocks : [{ type: 'markdown', text: '(no output)' }];
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
