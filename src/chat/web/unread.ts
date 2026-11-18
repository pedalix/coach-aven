// What is new for a reader of the web chat (OpenSpec web-chat-driver, "Unread counts"), pure. The server says WHEN
// each message became news for this viewer; the browser keeps what the viewer has seen (localStorage, per thread,
// app.js) and counts. So the server holds no read state, and the page and the live stream render the same marks.
//
// News is what a reader would open the thread for: another person's post, and the bot's message once it holds
// something to read (an answer, a question, a report, a notice). A turn's running status is not news, nor its
// "working in the background" card or that card's epitaph: an answer that replaces the status in place counts once,
// when it lands, and a thread does not light up at every tick of the clock. A routine's headline (`line`) counts
// when it is posted, not at each rewrite: the answer under it carries the news. A message only one person sees (a
// typed command, a private reply) answers that person's own action, so it is never news.

import type { Message } from './history.js';

/** View kinds that only show a turn in progress. */
const PROGRESS = new Set(['status', 'background', 'backgroundDone']);

/** The newest news times a thread card carries; the browser shows "20+" when all of them are unread. */
export const CARD_NEWS = 20;
/** How many of a room's threads the sidebar counts (those with the newest news). */
export const SIDEBAR_THREADS = 50;

/** When `m` became news for `viewer` (ISO), or undefined when it never is. */
export function newsAt(m: Message, viewer: string): string | undefined {
  if (m.visibleTo) return undefined;
  if (m.by) return m.by.id === viewer ? undefined : m.at;
  if (m.view) {
    if (PROGRESS.has(m.view.kind)) return undefined;
    return m.view.kind === 'line' ? m.at : m.updatedAt;
  }
  return m.priv ? undefined : m.at; // the bot's files
}

/**
 * A room's news per thread for `viewer`: root id → news times, oldest first. One pass in post order (a root comes
 * before its replies); a thread whose root someone else holds privately is left out whole.
 */
export function roomNews(messages: Message[], viewer: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const hidden = new Set<string>();
  for (const m of messages) {
    const root = m.thread ?? m.id;
    if (!m.thread && m.visibleTo && m.visibleTo !== viewer) hidden.add(m.id);
    if (hidden.has(root)) continue;
    const at = newsAt(m, viewer);
    if (!at) continue;
    const list = out.get(root);
    if (list) list.push(at);
    else out.set(root, [at]);
  }
  for (const list of out.values()) list.sort();
  return out;
}

/** A thread card's `data-news`: its newest news times, space-separated. */
export const cardNews = (news: string[] | undefined): string => (news ?? []).slice(-CARD_NEWS).join(' ');

/** A sidebar room link's `data-threads`: `root@newest` for the threads with the newest news, space-separated. */
export function sidebarThreads(news: Map<string, string[]>): string {
  return [...news]
    .map(([root, list]) => [root, list[list.length - 1]] as const)
    .sort((a, b) => (a[1] < b[1] ? 1 : a[1] > b[1] ? -1 : 0))
    .slice(0, SIDEBAR_THREADS)
    .map(([root, at]) => `${root}@${at}`)
    .join(' ');
}

/** The key the browser stores a thread's "seen" under: the room's conversation and the root. */
export const threadSeenKey = (conv: string, root: string): string => `${conv}#${root}`;
