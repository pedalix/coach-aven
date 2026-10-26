// The interaction surface, platform-neutral: what every button, dialog submission and the
// home surface DO. A chat driver normalizes the click (ChatAction / DialogSubmit), the core
// decides, and talks back through the same driver. Moved verbatim from the Slack event
// handlers (OpenSpec chat-driver-interface, PR 2); src/chat/slack/events.record.test.ts pins
// the Slack output byte-for-byte.
//
// Gates, in order, as before: a served tenant for anything that writes or reads project data
// (a stale button in an offboarded workspace must not act), then the actor gate for anything
// that steers (viewers may look at trails, tickets and session panels, not drive).

import type { Config } from '../../config.js';
import type { Store } from '../../state.js';
import { resolveBySlug, teamProjects, type RegistryRef } from '../../projects.js';
import { keyFor } from '../surfaces.js';
import type { ChatDriverName } from '../drivers.js';
import type { TurnEngine } from '../../turn.js';
import { readMemory } from './commands.js';
import { autofixPrompt, reportDraftPrompt, reportDeliveryContract } from '../../prompts.js';
import { projectCwd } from '../../project.js';
import { memoryFilePath } from '../../memory.js';
import { memoryRepoDir, readSnapshotFile } from '../../memjournal.js';
import { captureError } from '../../sentry.js';
import { getIssue, listComments, listAttachments, postInternalComment } from '../../youtrack.js';
import { isBadReason, isTurnId, type Tally } from '../../feedback.js';
import { errText } from '../slack/blocks.js';
import { log } from '../../log.js';
import type { Actor, ChatAction, ChatDriver, DialogSubmit } from '../driver.js';
import type { ActorGate } from './gates.js';
import type { Messaging } from '../../messaging/service.js';
import type { MessageView } from '../views.js';

export interface InteractionDeps {
  cfg: Config;
  store: Store;
  reg: RegistryRef;
  engine: TurnEngine;
  homeTeamId?: string;
  // The surface these handlers serve (undefined = the default surface; its keys keep today's shapes).
  surface?: ChatDriverName;
  servedTenant: (tenantId: string | undefined) => boolean;
  actor: ActorGate;
  // The viewer tenant's channel-name wildcard, for the home surface.
  prefixFor: (tenantId: string | undefined) => string;
  // Agent messaging (agent-messaging D9): Send / Dismiss on a held message.
  messaging?: () => Messaging | undefined;
}

export type ActionHandler = (a: ChatAction, d: ChatDriver) => Promise<void>;
export type SubmitHandler = (s: DialogSubmit, d: ChatDriver) => Promise<void>;

export interface Interactions {
  actions: Record<string, ActionHandler>;
  submits: Record<string, SubmitHandler>;
  home: (actor: Actor & { user: string }, d: ChatDriver) => Promise<void>;
  // A DM with no project hint parks its question here until a project is picked; returns
  // the pick id the picker's options carry.
  parkDmPick: (pending: { channel: string; user: string; question: string }) => string;
}

const parse = <T>(raw: string): T | undefined => {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
};

export function createInteractions(deps: InteractionDeps): Interactions {
  const { cfg, store, reg, engine, homeTeamId, servedTenant, actor, surface } = deps;

  const pendingDmPicks = new Map<string, { channel: string; user: string; question: string }>();
  let dmPickSeq = 0;

  // A non-cleared clicker gets the denial privately; true = go on.
  const cleared = async (a: ChatAction, d: ChatDriver): Promise<boolean> => {
    const gate = actor(a.actor.tenant, a.actor.user);
    if (gate.ok) return true;
    await d.reply(a, { kind: 'text', text: gate.denial }, { replace: false }).catch(() => {});
    return false;
  };

  // ── ratings: the value half of metering (feedback.ts) ──
  // Both verdicts are written on CLICK, before any dialog: an abandoned reason dialog must
  // still leave the signal behind.
  const rateMeta = (raw: string): { t: string; s: string; k: string } | undefined => {
    const v = parse<{ t?: string; s?: string; k?: string }>(raw);
    if (v && typeof v.t === 'string' && isTurnId(v.t) && typeof v.s === 'string' && typeof v.k === 'string') {
      return { t: v.t, s: v.s, k: v.k };
    }
    return undefined; // malformed control value — ignore the click
  };
  const writeVerdict = (
    m: { t: string; s: string; k: string },
    user: string,
    verdict: 'good' | 'bad',
    extra: { reason?: string; note?: string; channel?: string; ts?: string } = {},
  ): Tally =>
    engine.recordFeedback({
      at: new Date().toISOString(),
      turnId: m.t,
      key: m.k,
      slug: m.s,
      user,
      verdict,
      reason: extra.reason && isBadReason(extra.reason) ? extra.reason : undefined,
      note: extra.note?.slice(0, 2000) || undefined,
      channel: extra.channel,
      ts: extra.ts,
    });

  // A click on a question whose entry is gone (turn ended, restart) gets visible feedback
  // instead of a dead control.
  const markStale = async (a: ChatAction, d: ChatDriver): Promise<void> => {
    if (a.msg) await d.update(a.msg, { kind: 'text', text: '⌛ This question has expired' }).catch(() => {});
  };

  // A held message (agent-messaging D9): anyone who may drive the conversation may click; Send
  // releases it once, Dismiss ends a held task `canceled: dismissed` (a held reply leaves its task
  // waiting, and the conversation is told). Idempotent on the held record.
  const decideHeld =
    (send: boolean): ActionHandler =>
    async (a, d) => {
      if (!servedTenant(a.actor.tenant)) return;
      if (!(await cleared(a, d))) return;
      const m = deps.messaging?.();
      const id = a.value;
      const user = a.actor.user;
      if (!m || !id || !user) return;
      const held = deps.store.getHeld(id);
      const r = send ? m.release(id, user) : m.dismiss(id);
      if (!a.msg) return;
      const view: MessageView = held
        ? { kind: 'heldAsk', held: { id, kind: held.kind, target: held.target, text: held.text, why: held.why }, state: r.ok ? (send ? 'sent' : 'dismissed') : 'dismissed', by: user, ...(r.ok ? {} : { note: r.text }) }
        : { kind: 'text', text: r.text };
      await d.update(a.msg, view).catch((e) => log.error(`held ${id}: message update: ${e instanceof Error ? e.message : String(e)}`));
    };

  // A proposal card posted before the dispatch primitive was retired (OpenSpec `retire-agent-dispatch`) still
  // carries Send / Dismiss in old threads: the click is acknowledged and the card says nothing was sent,
  // the way a stale question is handled, instead of a dead control.
  const retiredProposal: ActionHandler = async (a, d) => {
    if (a.msg) await d.update(a.msg, { kind: 'text', text: '⌛ Proposals were retired — nothing was sent' }).catch(() => {});
  };

  const actions: Record<string, ActionHandler> = {
    held_send: decideHeld(true),
    held_dismiss: decideHeld(false),
    dispatch_send: retiredProposal,
    dispatch_dismiss: retiredProposal,

    // ✖ Cancel → abort that turn (the queued next one then starts). Steering → gated.
    cancel_turn: async (a, d) => {
      if (!(await cleared(a, d))) return;
      if (a.value) engine.cancel(a.value);
    },

    // 🧭 Show steps → the turn's trail in a dialog, live or settled. The trail lives in the
    // engine's bounded in-memory registry, so a click after eviction/restart shows "expired".
    show_trail: async (a, d) => {
      if (!a.canDialog) return;
      const t = engine.trail(a.value);
      await d.openDialog(a, { kind: 'trail', trail: t }).catch(async (e) => {
        // A failed open used to be logged and nothing else (prod, 2026-09-08: seven clicks,
        // no dialog, no hint). The click must leave a visible trace; the dialog window is
        // single-use, so the fallback is a private note, not a retry.
        const err = e instanceof Error ? e.message : String(e);
        log.error(`show_trail: ${err}`);
        captureError(e instanceof Error ? e : new Error(`show_trail: ${err}`));
        if (!a.where?.conv || !a.actor.user) return;
        await d
          .postPrivate(a.where, a.actor.user, {
            kind: 'text',
            text: "Couldn't open the steps view just now — Slack rejected it. Try again in a moment; if it keeps failing, the trail is in the logs.",
          })
          .catch(() => {});
      });
    },

    // 👍 → record, then show the count on the message itself (no extra notice).
    fb_good: async (a, d) => {
      if (!servedTenant(a.actor.tenant)) return; // stale control in an offboarded workspace
      if (!(await cleared(a, d))) return;
      const m = rateMeta(a.value);
      if (!m || !a.actor.user) return;
      const tally = writeVerdict(m, a.actor.user, 'good', { channel: a.where?.conv, ts: a.msg?.id });
      await d.refreshRating(a, tally);
    },

    // 👎 → record first, ask why second (the reason is a bonus, the verdict is the data). The
    // dialog must open inside the click's window, so it goes before the count refresh.
    fb_bad: async (a, d) => {
      if (!servedTenant(a.actor.tenant)) return;
      if (!(await cleared(a, d))) return;
      const m = rateMeta(a.value);
      if (!m || !a.actor.user) return;
      const tally = writeVerdict(m, a.actor.user, 'bad', { channel: a.where?.conv, ts: a.msg?.id });
      if (a.canDialog) {
        await d
          .openDialog(a, { kind: 'feedback', meta: { turnId: m.t, slug: m.s, key: m.k, channel: a.where?.conv, ts: a.msg?.id } })
          .catch((e) => log.error(`fb_bad modal: ${e instanceof Error ? e.message : String(e)}`));
      }
      await d.refreshRating(a, tally);
    },

    // 🔍 Full ticket → open a loading dialog at once (the click's window is short), then swap
    // the real ticket in, fetched fresh so the comment thread is current.
    ticket_modal: async (a, d) => {
      const id = a.value;
      if (!id || !a.canDialog) return;
      const opened = await d.openDialog(a, { kind: 'ticketLoading', id }).catch((e) => {
        log.error(`ticket_modal ${id}: open failed: ${e instanceof Error ? e.message : String(e)}`);
        return undefined;
      });
      if (!opened) return;
      const url = `${(cfg.youtrack?.baseUrl ?? '').replace(/\/$/, '')}/issue/${id}`;
      const [issue, comments, attachments] = await Promise.all([getIssue(cfg, id), listComments(cfg, id), listAttachments(cfg, id)]);
      await d
        .updateDialog(
          opened,
          issue
            ? { kind: 'ticket', issue, url, comments, attachmentNames: attachments.map((x) => x.name) }
            : { kind: 'ticketUnavailable', id, url },
        )
        .catch((e) => log.error(`ticket_modal ${id}: update failed: ${e instanceof Error ? e.message : String(e)}`));
    },

    // DM project picker → run the parked question against the chosen project.
    dm_pick_project: async (a, d) => {
      const i = a.value.indexOf(':'); // value = "<pid>:<slug>"
      const pid = a.value.slice(0, i);
      const slug = a.value.slice(i + 1);
      const pending = pendingDmPicks.get(pid);
      // Validate the pick INSIDE the clicking tenant's subset — the picker only listed
      // those, but the value is still client-supplied input.
      const tenant = a.actor.tenant;
      const mine = { projects: teamProjects(reg.current, tenant, homeTeamId) };
      const project = slug ? resolveBySlug(mine, slug) : undefined;
      if (!pending || !project) {
        if (a.msg) await d.update(a.msg, { kind: 'text', text: '⌛ This picker expired — send your message again.' }).catch(() => {});
        return;
      }
      // The DM gate ran when the question was parked, but the CLICKER is client input too.
      const pickGate = actor(tenant, a.actor.user);
      if (!pickGate.ok) {
        if (a.msg) await d.update({ conv: pending.channel, id: a.msg.id }, { kind: 'text', text: pickGate.denial }).catch(() => {});
        return;
      }
      pendingDmPicks.delete(pid);
      if (a.msg) {
        await d.update({ conv: pending.channel, id: a.msg.id }, { kind: 'text', text: `▶️ Running on *${slug}*…` }).catch(() => {});
      }
      const pickKey = keyFor(surface, tenant, homeTeamId, `dm:${pending.channel}:${slug}`);
      await engine.liveTurn(d, pending.channel, undefined, undefined, pickKey, project, pending.question);
    },

    // ⚙️ Session → this conversation's status card, privately, inside its thread. Read-only,
    // so no actor gate (viewers may look).
    session_panel: async (a, d) => {
      if (!servedTenant(a.actor.tenant)) return;
      const v = parse<{ key: string; channel: string; threadTs?: string }>(a.value);
      if (!v) return;
      const slug = engine.slugForKey(v.key);
      const project = slug ? resolveBySlug(reg.current, slug) : undefined;
      if (!project) return;
      if (!a.actor.user) return;
      const chat = store.getChat(v.key);
      await d
        .postPrivate({ conv: v.channel, thread: v.threadTs }, a.actor.user, {
          kind: 'sessionPanel',
          info: {
            slug: project.slug,
            repos: project.repos,
            mcp: project.mcp?.map((m) => m.name),
            hasSession: !!chat?.sessionId,
            sessionSince: chat?.updatedAt,
            turnInFlight: engine.hasKey(v.key),
            prCreated: !!chat?.prCreated,
          },
          value: a.value,
        })
        .catch((e) => log.error(`session_panel ${v.key}: ${e instanceof Error ? e.message : String(e)}`));
    },

    // 🔄 Restart session → forget this conversation's Claude session; the next message starts
    // fresh. Gated (mutating); refused while a turn runs (it holds the live session).
    session_restart: async (a, d) => {
      if (!servedTenant(a.actor.tenant)) return;
      if (!(await cleared(a, d))) return;
      const v = parse<{ key: string; channel: string; threadTs?: string }>(a.value);
      if (!v) return;
      const slug = engine.slugForKey(v.key);
      const project = slug ? resolveBySlug(reg.current, slug) : undefined;
      if (!project) return;
      if (engine.hasKey(v.key)) {
        await d
          .reply(a, { kind: 'text', text: ':information_source: A turn is running in this thread — cancel it first, then restart.' }, { replace: true })
          .catch(() => {});
        return;
      }
      await engine.restartSession(v.key, project);
      await d
        .reply(a, { kind: 'text', text: ':white_check_mark: Session restarted — the next message in this thread starts fresh.' }, { replace: true })
        .catch(() => {});
    },

    // 📝 Report to YouTrack → a dialog with the ACTUAL generation prompt to confirm/edit.
    yt_report: async (a, d) => {
      if (!servedTenant(a.actor.tenant)) return;
      if (!(await cleared(a, d))) return;
      const v = parse<{ t: string; key: string; channel: string; threadTs?: string }>(a.value);
      if (!v) return;
      if (!a.canDialog) return;
      await d
        .openDialog(a, {
          kind: 'reportPrompt',
          ticket: v.t,
          prompt: reportDraftPrompt(v.t),
          contract: reportDeliveryContract(v.t),
          meta: { key: v.key, channel: v.channel, threadTs: v.threadTs },
        })
        .catch((e) => log.error(`yt_report ${v.t}: ${e instanceof Error ? e.message : String(e)}`));
    },

    // ✏️ Edit & send on a draft → dialog pre-filled with the draft text (from the engine's
    // draft store; the message's own text is only a best-effort fallback). Gone → "expired".
    yt_edit_send: async (a, d) => {
      const v = parse<{ t: string; d: string }>(a.value);
      if (!v) return;
      if (!v.t || !a.canDialog || !a.msg) return;
      const draft = engine.ytDraft(v.d) ?? a.msgText ?? '';
      await d
        .openDialog(
          a,
          draft.trim()
            ? { kind: 'report', ticket: v.t, draft, meta: { channel: a.msg.conv, ts: a.msg.id, threadTs: a.msg.thread } }
            : { kind: 'reportExpired', ticket: v.t },
        )
        .catch((e) => log.error(`yt_edit_send ${v.t}: ${e instanceof Error ? e.message : String(e)}`));
    },

    // 🔧 Fix it → a WRITE turn addressing the PR feedback.
    autofix_apply: async (a, d) => {
      const tenant = a.actor.tenant;
      if (!servedTenant(tenant)) return;
      if (!(await cleared(a, d))) return;
      const v = parse<{ slug: string; repo: string; number: number; channel: string }>(a.value);
      if (!v) return;
      const project = resolveBySlug(reg.current, v.slug);
      if (!project) return;
      // Tenant-prefixed like the subscribe path — attribution, dedup and restart recovery all
      // resolve the clicking workspace's own credentials.
      const key = keyFor(surface, tenant, homeTeamId, `autofix:${v.repo}:${v.number}:${v.slug}`);
      if (engine.hasKey(key)) return; // a fix is already running for this PR
      // automatic: it pushes commits on its own — an agent-messaging answer never folds into it (D11).
      await engine.liveTurn(d, v.channel, undefined, undefined, key, project, autofixPrompt(v.repo, v.number), undefined, { automatic: true });
    },

    // Memory topic → that section file, privately (journal copy first, no sandbox wake).
    // Memory is project data — an offboarded workspace's stale control must not read it.
    mem_open: async (a, d) => {
      if (!servedTenant(a.actor.tenant)) return;
      const v = parse<{ s: string; f: string }>(a.value);
      if (!v) return;
      const project = resolveBySlug(reg.current, v.s);
      const fp = project && memoryFilePath(projectCwd(cfg, project.slug, project.repos), v.f);
      if (!project || !fp) return;
      try {
        let text = await readSnapshotFile(memoryRepoDir(project.slug), v.f).catch(() => null);
        if (text == null) text = await readMemory(cfg, project, fp, false); // not journaled → live (no wake)
        await d.reply(a, { kind: 'markdown', title: v.f, markdown: text }, { replace: false });
      } catch (err) {
        await d.reply(a, { kind: 'text', text: errText(err) }, { replace: false });
      }
    },

    // Option control → toggle/select; single-select resolves on click, multi on Submit.
    answer_q: async (a, d) => {
      if (!(await cleared(a, d))) return; // answering steers the running turn
      const v = parse<{ qid: string; qi: number; oi: number }>(a.value);
      if (!v) return;
      const entry = engine.questions.get(v.qid);
      if (!entry || entry.done) {
        if (!engine.questions.isCompleted(v.qid)) await markStale(a, d);
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
      const msg = { conv: entry.channel, id: entry.ts };
      const view = { kind: 'question', questions: entry.questions, picks: entry.picks, multi: entry.multi, qid: v.qid } as const;
      // Single-select auto-resolves once every question has a pick; multi waits for Submit.
      if (!entry.multi && engine.questions.answeredAll(entry)) {
        await d.update(msg, { ...view, done: true }).catch(() => {});
        engine.questions.finalize(entry, v.qid);
      } else {
        await d.update(msg, { ...view, done: false }).catch(() => {});
      }
    },

    // Submit (multi-select) → resolve once every question has a selection.
    submit_q: async (a, d) => {
      if (!(await cleared(a, d))) return;
      const v = parse<{ qid: string }>(a.value);
      if (!v) return;
      const entry = engine.questions.get(v.qid);
      if (!entry || entry.done) {
        if (!engine.questions.isCompleted(v.qid)) await markStale(a, d);
        return;
      }
      if (!engine.questions.answeredAll(entry)) return;
      await d
        .update(
          { conv: entry.channel, id: entry.ts },
          { kind: 'question', questions: entry.questions, picks: entry.picks, multi: entry.multi, qid: v.qid, done: true },
        )
        .catch(() => {});
      engine.questions.finalize(entry, v.qid);
    },
  };

  const submits: Record<string, SubmitHandler> = {
    // Reason + optional note → a SECOND record for the same (turn, user), superseding the bare
    // click by timestamp. No count refresh: the verdict was already 'bad'.
    feedback: async (s) => {
      if (!servedTenant(s.actor.tenant)) return;
      const user = s.actor.user;
      if (!user) return;
      const meta = parse<{ t?: string; s?: string; k?: string; c?: string; ts?: string }>(s.meta || '{}');
      if (!meta) return;
      if (!meta.t || !isTurnId(meta.t) || !meta.s || !meta.k) return;
      const reason = typeof s.values.reason === 'string' ? s.values.reason : undefined;
      const note = typeof s.values.note === 'string' ? s.values.note : undefined;
      writeVerdict({ t: meta.t, s: meta.s, k: meta.k }, user, 'bad', { reason, note, channel: meta.c, ts: meta.ts });
    },

    // Report prompt submitted → run the draft turn. The delivery contract is re-appended HERE,
    // not trusted from the dialog: the instructions are editable and one-liners would drop
    // "output ONLY the comment text". "Post immediately" → the answer goes straight to the
    // ticket; on failure the turn degrades it to the reviewable draft with the error.
    yt_prompt: async (s, d) => {
      if (!servedTenant(s.actor.tenant)) return;
      // Silent re-check (the button already denied loudly; a dialog reaching submit without
      // clearance is a stale/raced one — just don't run the turn).
      if (!actor(s.actor.tenant, s.actor.user).ok) return;
      const meta = parse<{ t: string; key: string; channel: string; threadTs?: string }>(s.meta || '');
      if (!meta) return;
      const instructions = (typeof s.values.instructions === 'string' ? s.values.instructions : '').trim();
      if (!instructions) return;
      const prompt = `${instructions}\n\n${reportDeliveryContract(meta.t)}`;
      const now = Array.isArray(s.values.now) && s.values.now.length > 0;
      const slug = engine.slugForKey(meta.key);
      const project = slug ? resolveBySlug(reg.current, slug) : undefined;
      if (!project) return;
      await engine.liveTurn(d, meta.channel, undefined, meta.threadTs, meta.key, project, prompt, undefined, {
        ytDraftFor: meta.t,
        autoPost: now
          ? async (text) => {
              const posted = await postInternalComment(cfg, meta.t, text);
              store.markReported(meta.t);
              return posted;
            }
          : undefined,
      });
    },

    // Report dialog submitted → post the (possibly edited) text as an INTERNAL ticket comment.
    // Success rewrites the draft into a confirmation; failure lands in the thread.
    yt_send: async (s, d) => {
      if (!actor(s.actor.tenant, s.actor.user).ok) return; // a write — same silent re-check
      const meta = parse<{ t: string; channel: string; ts: string; threadTs?: string }>(s.meta || '');
      if (!meta) return;
      const text = (typeof s.values.text === 'string' ? s.values.text : '').trim();
      if (!text) return;
      try {
        const posted = await postInternalComment(cfg, meta.t, text);
        store.markReported(meta.t);
        await d.update(
          { conv: meta.channel, id: meta.ts },
          { kind: 'reported', markdown: text, ticket: meta.t, url: posted.url, group: posted.group },
        );
      } catch (e) {
        const why = e instanceof Error ? e.message : String(e);
        log.error(`yt_send ${meta.t}: ${why}`);
        await d
          .post(
            { conv: meta.channel, thread: meta.threadTs ?? meta.ts },
            {
              kind: 'text',
              text: `⚠️ Couldn't post the report to ${meta.t}: ${why.slice(0, 500)}\nThe draft above is untouched — fix the cause and hit ✏️ Edit & send again.`,
            },
          )
          .catch(() => {});
      }
    },
  };

  // The home surface: only the viewer tenant's projects. An installed-but-unmapped tenant
  // gets the onboarding view — as does EVERYONE while home is unresolved (fail closed:
  // teamProjects would otherwise treat any viewer as home and leak the fleet).
  const home = async (who: Actor & { user: string }, d: ChatDriver): Promise<void> => {
    const mine = servedTenant(who.tenant) ? teamProjects(reg.current, who.tenant, homeTeamId) : [];
    try {
      await d.publishHome(
        who.user,
        mine.length ? { kind: 'home', projects: mine, prefix: deps.prefixFor(who.tenant), ...(deps.reg.current.projects.some((p) => p.messaging !== undefined) ? { messaging: true } : {}) } : { kind: 'onboarding' },
      );
    } catch (err) {
      log.error(`home publish failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const parkDmPick = (pending: { channel: string; user: string; question: string }): string => {
    const pid = `dp${++dmPickSeq}`;
    pendingDmPicks.set(pid, pending);
    return pid;
  };

  return { actions, submits, home, parkDmPick };
}
