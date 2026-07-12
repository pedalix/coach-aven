// Slack event + interaction surface: @mentions, thread replies, DMs (with the project
// picker), every button/select action, and the App Home tab. Thin by design — routing
// and payload normalization here, the actual work in the turn engine.

import type bolt from '@slack/bolt';
import type { Config } from './config.js';
import type { Store } from './state.js';
import { resolveBySlug, type RegistryRef } from './projects.js';
import type { TurnEngine } from './turn.js';
import type { Channels } from './channels.js';
import { readMemory } from './commands.js';
import { FOLLOW_UP_PR_PROMPT, autofixPrompt, reportDraftPrompt, reportDeliveryContract } from './prompts.js';
import type { AttachmentRef } from './attachments.js';
import { projectCwd } from './project.js';
import { memoryFilePath } from './memory.js';
import { memoryRepoDir, readSnapshotFile } from './memjournal.js';
import { stripMention, mdToMrkdwn } from './format.js';
import { getIssue, listComments, listAttachments, postInternalComment } from './youtrack.js';
import {
  MAX_SLACK_TEXT,
  info,
  errText,
  homeBlocks,
  dmPickerBlocks,
  questionBlocks,
  trailModalView,
  ticketLoadingView,
  ticketModalView,
  ticketUnavailableView,
  textFromMarkdownBlocks,
  reportModalView,
  reportExpiredView,
  reportPromptModalView,
  reportPostedBlocks,
  YT_SEND_CALLBACK,
  YT_SEND_INPUT,
  YT_PROMPT_CALLBACK,
  YT_PROMPT_INPUT,
  YT_PROMPT_NOW,
} from './blocks.js';
import { log } from './log.js';

export interface EventDeps {
  cfg: Config;
  store: Store;
  reg: RegistryRef;
  engine: TurnEngine;
  channels: Channels;
  // The HOME workspace's bot user id (fallback only) — under OAuth each event's own
  // context.botUserId is the authoritative self-id for that workspace.
  botUserId?: string;
}

// Map raw Slack file objects (untyped on the message event) to source-agnostic AttachmentRefs.
// We prefer `url_private_download` (raw bytes) and fall back to `url_private`; files with
// neither (e.g. external/link "files") are dropped. The admission allowlist/caps run later in
// planIngest — here we only normalize shape.
function slackFilesToRefs(files: unknown[]): AttachmentRef[] {
  const out: AttachmentRef[] = [];
  for (const f of files) {
    const o = (f ?? {}) as {
      url_private_download?: string;
      url_private?: string;
      name?: string;
      title?: string;
      mimetype?: string;
      size?: number;
    };
    const url = o.url_private_download || o.url_private;
    if (!url) continue;
    out.push({ name: o.name || o.title || 'file', url, mime: o.mimetype ?? '', size: o.size ?? 0 });
  }
  return out;
}

export function registerEvents(app: bolt.App, deps: EventDeps): void {
  const { cfg, store, reg, engine, channels, botUserId } = deps;

  // DM project picks awaiting a dropdown choice: a DM with no project hint posts a picker;
  // the original question is parked here under a short id until the user selects a project.
  const pendingDmPicks = new Map<string, { channel: string; user: string; question: string }>();
  let dmPickSeq = 0;

  // ── @mention → public thread (one session per thread) ───────────────────────
  app.event('app_mention', async ({ event, client, context }) => {
    const e = event as { channel: string; ts: string; thread_ts?: string; text?: string; files?: unknown[] };
    const threadTs = e.thread_ts || e.ts;
    // Files attached to the mentioning message (e.g. "@CoachAven look at this <screenshot>") —
    // the common channel pattern. Downloaded into the sandbox for the agent to Read. The
    // bearer is the EVENT's workspace bot token (context.botToken) — a client workspace's
    // files are only readable with that workspace's own token.
    const files = Array.isArray(e.files) ? slackFilesToRefs(e.files) : [];
    const attachments = files.length && context.botToken ? { refs: files, bearer: context.botToken } : undefined;
    const { project, question, error } = await channels.pickProject(client, e.channel, stripMention(e.text ?? ''));
    if (error) {
      await client.chat.postMessage({ channel: e.channel, thread_ts: threadTs, text: info(error) });
      return;
    }
    // A bare mention with a file (no text) is a valid ask — only nag when there's neither.
    if (!question && !attachments) {
      await client.chat.postMessage({
        channel: e.channel,
        thread_ts: threadTs,
        text: info('Ask me something — `@CoachAven <task>`. I work in a thread and open a PR for review.'),
      });
      return;
    }
    const mentionQ = question || 'Please take a look at the attached file(s).';
    await engine.liveTurn(client, e.channel, e.ts, threadTs, `thread:${threadTs}`, project!, mentionQ, attachments);
  });

  // ── thread reply (owned) → continue;  DM → private conversation ─────────────
  app.message(async ({ message, client, context }) => {
    const m = message as {
      subtype?: string;
      bot_id?: string;
      channel: string;
      channel_type?: string;
      user?: string;
      text?: string;
      ts: string;
      thread_ts?: string;
      files?: unknown[];
    };
    if (m.bot_id) return; // ignore other bots / our own posts

    // Attachments (screenshots, PDFs, docs) arrive with a `subtype: 'file_share'` and a `files`
    // array. We download them into the sandbox for the agent to Read (see doTurn → chat.ingest);
    // here we just extract the refs and let the message flow through the SAME routing as text —
    // so the DM/owned-thread gates still decide whether we engage (we never barge in elsewhere).
    const files = Array.isArray(m.files) ? slackFilesToRefs(m.files) : [];
    const attachments = files.length && context.botToken ? { refs: files, bearer: context.botToken } : undefined;

    // Ignore edits/joins/topic-changes/etc. — but `thread_broadcast` is a genuine reply and
    // `file_share` is a real message carrying files, so let both fall through to the handling
    // below. (A file dropped WITH an @mention is handled by the app_mention branch above, which
    // carries its own files; the check below then bounces the duplicate message event.)
    if (m.subtype && m.subtype !== 'thread_broadcast' && m.subtype !== 'file_share') return;
    // Self-mention guard: the event's own workspace bot user id (per-team under OAuth);
    // the boot-time home-team id is only a fallback.
    const selfId = context.botUserId ?? botUserId;
    if (selfId && m.text?.includes(`<@${selfId}>`)) return; // app_mention handles these

    // Direct message → private; needs a project hint (slug) since DMs aren't bound.
    if (m.channel_type === 'im') {
      const { project, question, error } = await channels.pickProject(client, m.channel, m.text ?? '');
      if (error) {
        // No project hint → offer a dropdown instead of demanding a slug prefix. Park the
        // question; the dm_pick_project handler runs it once a project is chosen. (Attachments
        // don't survive the picker in v1 — the re-run has no files; rare enough to accept.)
        if (m.user && question && reg.current.projects.length > 1) {
          const pid = `dp${++dmPickSeq}`;
          pendingDmPicks.set(pid, { channel: m.channel, user: m.user, question });
          await client.chat.postMessage({
            channel: m.channel,
            text: 'Which project?',
            blocks: dmPickerBlocks(pid, reg.current.projects),
          });
        } else {
          await client.chat.postMessage({ channel: m.channel, text: info(error) });
        }
        return;
      }
      if (!m.user) return;
      // A file with no text IS the message (drop a screenshot, expect a look) — only nag when
      // there's neither text nor an attachment.
      if (!question && !attachments) {
        await client.chat.postMessage({
          channel: m.channel,
          text: info("I didn't catch a question — just type what you'd like me to do."),
        });
        return;
      }
      const dmQ = question || 'Please take a look at the attached file(s).';
      await engine.liveTurn(client, m.channel, m.ts, undefined, `dm:${m.channel}:${project!.slug}`, project!, dmQ, attachments);
      return;
    }

    // Public channel/group: only continue a thread we already own (no re-@mention).
    if (!m.thread_ts) return;
    const key = `thread:${m.thread_ts}`;
    if (!engine.hasLive(key) && !store.getChat(key)) return;
    const { project, question, error } = await channels.pickProject(client, m.channel, m.text ?? '');
    if (error || !project) return;
    if (!question && !attachments) {
      await client.chat.postMessage({
        channel: m.channel,
        thread_ts: m.thread_ts,
        text: info("I didn't catch a question — what would you like me to do?"),
      });
      return;
    }
    const threadQ = question || 'Please take a look at the attached file(s).';
    await engine.liveTurn(client, m.channel, m.ts, m.thread_ts, key, project, threadQ, attachments);
  });

  // ── "✖ Cancel" button → abort that turn (the queued next one then starts) ───
  app.action('cancel_turn', async ({ ack, action }) => {
    await ack();
    const turnId = (action as { value?: string }).value;
    if (turnId) engine.cancel(turnId);
  });

  // ── "🔗 View PR" link button → opens the URL itself; just ack the interaction ──
  app.action(/^pr_link:/, async ({ ack }) => {
    await ack();
  });

  // ── "🧭 Show steps" → the turn's tool-call trail in a modal, live or settled ──
  // The trail lives in the engine's bounded in-memory registry (the button carries just the
  // turnId), so a click after eviction or a restart degrades to an "expired" note.
  app.action('show_trail', async ({ ack, action, body, client }) => {
    await ack();
    const trigger = (body as { trigger_id?: string }).trigger_id;
    if (!trigger) return;
    const t = engine.trail((action as { value?: string }).value ?? '');
    await client.views
      .open({ trigger_id: trigger, view: trailModalView(t) })
      .catch((e) => log.error(`show_trail: ${e instanceof Error ? e.message : String(e)}`));
  });

  // ── "🔍 Full ticket" button → the whole YouTrack ticket in a modal ──────────
  // trigger_id expires in 3s, so open a loading shell immediately and swap the real content
  // in once YouTrack answers. Fetched fresh by id (never a cached snapshot) so the comment
  // thread is current; on any fetch failure the modal degrades to a link.
  app.action('ticket_modal', async ({ ack, action, body, client }) => {
    await ack();
    const id = (action as { value?: string }).value ?? '';
    const trigger = (body as { trigger_id?: string }).trigger_id;
    if (!id || !trigger) return;
    const opened = await client.views
      .open({ trigger_id: trigger, view: ticketLoadingView(id) })
      .catch((e) => {
        log.error(`ticket_modal ${id}: open failed: ${e instanceof Error ? e.message : String(e)}`);
        return null;
      });
    const viewId = opened?.view?.id;
    if (!viewId) return;
    const ticketUrl = `${(cfg.youtrack?.baseUrl ?? '').replace(/\/$/, '')}/issue/${id}`;
    const [issue, comments, attachments] = await Promise.all([getIssue(cfg, id), listComments(cfg, id), listAttachments(cfg, id)]);
    await client.views
      .update({
        view_id: viewId,
        view: issue
          ? ticketModalView(issue, ticketUrl, comments, attachments.map((a) => a.name))
          : ticketUnavailableView(id, ticketUrl),
      })
      .catch((e) => log.error(`ticket_modal ${id}: update failed: ${e instanceof Error ? e.message : String(e)}`));
  });

  // ── DM project dropdown → run the parked question against the chosen project ──
  app.action('dm_pick_project', async ({ ack, action, client, body }) => {
    await ack();
    const sel = (action as { selected_option?: { value?: string } }).selected_option?.value ?? '';
    const i = sel.indexOf(':'); // value = "<pid>:<slug>"
    const pid = sel.slice(0, i);
    const slug = sel.slice(i + 1);
    const pending = pendingDmPicks.get(pid);
    const project = slug ? resolveBySlug(reg.current, slug) : undefined;
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
    await engine.liveTurn(client, pending.channel, undefined, undefined, `dm:${pending.channel}:${slug}`, project, pending.question);
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
    const slug = engine.slugForKey(v.key);
    const project = slug ? resolveBySlug(reg.current, slug) : undefined;
    if (!project) return;
    await engine.liveTurn(client, v.channel, undefined, v.threadTs, v.key, project, FOLLOW_UP_PR_PROMPT);
  });


  // ── "📝 Report to YouTrack" → pop-up with the ACTUAL generation prompt to confirm/edit ──
  // Full transparency: the user sees and may edit the exact prompt that will run; a checkbox
  // skips the preview and posts the result straight to the ticket (internal, fail-closed).
  app.action('yt_report', async ({ ack, action, body, client }) => {
    await ack();
    let v: { t: string; key: string; channel: string; threadTs?: string };
    try {
      v = JSON.parse((action as { value?: string }).value ?? '');
    } catch {
      return;
    }
    const trigger = (body as { trigger_id?: string }).trigger_id;
    if (!trigger) return;
    await client.views
      .open({
        trigger_id: trigger,
        view: reportPromptModalView(v.t, reportDraftPrompt(v.t), reportDeliveryContract(v.t), { key: v.key, channel: v.channel, threadTs: v.threadTs }),
      })
      .catch((e) => log.error(`yt_report ${v.t}: ${e instanceof Error ? e.message : String(e)}`));
  });

  // ── prompt modal submit → run the draft turn with the (possibly edited) instructions ──
  // The delivery contract is re-appended HERE, not trusted from the modal: the instructions
  // input is fully editable and users do replace it with one-liners ("report that it is
  // live") that would otherwise drop "output ONLY the comment text" — the agent then chats
  // about its read-only YouTrack MCP and auto-post ships that preamble to the ticket.
  // "Post immediately" checked → hand the turn an autoPost hook: the answer goes straight to
  // the ticket, and on failure turn.ts degrades it to the reviewable draft with the error.
  app.view(YT_PROMPT_CALLBACK, async ({ ack, view, client }) => {
    await ack();
    let meta: { t: string; key: string; channel: string; threadTs?: string };
    try {
      meta = JSON.parse(view.private_metadata || '');
    } catch {
      return;
    }
    const instructions = (view.state.values[YT_PROMPT_INPUT.block]?.[YT_PROMPT_INPUT.action]?.value ?? '').trim();
    if (!instructions) return;
    const prompt = `${instructions}\n\n${reportDeliveryContract(meta.t)}`;
    const now = (view.state.values[YT_PROMPT_NOW.block]?.[YT_PROMPT_NOW.action]?.selected_options ?? []).some(
      (o: { value?: string }) => o.value === YT_PROMPT_NOW.value,
    );
    const slug = engine.slugForKey(meta.key);
    const project = slug ? resolveBySlug(reg.current, slug) : undefined;
    if (!project) return;
    await engine.liveTurn(client, meta.channel, undefined, meta.threadTs, meta.key, project, prompt, undefined, {
      ytDraftFor: meta.t,
      autoPost: now
        ? async (text) => {
            const posted = await postInternalComment(cfg, meta.t, text);
            store.markReported(meta.t);
            return posted;
          }
        : undefined,
    });
  });

  // ── "✏️ Edit & send" on a draft → modal pre-filled with the draft text ──────────────
  // The text comes from the engine's draft store (the button carries only the draftId):
  // Slack converts `markdown` blocks to `rich_text` on delivery, so the message's own blocks
  // can't round-trip the draft — they serve only as a best-effort fallback. After a restart
  // both are gone → an honest "expired" modal. trigger_id is fresh → opens instantly.
  app.action('yt_edit_send', async ({ ack, action, body, client }) => {
    await ack();
    let v: { t: string; d: string };
    try {
      v = JSON.parse((action as { value?: string }).value ?? '');
    } catch {
      return;
    }
    const b = body as {
      trigger_id?: string;
      channel?: { id?: string };
      message?: { ts?: string; thread_ts?: string; blocks?: unknown[] };
    };
    if (!v.t || !b.trigger_id || !b.channel?.id || !b.message?.ts) return;
    const draft = engine.ytDraft(v.d) ?? textFromMarkdownBlocks((b.message.blocks ?? []) as never[]);
    await client.views
      .open({
        trigger_id: b.trigger_id,
        view: draft.trim()
          ? reportModalView(v.t, draft, { channel: b.channel.id, ts: b.message.ts, threadTs: b.message.thread_ts })
          : reportExpiredView(v.t),
      })
      .catch((e) => log.error(`yt_edit_send ${v.t}: ${e instanceof Error ? e.message : String(e)}`));
  });

  // ── report modal submit → post the (possibly edited) text as an INTERNAL ticket comment ──
  // ack() first (Slack wants it <3s; the modal closes), then post. Success rewrites the draft
  // message into a confirmation; failure lands in the thread — including the fail-closed
  // "no unambiguous team group" refusal and a 403 when the token lacks Create Comment.
  app.view(YT_SEND_CALLBACK, async ({ ack, view, client }) => {
    await ack();
    let meta: { t: string; channel: string; ts: string; threadTs?: string };
    try {
      meta = JSON.parse(view.private_metadata || '');
    } catch {
      return;
    }
    const text = (view.state.values[YT_SEND_INPUT.block]?.[YT_SEND_INPUT.action]?.value ?? '').trim();
    if (!text) return;
    try {
      const posted = await postInternalComment(cfg, meta.t, text);
      store.markReported(meta.t);
      await client.chat.update({
        channel: meta.channel,
        ts: meta.ts,
        text: `✅ Reported to ${meta.t}`,
        blocks: reportPostedBlocks(text, meta.t, posted.url, posted.group),
      });
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e);
      log.error(`yt_send ${meta.t}: ${why}`);
      await client.chat
        .postMessage({
          channel: meta.channel,
          thread_ts: meta.threadTs ?? meta.ts,
          text: `⚠️ Couldn't post the report to ${meta.t}: ${why.slice(0, 500)}\nThe draft above is untouched — fix the cause and hit ✏️ Edit & send again.`,
        })
        .catch(() => {});
    }
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
    const project = resolveBySlug(reg.current, v.slug);
    if (!project) return;
    const key = `autofix:${v.repo}:${v.number}:${v.slug}`;
    if (engine.hasKey(key)) return; // a fix is already running for this PR
    await engine.liveTurn(client, v.channel, undefined, undefined, key, project, autofixPrompt(v.repo, v.number));
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
    const project = resolveBySlug(reg.current, v.s);
    const fp = project && memoryFilePath(projectCwd(cfg, project.slug, project.repos), v.f);
    if (!project || !fp) return;
    try {
      let text = await readSnapshotFile(memoryRepoDir(project.slug), v.f).catch(() => null);
      if (text == null) text = await readMemory(cfg, project, fp, false); // not journaled → live (no wake)
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
        view: { type: 'home', blocks: homeBlocks(reg.current, channels.prefix) },
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
    const entry = engine.questions.get(v.qid);
    if (!entry || entry.done) {
      if (!engine.questions.isCompleted(v.qid)) await markStale(client, body);
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
    if (!entry.multi && engine.questions.answeredAll(entry)) {
      await client.chat
        .update({ channel: entry.channel, ts: entry.ts, text: '✅ Answered', blocks: questionBlocks(entry.questions, entry.picks, entry.multi, v.qid, true) })
        .catch(() => {});
      engine.questions.finalize(entry, v.qid);
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
    const entry = engine.questions.get(v.qid);
    if (!entry || entry.done) {
      if (!engine.questions.isCompleted(v.qid)) await markStale(client, body);
      return;
    }
    if (!engine.questions.answeredAll(entry)) return; // ignore until every question has a selection
    await client.chat
      .update({ channel: entry.channel, ts: entry.ts, text: '✅ Answered', blocks: questionBlocks(entry.questions, entry.picks, entry.multi, v.qid, true) })
      .catch(() => {});
    engine.questions.finalize(entry, v.qid);
  });
}
