// Slack event + interaction surface: @mentions, thread replies, DMs (with the project
// picker), every button/select action, modal submissions and the App Home tab. Thin by
// design — Slack payloads are normalized here; what an interaction DOES lives in the
// platform-neutral core (src/chat/core/interactions.ts), the actual work in the turn engine.

import type bolt from '@slack/bolt';
import { slackDriver, type SlackActionCtx } from './driver.js';
import type { ChatAction, DialogSubmit } from '../driver.js';
import { createActorGate } from '../core/gates.js';
import { createInteractions } from '../core/interactions.js';
import type { Config } from '../../config.js';
import type { Store } from '../../state.js';
import { teamProjects, type RegistryRef } from '../../projects.js';
import { tenantOf, withTeam } from '../../teamkeys.js';
import { RecentSet } from '../../recent.js';
import { eventLog } from '../../eventlog.js';
import type { TurnEngine } from '../../turn.js';
import type { Channels } from '../../channels.js';
import { extractSlackFiles, hydrateSlackFiles, type FileInfoFn, type SlackFile } from '../../slackfiles.js';
import { stripMention } from '../../format.js';
import {
  info,
  dmPickerBlocks,
  textFromMarkdownBlocks,
  FB_CALLBACK,
  FB_REASON,
  FB_NOTE,
  YT_SEND_CALLBACK,
  YT_SEND_INPUT,
  YT_PROMPT_CALLBACK,
  YT_PROMPT_INPUT,
  YT_PROMPT_NOW,
} from './blocks.js';
import { dispatch, proposalBlocks, proposalText } from '../../dispatch.js';
import type { Dispatcher } from '../../dispatchrun.js';
import { log } from '../../log.js';

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
  // Dispatch primitive (DISPATCH=1): Send / Dismiss on a proposal (dispatchrun.ts).
  dispatcher?: Dispatcher;
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

  // The actor gate and every interaction's logic live in the platform-neutral core
  // (src/chat/core/); this file normalizes Slack payloads into it.
  const actor = createActorGate(store, homeTeamId);
  const core = createInteractions({
    cfg,
    store,
    reg,
    engine,
    homeTeamId,
    servedTenant,
    actor,
    prefixFor: (t: string | undefined) => channels.prefixFor(t),
  });

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
    await engine.liveTurn(slackDriver(client), e.channel, e.ts, threadTs, key, project!, mentionQ, attachments);
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
          const pid = core.parkDmPick({ channel: m.channel, user: m.user, question });
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
      await engine.liveTurn(slackDriver(client), m.channel, m.ts, undefined, dmKey, project!, dmQ, await hydrate());
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
    await engine.liveTurn(slackDriver(client), m.channel, m.ts, m.thread_ts, key, project, threadQ, await hydrate());
  });

  // ── Dispatch proposals: Send executes once, Dismiss records; both idempotent on the id ──
  for (const which of ['dispatch_send', 'dispatch_dismiss'] as const) {
    app.action(which, async ({ ack, action, body, client, context, respond }) => {
      await ack();
      if (!servedTenant(tenantOf(context))) return;
      const gate = actor(tenantOf(context), (body as { user?: { id?: string } }).user?.id);
      if (!gate.ok) {
        await respond({ response_type: 'ephemeral', replace_original: false, text: gate.denial }).catch(() => {});
        return;
      }
      const id = (action as { value?: string }).value;
      const user = (body as { user?: { id?: string } }).user?.id;
      if (!id || !user || !deps.dispatcher || !dispatch.enabled) return;
      const p = which === 'dispatch_send' ? await deps.dispatcher.approve(client, id, user) : deps.dispatcher.dismiss(id, user);
      const b = body as { channel?: { id?: string }; message?: { ts?: string } };
      if (p && b.channel?.id && b.message?.ts) {
        await client.chat.update({ channel: b.channel.id, ts: b.message.ts, text: proposalText(p), blocks: proposalBlocks(p) }).catch((e) => log.error(`dispatch ${id}: message update: ${e instanceof Error ? e.message : String(e)}`));
      }
    });
  }

  // ── "🔗 View PR" link button → opens the URL itself; just ack the interaction ──
  app.action(/^pr_link:/, async ({ ack }) => {
    await ack();
  });

  // ── "🔗 View PR" link button → opens the URL itself; just ack the interaction ──
  app.action(/^pr_link:/, async ({ ack }) => {
    await ack();
  });

  // ── every other control → the core (src/chat/core/interactions.ts) ──────────
  // Exact action ids, plus the families whose action_id carries a suffix
  // (`answer_q:<qid>:<qi>:<oi>`, `submit_q:<qid>`, `mem_open:<n>` — unique per control).
  const FAMILIES = new Set(['answer_q', 'submit_q', 'mem_open']);
  for (const id of Object.keys(core.actions)) {
    app.action(FAMILIES.has(id) ? new RegExp(`^${id}:`) : id, async ({ ack, action, body, client, context, respond }) => {
      await ack();
      await core.actions[id](toAction(id, action, body, tenantOf(context), respond), slackDriver(client));
    });
  }

  // ── dialog submissions → the core, fields normalized by name ─────────────────
  type ViewState = Record<string, Record<string, { value?: string | null; selected_option?: { value?: string }; selected_options?: { value?: string }[] }>>;
  const SUBMITS: Record<string, { id: string; fields: (v: ViewState) => DialogSubmit['values'] }> = {
    [FB_CALLBACK]: {
      id: 'feedback',
      fields: (v) => ({
        reason: v[FB_REASON.block]?.[FB_REASON.action]?.selected_option?.value,
        note: v[FB_NOTE.block]?.[FB_NOTE.action]?.value ?? undefined,
      }),
    },
    [YT_PROMPT_CALLBACK]: {
      id: 'yt_prompt',
      fields: (v) => ({
        instructions: v[YT_PROMPT_INPUT.block]?.[YT_PROMPT_INPUT.action]?.value ?? '',
        now: (v[YT_PROMPT_NOW.block]?.[YT_PROMPT_NOW.action]?.selected_options ?? [])
          .map((o) => o.value ?? '')
          .filter((x) => x === YT_PROMPT_NOW.value),
      }),
    },
    [YT_SEND_CALLBACK]: {
      id: 'yt_send',
      fields: (v) => ({ text: v[YT_SEND_INPUT.block]?.[YT_SEND_INPUT.action]?.value ?? '' }),
    },
  };
  for (const [callback, spec] of Object.entries(SUBMITS)) {
    app.view(callback, async ({ ack, view, body, client, context }) => {
      await ack();
      const submit: DialogSubmit = {
        id: spec.id,
        meta: view.private_metadata ?? '',
        values: spec.fields(view.state.values as ViewState),
        actor: { tenant: tenantOf(context), user: (body as { user?: { id?: string } }).user?.id },
      };
      await core.submits[spec.id](submit, slackDriver(client));
    });
  }

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

  // ── App Home tab → the core's per-tenant home surface ───────────────────────
  app.event('app_home_opened', async ({ event, client, context }) => {
    const e = event as { user: string; tab?: string };
    if (e.tab && e.tab !== 'home') return; // ignore the messages-tab open
    await core.home({ tenant: tenantOf(context), user: e.user }, slackDriver(client));
  });
}

// A Slack block_actions payload → the core's ChatAction. The response_url responder, the
// trigger id and the message's own blocks stay Slack-private (ctx, read by the driver).
function toAction(
  id: string,
  action: unknown,
  body: unknown,
  tenant: string | undefined,
  respond: SlackActionCtx['respond'],
): ChatAction {
  const act = action as { value?: string; selected_option?: { value?: string } };
  const b = body as {
    user?: { id?: string };
    trigger_id?: string;
    channel?: { id?: string };
    container?: { thread_ts?: string };
    message?: { ts?: string; thread_ts?: string; blocks?: unknown[] };
  };
  const conv = b.channel?.id;
  const ctx: SlackActionCtx = { respond, triggerId: b.trigger_id, blocks: b.message?.blocks };
  return {
    id,
    value: act.value ?? act.selected_option?.value ?? '',
    actor: { tenant, user: b.user?.id },
    where: conv ? { conv, thread: b.container?.thread_ts ?? b.message?.thread_ts } : undefined,
    msg: conv && b.message?.ts ? { conv, id: b.message.ts, thread: b.message.thread_ts } : undefined,
    msgText: b.message?.blocks ? textFromMarkdownBlocks(b.message.blocks as never[]) : undefined,
    canDialog: !!b.trigger_id,
    ctx,
  };
}
