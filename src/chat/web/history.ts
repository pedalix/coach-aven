// The web surface's history store (OpenSpec web-chat-driver, design D2): Slack and Teams keep the
// messages for us; here the installation must. One append-only JSONL file per conversation under the
// installation's data dir — `web/<slug>/room.jsonl` for a project's room, `web/<slug>/pc-<userId>.jsonl`
// for a person's private conversation — with one event per line: a `post` (a person's or the bot's
// message, with the view model it rendered), an `update` (the bot rewrote a message: status ticks, the
// answer), a `mark` (an acknowledgement on a person's message) and a `tally` (a rating count). The
// current state of every message is the compaction of its events; the room's thread list is derived
// from the roots. The line index is the event's sequence number, so a live stream that reconnects
// with `Last-Event-ID` replays exactly the lines it missed (server.ts).
//
// Views are stored as JSON (`StoredView`): a `question`'s picks become arrays, a `projectPicker`'s
// projects their slugs and repos; `fromStored` rebuilds the MessageView the renderer takes. In memory
// a conversation is loaded once and kept; appends write through synchronously (one line, like
// queue.jsonl), so a crash loses nothing acknowledged.

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Mark } from '../driver.js';
import type { MessageView, PrivateView } from '../views.js';
import { parseConv } from './keys.js';

/** A MessageView as it sits on disk (JSON-safe). */
export type StoredView = Omit<Extract<MessageView, { kind: 'question' }>, 'picks'> & { picks: [number, number[]][] } | Exclude<MessageView, { kind: 'question' }>;

export function toStored(view: MessageView): StoredView {
  if (view.kind === 'question') return { ...view, picks: [...view.picks.entries()].map(([qi, set]) => [qi, [...set]]) };
  if (view.kind === 'projectPicker') return { ...view, projects: view.projects.map((p) => ({ slug: p.slug, repos: p.repos }) as (typeof view.projects)[number]) };
  return view;
}
export function fromStored(view: StoredView): MessageView {
  if (view.kind === 'question') return { ...view, picks: new Map(view.picks.map(([qi, arr]) => [qi, new Set(arr)])) };
  return view;
}

export interface Author {
  id: string;
  name?: string;
}

export type HistoryEvent =
  // A new message. A person's post carries `by` and `text`; the bot's carries `view`. `thread` is the
  // root message's id for a reply (absent on a root and on every message of a private conversation).
  // `visibleTo`: only this person sees it (a private reply, a typed command). `cmd`: the text was a command.
  // `priv`: a private reply's view (what Slack shows ephemerally), always with `visibleTo`.
  | { t: 'post'; id: string; at: string; thread?: string; by?: Author; text?: string; view?: StoredView; priv?: PrivateView; visibleTo?: string; cmd?: true }
  | { t: 'update'; id: string; at: string; view?: StoredView; priv?: PrivateView }
  | { t: 'mark'; id: string; at: string; mark: Mark; op: 'add' | 'remove' }
  | { t: 'tally'; id: string; at: string; good: number; bad: number };

export type Stored = HistoryEvent & { seq: number };
// Omit over each member of the union (a plain Omit keeps only the common keys).
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
/** An event as callers append it: the store stamps `at` (unless given) and `seq`. */
export type AppendEvent = DistributiveOmit<HistoryEvent, 'at'> & { at?: string };

/** The current state of one message: its post, the last view, its marks and rating count. */
export interface Message {
  id: string;
  at: string;
  updatedAt: string;
  thread?: string;
  by?: Author;
  text?: string;
  view?: StoredView;
  priv?: PrivateView;
  visibleTo?: string;
  cmd?: true;
  marks: Mark[];
  tally?: { good: number; bad: number };
}

/** A thread of a room, for the room's list: its root and the activity in it. */
export interface ThreadSummary {
  root: Message;
  lastAt: string;
  replies: number; // messages in the thread besides the root (the bot's and people's)
}

export type Listener = (ev: Stored) => void;

/** A conversation's file and its compacted state; `History.conversation()` hands these out. */
export class Conversation {
  private readonly messages = new Map<string, Message>();
  private readonly order: string[] = []; // message ids in post order
  private readonly listeners = new Set<Listener>();
  private readonly lines: string[] = []; // the raw lines, for replay (`since`)
  seq = 0;

  constructor(
    readonly conv: string,
    private readonly file: string,
    private readonly now: () => Date,
  ) {
    if (existsSync(file)) {
      for (const line of readFileSync(file, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        let ev: Stored;
        try {
          ev = JSON.parse(line) as Stored;
        } catch {
          continue; // a torn last line after a crash: the event never was acknowledged
        }
        this.lines.push(line);
        this.seq = ev.seq;
        this.apply(ev);
      }
    }
  }

  private apply(ev: Stored): void {
    switch (ev.t) {
      case 'post': {
        if (this.messages.has(ev.id)) return; // a duplicate id is a bug upstream; keep the first
        const m: Message = { id: ev.id, at: ev.at, updatedAt: ev.at, marks: [] };
        if (ev.thread) m.thread = ev.thread;
        if (ev.by) m.by = ev.by;
        if (ev.text !== undefined) m.text = ev.text;
        if (ev.view) m.view = ev.view;
        if (ev.priv) m.priv = ev.priv;
        if (ev.visibleTo) m.visibleTo = ev.visibleTo;
        if (ev.cmd) m.cmd = true;
        this.messages.set(ev.id, m);
        this.order.push(ev.id);
        return;
      }
      case 'update': {
        const m = this.messages.get(ev.id);
        if (!m) return;
        if (ev.view) {
          m.view = ev.view;
          delete m.priv;
        } else if (ev.priv) {
          m.priv = ev.priv;
          delete m.view;
        }
        m.updatedAt = ev.at;
        return;
      }
      case 'mark': {
        const m = this.messages.get(ev.id);
        if (!m) return;
        m.marks = m.marks.filter((x) => x !== ev.mark);
        if (ev.op === 'add') m.marks.push(ev.mark);
        return;
      }
      case 'tally': {
        const m = this.messages.get(ev.id);
        if (!m) return;
        m.tally = { good: ev.good, bad: ev.bad };
        return;
      }
    }
  }

  /** Append one event: written, applied, delivered to the listeners. Returns it with its sequence number. */
  append(ev: AppendEvent): Stored {
    const stored = { ...ev, at: ev.at ?? this.now().toISOString(), seq: ++this.seq } as Stored;
    const line = JSON.stringify(stored);
    appendFileSync(this.file, `${line}\n`);
    this.lines.push(line);
    this.apply(stored);
    for (const l of this.listeners) l(stored);
    return stored;
  }

  message(id: string): Message | undefined {
    return this.messages.get(id);
  }
  /** Every message in post order (a private conversation reads it whole). */
  all(): Message[] {
    return this.order.map((id) => this.messages.get(id)!);
  }
  /** A thread: its root first, then every message in it, in post order. */
  thread(rootId: string): Message[] {
    const root = this.messages.get(rootId);
    if (!root) return [];
    return [root, ...this.order.map((id) => this.messages.get(id)!).filter((m) => m.thread === rootId)];
  }
  /** The room's threads, newest activity first (a root is a top-level message; a reply counts for its root). */
  threads(): ThreadSummary[] {
    const sums = new Map<string, ThreadSummary>();
    for (const id of this.order) {
      const m = this.messages.get(id)!;
      if (!m.thread) {
        sums.set(m.id, { root: m, lastAt: m.updatedAt, replies: 0 });
        continue;
      }
      const s = sums.get(m.thread);
      if (!s) continue;
      s.replies++;
      if (m.updatedAt > s.lastAt) s.lastAt = m.updatedAt;
    }
    for (const s of sums.values()) if (s.root.updatedAt > s.lastAt) s.lastAt = s.root.updatedAt;
    return [...sums.values()].sort((a, b) => (a.lastAt < b.lastAt ? 1 : a.lastAt > b.lastAt ? -1 : 0));
  }
  /** The events after `seq`, for a stream that reconnects. */
  since(seq: number): Stored[] {
    return this.lines.slice(Math.max(0, seq)).map((l) => JSON.parse(l) as Stored);
  }
  subscribe(l: Listener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
}

/** Visibility of a stored message or event for a viewer: everyone, or the one person it is for. */
export const visibleFor = (viewer: string, visibleTo: string | undefined): boolean => visibleTo === undefined || visibleTo === viewer;

export class History {
  private readonly open = new Map<string, Conversation>();
  constructor(
    private readonly dir: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** The file of a conversation; a conversation id the web does not own has none. */
  fileOf(conv: string): string | undefined {
    const p = parseConv(conv);
    if (!p) return undefined;
    // `pc-<userId>`: the user id is filename-safe by construction (keys.ts userIdOf: [A-Za-z0-9._@-]).
    return join(this.dir, p.slug, p.kind === 'room' ? 'room.jsonl' : `pc-${p.user}.jsonl`);
  }

  conversation(conv: string): Conversation {
    const cur = this.open.get(conv);
    if (cur) return cur;
    const file = this.fileOf(conv);
    if (!file) throw new Error(`web history: not a web conversation: ${conv}`);
    mkdirSync(join(file, '..'), { recursive: true });
    const c = new Conversation(conv, file, this.now);
    this.open.set(conv, c);
    return c;
  }
}
