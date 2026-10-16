// The Teams chat driver: renders the core's views to Teams messages (cards.ts) and performs
// them against the Bot Connector through a small API seam (TeamsApi) that app.ts binds to the
// Teams SDK and the tests to a recorder. One driver per installation (single tenant).
//
// What differs from Slack, and how the ChatDriver contract absorbs it (design D5–D9):
// - no ephemeral messages → `reply`/`postPrivate` go to the person's 1:1 chat, with a one-line
//   pointer in the thread; a reply to something that already happened in a 1:1 stays there;
// - no reactions → `mark('working')` is the typing indicator, the other marks are no-ops;
// - a dialog opens only as the answer to the click's own `task/fetch` invoke → `openDialog`
//   resolves the deferred the events adapter parked on the ChatAction (`ctx.dialog`);
// - message edits are rate-limited → `update` coalesces to one per TEAMS_STATUS_MIN_MS per
//   message and always flushes the last view.

import type { ChatAction, ChatDriver, ConvTarget, DialogRef, Interaction, Mark, MsgRef } from '../driver.js';
import type { DialogView, HomeView, MessageView, PrivateView } from '../views.js';
import type { Tally } from '../../feedback.js';
import { renderDialogView, renderHomeView, renderMessageView, renderPrivateView, type AdaptiveCard } from './cards.js';
import { splitText } from './format.js';
import { deepLink, targetId } from './keys.js';
import { log } from '../../log.js';

// An outbound activity as the Connector takes it. `text` is Teams markdown.
export interface OutActivity {
  type: 'message' | 'typing';
  text?: string;
  textFormat?: 'markdown';
  attachments?: { contentType: 'application/vnd.microsoft.card.adaptive'; content: AdaptiveCard }[];
  // Everything else the Connector accepts and we never set (summary, entities, …) is omitted.
}

// The Bot Connector surface the driver needs. app.ts binds it to the SDK's ApiClient
// (conversations.createActivity / updateActivity / create); the tests to a recorder.
export interface TeamsApi {
  send(conversationId: string, activity: OutActivity): Promise<{ id: string }>;
  update(conversationId: string, activityId: string, activity: OutActivity): Promise<void>;
  // Open (or find) the 1:1 chat with a person; undefined when the platform refuses.
  openPersonal(userId: string): Promise<string | undefined>;
}

export interface TeamsDriverOpts {
  tenantId: string;
  statusMinMs?: number; // coalescing window for updates of one message (D6); default 2000
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
const ctxOf = (a: Interaction): TeamsActionCtx => (a.ctx ?? { conv: '', direct: false }) as TeamsActionCtx;

export interface TeamsChatDriver extends ChatDriver {
  readonly api: TeamsApi;
}

function toActivity(m: { text?: string; card?: AdaptiveCard }): OutActivity {
  return {
    type: 'message',
    ...(m.text !== undefined ? { text: m.text, textFormat: 'markdown' } : {}),
    ...(m.card ? { attachments: [{ contentType: 'application/vnd.microsoft.card.adaptive', content: m.card }] } : {}),
  };
}

export function teamsDriver(api: TeamsApi, opts: TeamsDriverOpts): TeamsChatDriver {
  const minMs = opts.statusMinMs ?? 2000;
  const now = opts.now ?? Date.now;
  const schedule = opts.setTimeout ?? setTimeout;
  const unschedule = opts.clearTimeout ?? clearTimeout;

  // Per-message coalescing: the newest view wins, one edit per window, the last always lands.
  const pending = new Map<string, { view: MessageView; timer?: ReturnType<typeof setTimeout>; last: number; inflight?: Promise<void> }>();
  async function flush(key: string, msg: MsgRef): Promise<void> {
    const p = pending.get(key);
    if (!p) return;
    p.timer = undefined;
    const view = p.view;
    p.last = now();
    p.inflight = edit(msg, msgThread.get(key), renderMessageView(view)).finally(() => {
      p.inflight = undefined;
    });
    await p.inflight;
  }
  // An edit that carries both text and a card — the answer replacing the status card, with its
  // Show steps / PR buttons — becomes the text in place and the buttons as a follow-up message
  // in the same chain (the pair in one edit is "Activity resulted into multiple skype activities").
  async function edit(msg: MsgRef, thread: string | undefined, m: { text?: string; card?: AdaptiveCard }): Promise<void> {
    const target = targetId(msg.conv, thread);
    if (m.text !== undefined && m.card) {
      await api.update(target, msg.id, toActivity({ text: m.text }));
      await sendTo(msg.conv, thread, { card: m.card });
      return;
    }
    await api.update(target, msg.id, toActivity(m));
  }
  // Where a message we posted lives (the chain it was posted into) — needed to edit it: the
  // Connector addresses an activity by conversation id (chain included) + activity id.
  const msgThread = new Map<string, string | undefined>();
  const keyOf = (m: MsgRef) => `${m.conv}#${m.id}`;

  // Text and card go as SEPARATE messages: Teams splits a text+card activity into two on its
  // side and answers with no usable id (and rejects the pair outright on an edit) — probed
  // 2026-10-16. The reference is the first text message (the card's when there is no text);
  // long text is split under the message limit, parts in order.
  async function sendTo(conv: string, thread: string | undefined, m: { text?: string; card?: AdaptiveCard }): Promise<MsgRef> {
    const target = targetId(conv, thread);
    let first: { id: string } | undefined;
    if (m.text !== undefined) {
      for (const part of splitText(m.text)) {
        const sent = await api.send(target, toActivity({ text: part }));
        first ??= sent;
      }
    }
    if (m.card) {
      const sent = await api.send(target, toActivity({ card: m.card }));
      first ??= sent;
    }
    const ref = { conv, id: first?.id ?? '' };
    msgThread.set(keyOf(ref), thread);
    return ref;
  }

  // A private answer: the person's 1:1 chat, or in place when it already is one (or the chat
  // cannot be opened — better visible than lost).
  async function privately(c: TeamsActionCtx, view: PrivateView): Promise<void> {
    const m = renderPrivateView(view);
    if (c.direct || !c.user) {
      await sendTo(c.conv, c.thread, m);
      return;
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
    capabilities: { reactions: false, privateReplies: 'fallback', threadRepliesNeedMention: opts.threadRepliesNeedMention ?? false },

    async post(to: ConvTarget, view: MessageView): Promise<MsgRef> {
      return sendTo(to.conv, to.thread, renderMessageView(view));
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
      // No reactions on Teams. The one visible acknowledgement is the typing indicator, and only
      // 1:1 chats show it — a channel's status card appears within a second anyway.
      if (mark !== 'working' || op !== 'add' || msg.conv.includes('@thread')) return;
      try {
        await api.send(msg.conv, { type: 'typing' });
      } catch {
        /* best-effort */
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
      open(renderDialogView(view));
      return { id: 'dialog' };
    },

    async updateDialog(_dialog: DialogRef, view: DialogView): Promise<void> {
      // Teams dialogs are not updated in place by the bot; the final view arrives with the next
      // open (PR 2 makes the ticket dialog wait for its data instead).
      log.info(`teams: dialog update ignored (${view.kind})`);
    },

    async refreshRating(): Promise<void> {
      /* rating controls arrive in PR 2 */
    },

    async publishHome(user: string, view: HomeView): Promise<void> {
      const personal = await api.openPersonal(user);
      if (!personal) throw new Error(`cannot open a 1:1 chat with ${user}`);
      await sendTo(personal, undefined, renderHomeView(view));
    },
  };
}
