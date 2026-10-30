// The web chat driver (OpenSpec web-chat-driver): the core's views become messages in the history store
// (history.ts), which the pages read and the live streams relay (server.ts). Nothing is sent anywhere —
// the browser pulls the page and listens to its stream — so every ChatDriver method is an append:
//
// - post / update / mark: a `post`, `update` or `mark` event in the conversation's file; the engine's
//   references are our own message ids, so a status message rebuilt after a restart updates fine;
// - reply / postPrivate: a message only the acting person sees (`visibleTo`), the private reply being
//   native here (what Slack shows ephemerally); `replace` rewrites this interaction's last private reply;
// - openDialog / updateDialog / publishHome: a push to the person's open pages (every page's stream
//   also carries their dialogs), identified by a dialog id so a later update swaps the content;
// - refreshRating: a `tally` event; the message re-renders with the counts;
// - permalink: the thread's page; conversationName / findConversation / openDirect: none — rooms and
//   private conversations name their project (keys.ts), and a private question is answered where it
//   was asked, visible to the asker alone (design D6a).

import type { ChatAction, ChatDriver, ConvTarget, DialogRef, Interaction, Mark, MsgRef } from '../driver.js';
import type { DialogView, HomeView, MessageView, PrivateView } from '../views.js';
import type { Tally } from '../../feedback.js';
import { History, toStored } from './history.js';
import { newId, pageUrl, parseConv } from './keys.js';
import { renderDialogView, renderHomeView, type NameOf } from './webviews.js';
import { log } from '../../log.js';

/** What a web interaction carries that the core never sees: where it happened and who acted. */
export interface WebCtx {
  conv: string;
  thread?: string;
  user: string;
  /** The last private reply of this interaction (a command's successive `say`s replace one another). */
  last?: string;
}

/** A push to one person's open pages (their streams relay it). */
export type UserPush = { kind: 'dialog'; id: string; title: string; html: string };

export interface WebDriverDeps {
  history: History;
  baseUrl: string;
  nameOf: NameOf;
  /** Fresh message / dialog ids (tests: sequential). */
  ids?: () => string;
}

export interface WebChatDriver extends ChatDriver {
  /** Subscribe to one person's pushes (dialogs); returns the unsubscribe. */
  onUser(user: string, fn: (p: UserPush) => void): () => void;
  /** The people with an open page right now (for the journal). */
  online(): string[];
  /** A dialog this driver opened: whose it is and the form it holds (its submit handler and metadata, kept here,
   *  never sent to the browser). Undefined for an unknown or expired dialog. */
  dialogOf(id: string): { user: string; submit?: { id: string; meta: string } } | undefined;
  /** A dialog's form was submitted: it cannot be submitted again (an update may still reach the person). */
  submitted(id: string): void;
}

const ctxOf = (a: Interaction): WebCtx | undefined => (a.ctx && typeof (a.ctx as WebCtx).user === 'string' ? (a.ctx as WebCtx) : undefined);

export function webDriver(deps: WebDriverDeps): WebChatDriver {
  const { history } = deps;
  const ids = deps.ids ?? (() => newId('m'));
  const dialogIds = deps.ids ? () => `d${deps.ids!()}` : () => newId('d');
  const listeners = new Map<string, Set<(p: UserPush) => void>>();
  // dialog id → its person and form (bounded: the map is pruned past 1000)
  const dialogs = new Map<string, { user: string; submit?: { id: string; meta: string } }>();
  // A push lands on the person's open pages — and on the page that opens next within a few seconds: a command
  // typed at a room's top level opens its thread page, so the dialog it produces (`/help`, `/home`) would otherwise
  // reach only the page being left (the first browser pass lost every such dialog). Each new stream replays the
  // person's recent pushes once; a page that already showed one shows it again only if it is another tab.
  const RECENT_MS = 15_000;
  const recent = new Map<string, { at: number; push: UserPush }[]>();
  const remember = (user: string, p: UserPush) => {
    const now = Date.now();
    const list = (recent.get(user) ?? []).filter((r) => now - r.at < RECENT_MS);
    list.push({ at: now, push: p });
    recent.set(user, list.slice(-5));
  };

  function push(user: string, p: UserPush): boolean {
    remember(user, p);
    const set = listeners.get(user);
    if (!set?.size) {
      log.info(`web: ${p.kind} for ${user} waits for a page — none open right now`);
      return true;
    }
    for (const fn of set) fn(p);
    return true;
  }

  function privately(c: WebCtx, view: PrivateView, replace: boolean): void {
    const conv = history.conversation(c.conv);
    if (replace && c.last && conv.message(c.last)) {
      conv.append({ t: 'update', id: c.last, priv: view });
      return;
    }
    const id = ids();
    conv.append({ t: 'post', id, ...(c.thread ? { thread: c.thread } : {}), priv: view, visibleTo: c.user });
    c.last = id;
  }

  return {
    capabilities: { reactions: true, privateReplies: 'native', threadRepliesNeedMention: false },

    onUser(user, fn) {
      const set = listeners.get(user) ?? new Set();
      set.add(fn);
      listeners.set(user, set);
      const now = Date.now();
      for (const r of recent.get(user) ?? []) if (now - r.at < RECENT_MS) fn(r.push);
      return () => {
        set.delete(fn);
        if (!set.size) listeners.delete(user);
      };
    },
    online: () => [...listeners.keys()],
    dialogOf: (id) => dialogs.get(id),
    submitted: (id) => {
      const d = dialogs.get(id);
      if (d) dialogs.set(id, { user: d.user });
    },

    async post(to: ConvTarget, view: MessageView): Promise<MsgRef> {
      const id = ids();
      history.conversation(to.conv).append({ t: 'post', id, ...(to.thread ? { thread: to.thread } : {}), view: toStored(view) });
      return { conv: to.conv, id };
    },

    async update(msg: MsgRef, view: MessageView): Promise<void> {
      const conv = history.conversation(msg.conv);
      if (!conv.message(msg.id)) log.warn(`web: update of an unknown message ${msg.conv}#${msg.id} (${view.kind}) — appended anyway`);
      conv.append({ t: 'update', id: msg.id, view: toStored(view) });
    },

    async mark(msg: MsgRef, mark: Mark, op: 'add' | 'remove'): Promise<void> {
      try {
        history.conversation(msg.conv).append({ t: 'mark', id: msg.id, mark, op });
      } catch (e) {
        log.warn(`web mark ${op} ${mark} on ${msg.conv}#${msg.id}: ${e instanceof Error ? e.message : String(e)}`);
      }
    },

    async permalink(msg: MsgRef): Promise<string | undefined> {
      return parseConv(msg.conv)?.kind === 'room' ? pageUrl(deps.baseUrl, msg.conv, msg.id) : undefined;
    },

    async reply(to: Interaction, view: PrivateView, opts?: { replace?: boolean }): Promise<void> {
      const c = ctxOf(to);
      if (!c) throw new Error('web: a reply needs the interaction context (conversation and person)');
      privately(c, view, opts?.replace === true);
    },

    async conversationName(): Promise<string | undefined> {
      return undefined; // rooms name their project themselves (channels.ts projectOf)
    },
    async findConversation(): Promise<string | undefined> {
      return undefined; // conversationFor answers for the web (channels.ts)
    },
    async openDirect(): Promise<string | undefined> {
      return undefined; // D6a: a private question is answered where it was asked, for the asker alone
    },

    async postPrivate(to: ConvTarget, user: string, view: PrivateView): Promise<void> {
      privately({ conv: to.conv, thread: to.thread, user }, view, false);
    },

    async openDialog(action: ChatAction, view: DialogView): Promise<DialogRef | undefined> {
      const c = ctxOf(action);
      if (!c) return undefined;
      const id = dialogIds();
      const r = renderDialogView(view, { nameOf: deps.nameOf });
      dialogs.set(id, { user: c.user, ...(r.submit ? { submit: r.submit } : {}) });
      if (dialogs.size > 1000) dialogs.delete(dialogs.keys().next().value!);
      push(c.user, { kind: 'dialog', id, title: r.title, html: r.html.html });
      return { id };
    },

    async updateDialog(dialog: DialogRef, view: DialogView): Promise<void> {
      const d = dialogs.get(dialog.id);
      if (!d) {
        log.info(`web: dialog update ignored (${view.kind}) — ${dialog.id} unknown`);
        return;
      }
      const r = renderDialogView(view, { nameOf: deps.nameOf });
      dialogs.set(dialog.id, { user: d.user, ...(r.submit ? { submit: r.submit } : {}) });
      push(d.user, { kind: 'dialog', id: dialog.id, title: r.title, html: r.html.html });
    },

    async refreshRating(action: ChatAction, tally: Tally): Promise<void> {
      if (!action.where?.conv || !action.msg?.id) return;
      try {
        history.conversation(action.where.conv).append({ t: 'tally', id: action.msg.id, good: tally.good, bad: tally.bad });
      } catch (e) {
        log.error(`rating tally: ${e instanceof Error ? e.message : String(e)}`);
      }
    },

    async publishHome(user: string, view: HomeView): Promise<void> {
      // The Home page is served on GET /; `/home` and the first visit show it as a dialog on the open page.
      const html = renderHomeView(view, (slug) => `/r/${encodeURIComponent(slug)}`).html;
      push(user, { kind: 'dialog', id: dialogIds(), title: 'Aven', html });
    },
  };
}
