// The Teams chat driver: renders the core's views to Teams messages (cards.ts) and performs
// them against the Bot Connector through a small API seam (TeamsApi) that app.ts binds to the
// Teams SDK and the tests to a recorder. One driver per installation (single tenant).
//
// What differs from Slack, and how the ChatDriver contract absorbs it (design D5–D9):
// - no ephemeral messages → `reply`/`postPrivate` go to the person's 1:1 chat, with a one-line
//   pointer in the thread; a reply to something that already happened in a 1:1 stays there;
// - reactions: bots may react since 2026 (`1f440_eyes`, `2705_whiteheavycheckmark`, …, 2/s), so
//   `mark` is a reaction on the person's message as on Slack — in channels the message's chain
//   is needed, which events.ts tells the driver (`remember`) for every inbound message;
// - a queued turn's status card would push the answer below the next turn's card, so a queued
//   placeholder is not posted at all: `post` returns a pending reference, the 👀 reaction is the
//   acknowledgement, and the card materialises on the first update (when the turn starts);
// - a dialog opens only as the answer to the click's own `task/fetch` invoke → `openDialog`
//   resolves the deferred the events adapter parked on the ChatAction (`ctx.dialog`);
// - message edits are rate-limited → `update` coalesces to one per TEAMS_STATUS_MIN_MS per
//   message and always flushes the last view.

import type { ChatAction, ChatDriver, ConvTarget, DialogRef, Interaction, Mark, MsgRef } from '../driver.js';
import type { DialogView, HomeView, MessageView, PrivateView } from '../views.js';
import type { Tally } from '../../feedback.js';
import { answerCard, renderDialogView, renderHomeView, renderMessageView, renderPrivateView, type AdaptiveCard } from './cards.js';
import { splitText, teamsMentions, type MentionEntity } from './format.js';
import { deepLink, targetId } from './keys.js';
import { log } from '../../log.js';

// An outbound activity as the Connector takes it. `text` is Teams markdown.
export interface OutActivity {
  type: 'message' | 'typing';
  text?: string;
  // `extendedmarkdown`: tables, fenced code with syntax highlighting and a copy button, headings
  // (verified in the tenant 2026-10-16 — plain `markdown` renders them too, without the extras).
  textFormat?: 'extendedmarkdown';
  attachments?: { contentType: 'application/vnd.microsoft.card.adaptive'; content: AdaptiveCard }[];
  entities?: MentionEntity[]; // one per `<at>…</at>` in `text`
  // A targeted message: shown to this one person only, in a channel or group chat (24 h).
  recipient?: { id: string; isTargeted: true };
  // Everything else the Connector accepts and we never set (summary, …) is omitted.
}

// The Bot Connector surface the driver needs. app.ts binds it to the SDK's ApiClient
// (conversations.createActivity / updateActivity / create); the tests to a recorder.
export interface TeamsApi {
  send(conversationId: string, activity: OutActivity): Promise<{ id: string }>;
  // A targeted send (`activity.recipient` set): `…/activities?isTargetedActivity=true`.
  sendTargeted(conversationId: string, activity: OutActivity): Promise<{ id: string }>;
  update(conversationId: string, activityId: string, activity: OutActivity): Promise<void>;
  // Open (or find) the 1:1 chat with a person; undefined when the platform refuses.
  openPersonal(userId: string): Promise<string | undefined>;
  // Add/remove a reaction on a message; `type` is Teams' `<codepoint>_<name>` form.
  react(conversationId: string, activityId: string, type: string, op: 'add' | 'remove'): Promise<void>;
  // A conversation member's display name from the roster (`…/members/<id>`); undefined when
  // the person is not in it (or the lookup fails) — the caller renders a plain `@id` then.
  memberName(conversationId: string, userId: string): Promise<string | undefined>;
}

// Teams' reaction ids for the core's marks (the `<codepoint>_<name>` form the Connector takes).
const REACTION: Record<Mark, string> = {
  working: '1f440_eyes',
  done: '2705_whiteheavycheckmark',
  failed: '274c_crossmark',
  note: '1f92b_shushingface',
};

export interface TeamsDriverOpts {
  tenantId: string;
  statusMinMs?: number; // coalescing window for updates of one message (D6); default 2000
  // Private replies in channels as targeted messages (TEAMS_TARGETED=1); the 1:1 chat stays
  // the fallback when a targeted send is refused (not installed for that person, a guest, …).
  targeted?: boolean;
  now?: () => number;
  setTimeout?: typeof setTimeout;
  clearTimeout?: typeof clearTimeout;
  // Whether thread replies reach the bot without a mention (RSC consent) — the capability
  // flag the shared help texts read.
  threadRepliesNeedMention?: boolean;
}

// What a Teams interaction carries that the core never sees: where it happened (to answer
// in place or to point at the private answer), who clicked (to open their 1:1), whether it
// happened in a 1:1 already, and — for a `task/fetch` click — the deferred that becomes the
// invoke's response once the core has decided what dialog to show.
export interface TeamsActionCtx {
  conv: string;
  thread?: string;
  user?: string;
  direct: boolean;
  dialog?: (d: { title: string; card: AdaptiveCard }) => void;
}
// What the status card says once its answer has been posted after it.
const DONE_RECEIPT = '✅ Done — answer below';

const ctxOf = (a: Interaction): TeamsActionCtx => (a.ctx ?? { conv: '', direct: false }) as TeamsActionCtx;

export interface TeamsChatDriver extends ChatDriver {
  readonly api: TeamsApi;
  // The chain an inbound channel message belongs to (its root), so a reaction on it can be
  // addressed; called by events.ts for every message it hands to the core.
  remember(msg: MsgRef, thread: string | undefined): void;
  // A person's display name as an activity carried it (sender or mention), for rendering
  // `<@id>` as a Teams mention; events.ts feeds it.
  knowPerson(id: string, name: string | undefined): void;
}

export function teamsDriver(api: TeamsApi, opts: TeamsDriverOpts): TeamsChatDriver {
  const minMs = opts.statusMinMs ?? 2000;
  const now = opts.now ?? Date.now;
  const schedule = opts.setTimeout ?? setTimeout;
  const unschedule = opts.clearTimeout ?? clearTimeout;
  const people = new Map<string, string>();
  const unknown = new Set<string>(); // roster misses, so one person costs one lookup per run
  // `<@id>`s in outbound text whose name was never seen: ask the conversation's roster once,
  // so a configured owner (YouTrack `ping`) is a real mention on the first delivery too.
  async function learn(conv: string, text: string | undefined): Promise<void> {
    if (text === undefined) return;
    for (const m of text.matchAll(/<@([^>|\s]+)(?:\|[^>]*)?>/g)) {
      const id = m[1];
      if (people.has(id) || unknown.has(id)) continue;
      const name = await api.memberName(conv, id).catch(() => undefined);
      if (name) people.set(id, name);
      else unknown.add(id);
    }
  }
  function toActivity(m: { text?: string; card?: AdaptiveCard }): OutActivity {
    const t = m.text !== undefined ? teamsMentions(m.text, (id) => people.get(id)) : undefined;
    return {
      type: 'message',
      ...(t ? { text: t.text, textFormat: 'extendedmarkdown', ...(t.entities ? { entities: t.entities } : {}) } : {}),
      ...(m.card ? { attachments: [{ contentType: 'application/vnd.microsoft.card.adaptive', content: m.card }] } : {}),
    };
  }

  // Per-message coalescing: the newest view wins, one edit per window, the last always lands.
  const pending = new Map<string, { view: MessageView; timer?: ReturnType<typeof setTimeout>; last: number; inflight?: Promise<void> }>();
  async function flush(key: string, msg: MsgRef): Promise<void> {
    const p = pending.get(key);
    if (!p) return;
    p.timer = undefined;
    const view = p.view;
    p.last = now();
    p.inflight = (async () => {
      // A queued placeholder's first update materialises it: the turn has started (or was
      // canceled while waiting — then the card says so, once).
      if (isPending(msg.id) && !realId.has(msg.id)) {
        const t = pendingTargets.get(msg.id);
        if (!t) throw new Error(`teams: unknown pending status ${msg.id}`);
        const ref = await deliverView(t.conv, t.thread, view);
        realId.set(msg.id, ref.id);
        return;
      }
      const real = resolve(msg);
      await edit(real, chainOf(real), view);
    })().finally(() => {
      p.inflight = undefined;
    });
    await p.inflight;
  }
  // An answer never edits the status card into itself: Teams keeps an edited message where it
  // was while the answer's card (a separate message) goes to the END of the chain — so a
  // message the person sent meanwhile would split the text from its buttons (seen on the
  // canary with three quick messages). Instead the status card becomes a one-line receipt and
  // the answer lands fresh after it, text then card, always together. Other text+card edits
  // (none today) take the same route: a pair in one edit is "multiple skype activities".
  async function edit(msg: MsgRef, thread: string | undefined, view: MessageView): Promise<void> {
    const m = renderMessageView(view);
    const target = targetId(msg.conv, thread);
    if (view.kind === 'answer' || (m.text !== undefined && m.card)) {
      await api.update(target, msg.id, toActivity({ text: DONE_RECEIPT }));
      await deliverView(msg.conv, thread, view);
      return;
    }
    await api.update(target, msg.id, toActivity(m));
  }
  // Where a message lives (the chain it was posted into) — needed to edit or react to it: the
  // Connector addresses an activity by conversation id (chain included) + activity id.
  const msgThread = new Map<string, string | undefined>();
  const keyOf = (m: MsgRef) => `${m.conv}#${m.id}`;
  // The chain of a message: what this process saw it posted into, else what the caller's own
  // record says (a status card rebuilt after a restart — the canary 2026-10-18 posted a
  // recovered answer at the channel root for want of this).
  const chainOf = (m: MsgRef): string | undefined => (msgThread.has(keyOf(m)) ? msgThread.get(keyOf(m)) : m.thread);
  // Queued placeholders: a pending reference → where its card goes once the turn starts.
  let pendingSeq = 0;
  const pendingTargets = new Map<string, { conv: string; thread?: string }>();
  // Pending reference → the real message once materialised (the engine keeps using the pending id).
  const realId = new Map<string, string>();
  const isPending = (id: string) => id.startsWith('pending:');
  const resolve = (m: MsgRef): MsgRef => (isPending(m.id) && realId.has(m.id) ? { conv: m.conv, id: realId.get(m.id)! } : m);
  // Dialogs opened with a placeholder (🔍 Full ticket: "Loading…" while YouTrack answers): the
  // click's deferred is held until updateDialog brings the real view, or the hold expires and
  // the placeholder is shown — the invoke must be answered within Teams' window either way.
  const HOLD_MS = 3500;
  let dialogSeq = 0;
  const held = new Map<string, { open: (d: { title: string; card: AdaptiveCard }) => void; timer: ReturnType<typeof setTimeout> }>();
  // The answer cards posted, by the card message's id, so a rating refresh can re-render them.
  const answerCards = new Map<string, Extract<MessageView, { kind: 'answer' }>>();

  // Text and card go as SEPARATE messages: Teams splits a text+card activity into two on its
  // side and answers with no usable id (and rejects the pair outright on an edit) — probed
  // 2026-10-16. The reference is the first text message (the card's when there is no text);
  // long text is split under the message limit, parts in order. `cardId` is the card's own
  // message, kept for the answer cards a rating refresh re-renders.
  async function deliver(conv: string, thread: string | undefined, m: { text?: string; card?: AdaptiveCard }): Promise<{ ref: MsgRef; cardId?: string }> {
    const target = targetId(conv, thread);
    let first: { id: string } | undefined;
    let cardId: string | undefined;
    await learn(conv, m.text);
    if (m.text !== undefined) {
      for (const part of splitText(m.text)) {
        const sent = await api.send(target, toActivity({ text: part }));
        first ??= sent;
      }
    }
    if (m.card) {
      const sent = await api.send(target, toActivity({ card: m.card }));
      cardId = sent.id;
      msgThread.set(keyOf({ conv, id: sent.id }), thread);
      first ??= sent;
    }
    const ref = { conv, id: first?.id ?? '' };
    msgThread.set(keyOf(ref), thread);
    return { ref, cardId };
  }
  const sendTo = async (conv: string, thread: string | undefined, m: { text?: string; card?: AdaptiveCard }): Promise<MsgRef> => (await deliver(conv, thread, m)).ref;
  // Deliver a view; an answer's card is remembered under the card message's id.
  async function deliverView(conv: string, thread: string | undefined, view: MessageView): Promise<MsgRef> {
    const d = await deliver(conv, thread, renderMessageView(view));
    if (view.kind === 'answer' && d.cardId) answerCards.set(keyOf({ conv, id: d.cardId }), view);
    return d.ref;
  }

  // A private answer: a targeted message in place (only that person sees it) when the
  // installation has them on; else — or when Teams refuses the targeted send — the person's
  // 1:1 chat with a pointer; in place when it already is a 1:1 (or no chat can be opened —
  // better visible than lost).
  async function privately(c: TeamsActionCtx, view: PrivateView): Promise<void> {
    const m = renderPrivateView(view);
    if (c.direct || !c.user) {
      await sendTo(c.conv, c.thread, m);
      return;
    }
    if (opts.targeted) {
      try {
        const target = targetId(c.conv, c.thread);
        await learn(c.conv, m.text);
        const recipient = { id: c.user, isTargeted: true as const };
        if (m.text !== undefined) for (const part of splitText(m.text)) await api.sendTargeted(target, { ...toActivity({ text: part }), recipient });
        if (m.card) await api.sendTargeted(target, { ...toActivity({ card: m.card }), recipient });
        return;
      } catch (e) {
        log.warn(`teams targeted reply to ${c.user} refused — answering in the 1:1 chat instead: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    const personal = await api.openPersonal(c.user).catch(() => undefined);
    if (!personal) {
      await sendTo(c.conv, c.thread, m);
      return;
    }
    await sendTo(personal, undefined, m);
    await sendTo(c.conv, c.thread, { text: '↗ _Answered you privately — see our 1:1 chat._' }).catch(() => {});
  }

  return {
    api,
    capabilities: { reactions: true, privateReplies: 'fallback', threadRepliesNeedMention: opts.threadRepliesNeedMention ?? false },
    remember(msg, thread) {
      msgThread.set(keyOf(msg), thread);
    },
    knowPerson(id, name) {
      if (name) people.set(id, name);
    },

    async post(to: ConvTarget, view: MessageView): Promise<MsgRef> {
      if (view.kind === 'status' && view.queued) {
        // No placeholder card for a waiting turn (see the header); the 👀 reaction acknowledges it.
        const id = `pending:${++pendingSeq}`;
        pendingTargets.set(id, { conv: to.conv, thread: to.thread });
        return { conv: to.conv, id };
      }
      return deliverView(to.conv, to.thread, view);
    },

    async update(msg: MsgRef, view: MessageView): Promise<void> {
      const key = keyOf(msg);
      const p = pending.get(key) ?? { view, last: now() - minMs }; // a first edit never waits
      p.view = view;
      pending.set(key, p);
      // A final, non-status view (answer text, "canceled", a background card) must land now;
      // status ticks coalesce.
      const urgent = view.kind !== 'status';
      const wait = urgent ? 0 : Math.max(0, p.last + minMs - now());
      if (p.timer) {
        if (!urgent) return; // the pending flush will pick up the newest view
        unschedule(p.timer);
        p.timer = undefined;
      }
      if (wait === 0 && !p.inflight) {
        await flush(key, msg);
        return;
      }
      await new Promise<void>((resolve) => {
        p.timer = schedule(() => {
          void flush(key, msg).finally(resolve);
        }, wait);
      });
    },

    async mark(msg: MsgRef, mark: Mark, op: 'add' | 'remove'): Promise<void> {
      // A reaction on the person's message, as on Slack. Its chain comes from remember()
      // (events.ts) for channel messages; a 1:1 message is addressed by its conversation alone.
      try {
        await api.react(targetId(msg.conv, chainOf(msg)), msg.id, REACTION[mark], op);
      } catch (e) {
        // Best-effort (already reacted / removed, message gone), but say so: a wrong reaction
        // id would otherwise fail silently on every turn.
        log.warn(`teams reaction ${op} ${REACTION[mark]} on ${msg.id}: ${e instanceof Error ? e.message : String(e)}`);
      }
    },

    async permalink(msg: MsgRef): Promise<string | undefined> {
      return deepLink(msg.conv, msg.id, opts.tenantId);
    },

    async reply(to: Interaction, view: PrivateView): Promise<void> {
      await privately(ctxOf(to), view);
    },

    async conversationName(): Promise<string | undefined> {
      return undefined; // Teams binds by channel id (projects.teamsChannel), never by name
    },

    async findConversation(): Promise<string | undefined> {
      return undefined;
    },

    async openDirect(user: string): Promise<string | undefined> {
      return api.openPersonal(user).catch(() => undefined);
    },

    async postPrivate(to: ConvTarget, user: string, view: PrivateView): Promise<void> {
      await privately({ conv: to.conv, thread: to.thread, user, direct: !to.conv.includes('@thread') }, view);
    },

    async openDialog(action: ChatAction, view: DialogView): Promise<DialogRef | undefined> {
      const open = ctxOf(action).dialog;
      if (!open) return undefined; // not a task/fetch click — nothing can open a dialog now
      if (view.kind === 'ticketLoading') {
        const id = `dialog:${++dialogSeq}`;
        const timer = schedule(() => {
          if (!held.delete(id)) return;
          open(renderDialogView(view));
        }, HOLD_MS);
        held.set(id, { open, timer });
        return { id };
      }
      open(renderDialogView(view));
      return { id: 'dialog' };
    },

    async updateDialog(dialog: DialogRef, view: DialogView): Promise<void> {
      // Only a held dialog can still change: its deferred takes the final view. Once shown, a
      // Teams dialog is not updated by the bot (the person reopens it instead).
      const h = held.get(dialog.id);
      if (!h) {
        log.info(`teams: dialog update ignored (${view.kind}) — ${dialog.id} already shown`);
        return;
      }
      held.delete(dialog.id);
      unschedule(h.timer);
      h.open(renderDialogView(view));
    },

    async refreshRating(action: ChatAction, tally: Tally): Promise<void> {
      // The click's message is the answer card; re-render it with the counts (a card→card edit).
      if (!action.where?.conv || !action.msg?.id) return;
      const ref = { conv: action.where.conv, id: action.msg.id };
      const view = answerCards.get(keyOf(ref));
      if (!view) {
        log.info(`teams: rating refresh skipped — card ${action.msg.id} not known (posted before a restart?)`);
        return;
      }
      const c = answerCard(view, tally);
      if (!c) return;
      await api.update(targetId(ref.conv, chainOf(ref) ?? action.where.thread), ref.id, toActivity({ card: c })).catch((e) => log.error(`rating tally: ${e instanceof Error ? e.message : String(e)}`));
    },

    async publishHome(user: string, view: HomeView): Promise<void> {
      const personal = await api.openPersonal(user);
      if (!personal) throw new Error(`cannot open a 1:1 chat with ${user}`);
      await sendTo(personal, undefined, renderHomeView(view));
    },
  };
}
