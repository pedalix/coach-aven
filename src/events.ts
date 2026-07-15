// Slack event + interaction surface: @mentions, thread replies, DMs (with the project
// picker), every button/select action, and the App Home tab. Thin by design — routing
// and payload normalization here, the actual work in the turn engine.

import type bolt from '@slack/bolt';
import type { Config } from './config.js';
import type { Store } from './state.js';
import { resolveBySlug, teamProjects, type RegistryRef } from './projects.js';
import { tenantOf, withTeam, normalizeTenant } from './teamkeys.js';
import { effectiveAccess, mayDrive, deniedText } from './access.js';
import { RecentSet } from './recent.js';
import { eventLog } from './eventlog.js';
import type { TurnEngine } from './turn.js';
import type { Channels } from './channels.js';
import { readMemory } from './commands.js';
import { FOLLOW_UP_PR_PROMPT, autofixPrompt, reportDraftPrompt, reportDeliveryContract } from './prompts.js';
import { extractSlackFiles, hydrateSlackFiles, type FileInfoFn, type SlackFile } from './slackfiles.js';
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
  onboardingHomeBlocks,
  dmPickerBlocks,
  questionBlocks,
  sessionPanelBlocks,
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
  // The home tenant id (resolved at boot in both modes). Session keys stay BARE for the
  // home workspace and carry a tenant prefix for every other one — see teamkeys.ts.
  homeTeamId?: string;
  // The tenant-gate predicate (slack.ts). The gate middleware passes block_actions
  // through for ack() reasons, so WRITE-capable button handlers re-check it here — an
  // offboarded workspace clicking a stale button must not fire a turn.
  servedTenant: (tenantId: string | undefined) => boolean;
}

// files.info bound to THIS envelope's workspace client: in a Slack Connect channel the
// tombstone hydration (see slackfiles.ts) must run — and the returned url_private_download
// is only readable — with that workspace's own bot token. Failures resolve null; the
// hydrator degrades them to a visible "skipped" note downstream.
const fileInfo =
  (client: bolt.webApi.WebClient): FileInfoFn =>
  async (id) => {
    try {
      return (await client.files.info({ file: id })).file ?? null;
    } catch (e) {
      log.error(`files.info ${id}: ${e instanceof Error ? e.message : String(e)}`);
      return null;
    }
  };

export function registerEvents(app: bolt.App, deps: EventDeps): void {
  const { cfg, store, reg, engine, channels, botUserId, homeTeamId, servedTenant } = deps;

  // DM project picks awaiting a dropdown choice: a DM with no project hint posts a picker;
  // the original question is parked here under a short id until the user selects a project.
  const pendingDmPicks = new Map<string, { channel: string; user: string; question: string }>();
  let dmPickSeq = 0;

  // ── actor gate (slice 4 §7.3): WHO inside a served workspace may DRIVE ──────
  // The tenant gate decides whether a WORKSPACE is served; this decides which USERS in it
  // may start/steer turns and post reports — vs only read along (trails, ticket modals,
  // memory stay open to viewers). Policy: home defaults open; a client team defaults to
  // an allowlist seeded with its installing user; `/aven users` manages it (access.ts).
  const actor = (tenant: string | undefined, userId: string | undefined) => {
    const isHome = normalizeTenant(tenant, homeTeamId) === undefined;
    const a = effectiveAccess(
      tenant ? store.getTeamAccess(tenant) : undefined,
      isHome,
      tenant ? store.installerOf(tenant) : undefined,
    );
    return { ok: mayDrive(a, userId), denial: deniedText(a) };
  };

  // ── Slack Connect double-envelope guard ─────────────────────────────────
  // In a shared channel with the app installed on BOTH sides, one message is delivered
  // once per installation (two envelopes, different team contexts). CLAIM-ON-ACT: an
  // envelope claims `${listener}:${channel}:${ts}` only at the moment its handler decides
  // to act — an envelope that exits early (no ChatRecord for its team, no project) never
  // claims, so the envelope of the team that actually owns the conversation still runs.
  // Per-listener keying keeps app_mention and message (already deduped by the selfId
  // check within one team) from racing each other.
  const claimedEvents = new RecentSet(10 * 60_000);
  const claimEvent = (listener: string, channel: string, ts: string): boolean => {
    const won = claimedEvents.claim(`${listener}:${channel}:${ts}`);
    // A lost claim IS the Slack Connect double-envelope in action — journal it (the
    // spike's key observable) when AVEN_EVENT_LOG is on.
    if (!won) eventLog?.append({ at: new Date().toISOString(), kind: listener, channel, ts, decision: 'claim-lost' });
    return won;
  };

  // ── @mention → public thread (one session per thread) ───────────────────────
  app.event('app_mention', async ({ event, client, context }) => {
    const e = event as { channel: string; ts: string; thread_ts?: string; text?: string; user?: string; files?: unknown[] };
    const threadTs = e.thread_ts || e.ts;
    // Files attached to the mentioning message (e.g. "@CoachAven look at this <screenshot>") —
    // the common channel pattern. Downloaded into the sandbox for the agent to Read. The
    // bearer is the EVENT's workspace bot token (context.botToken) — a client workspace's
    // files are only readable with that workspace's own token. Extraction here is sync and
    // presence-only; the files.info hydration waits until this envelope has WON the claim.
    const files: SlackFile[] = Array.isArray(e.files) ? extractSlackFiles(e.files) : [];
    const canAttach = files.length > 0 && !!context.botToken;
    const tenant = tenantOf(context);
    const { project, question, error } = await channels.pickProject(client, e.channel, stripMention(e.text ?? ''), tenant);
    if (error) {
      // Error replies claim their OWN namespace: in a shared channel the tenant that
      // can't resolve the project must not steal the claim from the one that can.
      if (!claimEvent('mention-err', e.channel, e.ts)) return;
      await client.chat.postMessage({ channel: e.channel, thread_ts: threadTs, text: info(error) });
      return;
    }
    // A bare mention with a file (no text) is a valid ask — only nag when there's neither.
    if (!question && !canAttach) {
      if (!claimEvent('mention', e.channel, e.ts)) return;
      await client.chat.postMessage({
        channel: e.channel,
        thread_ts: threadTs,
        text: info('Ask me something — `@CoachAven <task>`. I work in a thread and open a PR for review.'),
      });
      return;
    }
    // A mention is a deliberate act — a non-cleared user gets ONE explicit denial
    // (its own claim namespace: the denial must not steal the acting claim in a
    // Connect channel where the other side's envelope could still be entitled).
    const gate = actor(tenant, e.user);
    if (!gate.ok) {
      if (!claimEvent('mention-denied', e.channel, e.ts)) return;
      await client.chat.postMessage({ channel: e.channel, thread_ts: threadTs, text: gate.denial });
      return;
    }
    if (!claimEvent('mention', e.channel, e.ts)) return;
    const attachments = canAttach
      ? { refs: await hydrateSlackFiles(files, fileInfo(client)), bearer: context.botToken! }
      : undefined;
    const mentionQ = question || 'Please take a look at the attached file(s).';
    const key = withTeam(tenant, homeTeamId, `thread:${threadTs}`);
    await engine.liveTurn(client, e.channel, e.ts, threadTs, key, project!, mentionQ, attachments);
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
    // Sync + presence-only on purpose: this listener fires for EVERY message in every joined
    // channel, so the files.info hydration is deferred until a path below decides to act.
    const files: SlackFile[] = Array.isArray(m.files) ? extractSlackFiles(m.files) : [];
    const canAttach = files.length > 0 && !!context.botToken;
    const hydrate = async () =>
      canAttach ? { refs: await hydrateSlackFiles(files, fileInfo(client)), bearer: context.botToken! } : undefined;

    // Ignore edits/joins/topic-changes/etc. — but `thread_broadcast` is a genuine reply and
    // `file_share` is a real message carrying files, so let both fall through to the handling
    // below. (A file dropped WITH an @mention is handled by the app_mention branch above, which
    // carries its own files; the check below then bounces the duplicate message event.)
    if (m.subtype && m.subtype !== 'thread_broadcast' && m.subtype !== 'file_share') return;
    // Self-mention guard: the event's own workspace bot user id (per-team under OAuth);
    // the boot-time home-team id is only a fallback.
    const selfId = context.botUserId ?? botUserId;
    if (selfId && m.text?.includes(`<@${selfId}>`)) return; // app_mention handles these

    const tenant = tenantOf(context);

    // Direct message → private; needs a project hint (slug) since DMs aren't bound.
    if (m.channel_type === 'im') {
      const { project, question, error } = await channels.pickProject(client, m.channel, m.text ?? '', tenant);
      if (error) {
        // No project hint → offer a dropdown (of the TENANT's projects only) instead of
        // demanding a slug prefix. Park the question; the dm_pick_project handler runs it
        // once a project is chosen. (Attachments don't survive the picker in v1 — the
        // re-run has no files; rare enough to accept.)
        const mine = teamProjects(reg.current, tenant, homeTeamId);
        if (m.user && question && mine.length > 1) {
          const pid = `dp${++dmPickSeq}`;
          pendingDmPicks.set(pid, { channel: m.channel, user: m.user, question });
          await client.chat.postMessage({
            channel: m.channel,
            text: 'Which project?',
            blocks: dmPickerBlocks(pid, mine),
          });
        } else {
          await client.chat.postMessage({ channel: m.channel, text: info(error) });
        }
        return;
      }
      if (!m.user) return;
      // DMs are deliberate acts — explicit denial for non-cleared users.
      const dmGate = actor(tenant, m.user);
      if (!dmGate.ok) {
        await client.chat.postMessage({ channel: m.channel, text: dmGate.denial });
        return;
      }
      // A file with no text IS the message (drop a screenshot, expect a look) — only nag when
      // there's neither text nor an attachment.
      if (!question && !canAttach) {
        await client.chat.postMessage({
          channel: m.channel,
          text: info("I didn't catch a question — just type what you'd like me to do."),
        });
        return;
      }
      const dmQ = question || 'Please take a look at the attached file(s).';
      const dmKey = withTeam(tenant, homeTeamId, `dm:${m.channel}:${project!.slug}`);
      await engine.liveTurn(client, m.channel, m.ts, undefined, dmKey, project!, dmQ, await hydrate());
      return;
    }

    // Public channel/group: only continue a thread we already own (no re-@mention).
    // The key is built from THIS envelope's tenant — in a Slack Connect channel the other
    // side's envelope finds no ChatRecord under its key and exits here without claiming,
    // leaving the owning team's envelope to act (see claimEvent).
    if (!m.thread_ts) return;
    const key = withTeam(tenant, homeTeamId, `thread:${m.thread_ts}`);
    if (!engine.hasLive(key) && !store.getChat(key)) return;
    const { project, question, error } = await channels.pickProject(client, m.channel, m.text ?? '', tenant);
    if (error || !project) return;
    // Thread replies from non-cleared users are IGNORED silently: viewers discussing in
    // the thread must not drive the agent, but per-message denials would spam them.
    if (!actor(tenant, m.user).ok) return;
    if (!claimEvent('message', m.channel, m.ts)) return;
    if (!question && !canAttach) {
      await client.chat.postMessage({
        channel: m.channel,
        thread_ts: m.thread_ts,
        text: info("I didn't catch a question — what would you like me to do?"),
      });
      return;
    }
    const threadQ = question || 'Please take a look at the attached file(s).';
    await engine.liveTurn(client, m.channel, m.ts, m.thread_ts, key, project, threadQ, await hydrate());
  });

  // ── "✖ Cancel" button → abort that turn (the queued next one then starts) ───
  app.action('cancel_turn', async ({ ack, action, body, context, respond }) => {
    await ack();
    // Killing a running turn is steering — viewers don't get to do it either.
    const cGate = actor(tenantOf(context), (body as { user?: { id?: string } }).user?.id);
    if (!cGate.ok) {
      await respond({ response_type: 'ephemeral', replace_original: false, text: cGate.denial }).catch(() => {});
      return;
    }
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
  app.action('dm_pick_project', async ({ ack, action, client, body, context }) => {
    await ack();
    const sel = (action as { selected_option?: { value?: string } }).selected_option?.value ?? '';
    const i = sel.indexOf(':'); // value = "<pid>:<slug>"
    const pid = sel.slice(0, i);
    const slug = sel.slice(i + 1);
    const pending = pendingDmPicks.get(pid);
    // Validate the pick INSIDE the clicking tenant's subset — the dropdown only listed
    // those, but the action value is still client-supplied input.
    const tenant = tenantOf(context);
    const mine = { projects: teamProjects(reg.current, tenant, homeTeamId) };
    const project = slug ? resolveBySlug(mine, slug) : undefined;
    const b = body as { message?: { ts?: string } };
    if (!pending || !project) {
      if (b.message?.ts) {
        await client.chat
          .update({ channel: (body as { channel?: { id?: string } }).channel?.id ?? '', ts: b.message.ts, text: '⌛ This picker expired — send your message again.', blocks: [] })
          .catch(() => {});
      }
      return;
    }
    // The DM gate ran when the question was parked, but the CLICKER is client input too.
    const pickGate = actor(tenant, (body as { user?: { id?: string } }).user?.id);
    if (!pickGate.ok) {
      if (b.message?.ts) {
        await client.chat.update({ channel: pending.channel, ts: b.message.ts, text: pickGate.denial, blocks: [] }).catch(() => {});
      }
      return;
    }
    pendingDmPicks.delete(pid);
    if (b.message?.ts) {
      await client.chat
        .update({ channel: pending.channel, ts: b.message.ts, text: `▶️ Running on *${slug}*…`, blocks: [] })
        .catch(() => {});
    }
    const pickKey = withTeam(tenant, homeTeamId, `dm:${pending.channel}:${slug}`);
    await engine.liveTurn(client, pending.channel, undefined, undefined, pickKey, project, pending.question);
  });

  // ── "🔀 Open a PR" button → enqueue a follow-up turn asking the agent to PR its work ──
  app.action('make_pr', async ({ ack, action, client, context, body, respond }) => {
    await ack();
    if (!servedTenant(tenantOf(context))) return; // stale button in an offboarded workspace
    const prGate = actor(tenantOf(context), (body as { user?: { id?: string } }).user?.id);
    if (!prGate.ok) {
      await respond({ response_type: 'ephemeral', replace_original: false, text: prGate.denial }).catch(() => {});
      return;
    }
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

  // ── "⚙️ Session" → this thread's status card (session/repos/MCP/turn/PR), ephemeral ──
  // Read-only, so no actor gate — same tier as show_trail/ticket_modal (viewers may look).
  app.action('session_panel', async ({ ack, action, context, respond }) => {
    await ack();
    if (!servedTenant(tenantOf(context))) return; // stale button in an offboarded workspace
    const raw = (action as { value?: string }).value ?? '';
    let v: { key: string; channel: string; threadTs?: string };
    try {
      v = JSON.parse(raw);
    } catch {
      return;
    }
    const slug = engine.slugForKey(v.key);
    const project = slug ? resolveBySlug(reg.current, slug) : undefined;
    if (!project) return;
    const chat = store.getChat(v.key);
    await respond({
      response_type: 'ephemeral',
      text: `Session — ${project.slug}`,
      blocks: sessionPanelBlocks(
        {
          slug: project.slug,
          repos: project.repos,
          mcp: project.mcp?.map((m) => m.name),
          hasSession: !!chat?.sessionId,
          sessionSince: chat?.updatedAt,
          turnInFlight: engine.hasKey(v.key),
          prCreated: !!chat?.prCreated,
        },
        raw,
      ),
    }).catch(() => {});
  });

  // ── "🔄 Restart session" → forget this thread's Claude conversation; the next message ──
  // starts fresh. Gated like make_pr (mutating) — a viewer can look at the panel but not
  // reset it. Refuses while a turn is running (restarting mid-turn would race the live
  // ChatSession object the running turn still holds).
  app.action('session_restart', async ({ ack, action, context, body, respond }) => {
    await ack();
    if (!servedTenant(tenantOf(context))) return; // stale button in an offboarded workspace
    const gate = actor(tenantOf(context), (body as { user?: { id?: string } }).user?.id);
    if (!gate.ok) {
      await respond({ response_type: 'ephemeral', replace_original: false, text: gate.denial }).catch(() => {});
      return;
    }
    let v: { key: string; channel: string; threadTs?: string };
    try {
      v = JSON.parse((action as { value?: string }).value ?? '');
    } catch {
      return;
    }
    const slug = engine.slugForKey(v.key);
    const project = slug ? resolveBySlug(reg.current, slug) : undefined;
    if (!project) return;
    if (engine.hasKey(v.key)) {
      await respond({
        response_type: 'ephemeral',
        replace_original: true,
        text: ':information_source: A turn is running in this thread — cancel it first, then restart.',
      }).catch(() => {});
      return;
    }
    await engine.restartSession(v.key, project);
    await respond({
      response_type: 'ephemeral',
      replace_original: true,
      text: ':white_check_mark: Session restarted — the next message in this thread starts fresh.',
    }).catch(() => {});
  });

  // ── "📝 Report to YouTrack" → pop-up with the ACTUAL generation prompt to confirm/edit ──
  // Full transparency: the user sees and may edit the exact prompt that will run; a checkbox
  // skips the preview and posts the result straight to the ticket (internal, fail-closed).
  app.action('yt_report', async ({ ack, action, body, client, context, respond }) => {
    await ack();
    if (!servedTenant(tenantOf(context))) return; // stale button in an offboarded workspace
    const ytGate = actor(tenantOf(context), (body as { user?: { id?: string } }).user?.id);
    if (!ytGate.ok) {
      await respond({ response_type: 'ephemeral', replace_original: false, text: ytGate.denial }).catch(() => {});
      return;
    }
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
  app.view(YT_PROMPT_CALLBACK, async ({ ack, view, client, context, body }) => {
    await ack();
    if (!servedTenant(tenantOf(context))) return; // offboarded workspace — no draft turn
    // Silent re-check (the yt_report button already denied loudly; a modal reaching
    // submit without clearance means a stale/raced view — just don't run the turn).
    if (!actor(tenantOf(context), (body as { user?: { id?: string } }).user?.id).ok) return;
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
  app.view(YT_SEND_CALLBACK, async ({ ack, view, client, context, body }) => {
    await ack();
    // Posting to the client's ticket is a write — same silent re-check as the draft turn.
    if (!actor(tenantOf(context), (body as { user?: { id?: string } }).user?.id).ok) return;
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
  app.action('autofix_apply', async ({ ack, action, client, context, body, respond }) => {
    await ack();
    const tenant = tenantOf(context);
    if (!servedTenant(tenant)) return; // stale button in an offboarded workspace — no write turn
    const fixGate = actor(tenant, (body as { user?: { id?: string } }).user?.id);
    if (!fixGate.ok) {
      await respond({ response_type: 'ephemeral', replace_original: false, text: fixGate.denial }).catch(() => {});
      return;
    }
    let v: { slug: string; repo: string; number: number; channel: string };
    try {
      v = JSON.parse((action as { value?: string }).value ?? '');
    } catch {
      return;
    }
    const project = resolveBySlug(reg.current, v.slug);
    if (!project) return;
    // Tenant-prefixed like the subscribe path (commands.ts) — attribution, dedup and
    // restart recovery all resolve the clicking workspace's own token.
    const key = withTeam(tenant, homeTeamId, `autofix:${v.repo}:${v.number}:${v.slug}`);
    if (engine.hasKey(key)) return; // a fix is already running for this PR
    await engine.liveTurn(client, v.channel, undefined, undefined, key, project, autofixPrompt(v.repo, v.number));
  });

  // ── memory topic button → open that section file (journal copy first, no sandbox wake) ──
  app.action(/^mem_open:/, async ({ ack, action, respond, context }) => {
    await ack();
    // Memory contents are project data — a stale button in an offboarded workspace must
    // not stay an open read channel (same rule as the write buttons above).
    if (!servedTenant(tenantOf(context))) return;
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

  // ── install lifecycle: uninstall / token revocation → drop the dead installation ──
  // Only the INSTALLATION record is removed (its token is dead anyway) — the tenant's
  // data (chats/routines/usage) is deliberately kept for Store.exportTenant/purgeTenant,
  // which stay an explicit operator decision (offboarding may need the export first).
  app.event('app_uninstalled', async ({ context }) => {
    const tenant = tenantOf(context);
    if (!tenant) return;
    const removed = store.deleteInstallation(tenant);
    log.warn(`app_uninstalled by ${tenant} — installation ${removed ? 'removed' : 'not found'}; data kept (purge is manual)`);
  });
  app.event('tokens_revoked', async ({ context, event }) => {
    const tenant = tenantOf(context);
    // Only a BOT token revocation kills the installation; user-token revocations don't
    // affect us (we never store user tokens).
    const revokedBots = (event as { tokens?: { bot?: string[] } }).tokens?.bot ?? [];
    if (!tenant || !revokedBots.length) return;
    const removed = store.deleteInstallation(tenant);
    log.warn(`tokens_revoked (bot) by ${tenant} — installation ${removed ? 'removed' : 'not found'}; data kept (purge is manual)`);
  });

  // ── App Home tab → a self-documenting dashboard: projects, channels, how to use me ──
  app.event('app_home_opened', async ({ event, client, context }) => {
    const e = event as { user: string; tab?: string };
    if (e.tab && e.tab !== 'home') return; // ignore the messages-tab open
    // Per-tenant dashboard: only the viewer workspace's projects. An installed-but-
    // unmapped workspace (the gate lets app_home_opened through) gets the onboarding
    // view — as does EVERYONE while home is unresolved (first OAuth boot, fail closed:
    // teamProjects would otherwise treat any viewer as home and leak the fleet).
    const mine = servedTenant(tenantOf(context)) ? teamProjects(reg.current, tenantOf(context), homeTeamId) : [];
    try {
      await client.views.publish({
        user_id: e.user,
        view: { type: 'home', blocks: mine.length ? homeBlocks(mine, channels.prefixFor(tenantOf(context))) : onboardingHomeBlocks() },
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
  app.action(/^answer_q:/, async ({ ack, action, client, body, context, respond }) => {
    await ack();
    // Answering steers the running turn — same clearance as starting one.
    const qGate = actor(tenantOf(context), (body as { user?: { id?: string } }).user?.id);
    if (!qGate.ok) {
      await respond({ response_type: 'ephemeral', replace_original: false, text: qGate.denial }).catch(() => {});
      return;
    }
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
  app.action(/^submit_q:/, async ({ ack, action, client, body, context, respond }) => {
    await ack();
    const sGate = actor(tenantOf(context), (body as { user?: { id?: string } }).user?.id);
    if (!sGate.ok) {
      await respond({ response_type: 'ephemeral', replace_original: false, text: sGate.denial }).catch(() => {});
      return;
    }
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
