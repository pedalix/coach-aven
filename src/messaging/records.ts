// What a bot remembers about agent messaging (OpenSpec `agent-messaging`, design D9–D11, D14), as
// stored in state.json beside the chats (state.ts holds the store; these are the shapes and the pure
// rules over them). Kept out of the ops repo like the rest of state.json.
//
// Every record that belongs to a conversation carries the conversation's key, and the store stamps the
// tenant (`teamId`) from that key, as it does for chats — so per-tenant export and purge stay a filter.
import { isTerminal, type TaskState } from './a2a.js';
import type { Marks } from './protocol.js';
import type { OutboxRecord } from './transport.js';

/**
 * Where a task's answers come back to (D9 step 3): resolved once, when the task starts, and never
 * derived again — the chat record it came from may be pruned while the task is open.
 */
export interface ReplyTarget {
  /** The asking conversation's key (tenant-prefixed). */
  key: string;
  /** The chat driver that renders it; `shadow` for a shadow conversation, whose key is its place. */
  driver: 'slack' | 'teams' | 'shadow';
  channel?: string;
  /** The thread (Slack thread ts, Teams reply chain); absent for a channel-level DM. */
  thread?: string;
}

/** The last message on a task, either way: what `get_task` shows without a round trip. */
export interface TaskMessage {
  at: string;
  role: 'user' | 'agent';
  state: TaskState;
  text: string;
}

/** A task an agent of this installation started (D9 step 6). Keyed by task id. */
export interface OutTask {
  id: string;
  /** The asking agent (project slug) and its tenant (stamped from `key`; absent = home). */
  slug: string;
  teamId?: string;
  /** The asking conversation. */
  key: string;
  reply: ReplyTarget;
  /** `<installation>/<agent>`. */
  target: string;
  /** The target's domain as the asker assumed it (`toDomain`, D14), when known. */
  targetDomain?: string;
  /** The question as sent: the answer's framing quotes it (D11). */
  question: string;
  /** The skill the task asks for (agent-skills): one of the ids the target's card offered. */
  skill?: string;
  state: TaskState;
  /** Why a task ended other than `completed`, as the asker is told it. */
  reason?: string;
  /** 0 from a person's or a routine's conversation; parent + 1 from a shadow conversation (D15). */
  depth: number;
  /** `input-required` rounds so far. */
  rounds: number;
  /** The incoming task whose shadow conversation started this one (D15: cancels cascade down). */
  parent?: { origin: string; id: string };
  /** Ids of the replies sent on this task (derived from the tool call, D9 step 4). */
  replies: string[];
  /** Envelope ids already taken on this task (D6 "Seen ids"). */
  seen: string[];
  last?: TaskMessage;
  /** What the answering turns cost, as reported with the terminal status (D5). */
  cost?: number;
  createdAt: string;
  /** The last message either way: a task idle for longer than the hub's expiry plus one day ends `failed: expired` (D8). */
  updatedAt: string;
}

/** A task an agent of this installation answers in its shadow conversation (D10). Keyed by origin installation and task id. */
export interface InTask {
  id: string;
  /** The asking installation: two senders' task ids never meet. */
  origin: string;
  /** The asking agent, `<installation>/<agent>`, and its domain (checked against the installation, D14). */
  from: string;
  fromDomain: string;
  /** The answering agent (project slug) and its tenant (stamped from `key`). */
  slug: string;
  teamId?: string;
  /** The shadow conversation: `[<tenant>:]a2a:<origin>:<taskId>:<slug>`. */
  key: string;
  question: string;
  /** The skill the asker named (agent-skills); the shadow session started by invoking it. */
  skill?: string;
  state: TaskState;
  reason?: string;
  depth: number;
  /** `request_input` calls so far (at most the project's `maxRounds`). */
  rounds: number;
  /** A `request_input` the asker has not replied to yet. */
  awaitingInput?: boolean;
  /** The one nudge turn was started (D10). */
  nudged?: boolean;
  seen: string[];
  last?: TaskMessage;
  cost?: number;
  createdAt: string;
  updatedAt: string;
}

/** A message waiting for a person's Send because the marks do not let it out (D9, D14). */
export interface HeldMessage {
  /** The message id: the task id for a new task, the reply's id for a reply. */
  id: string;
  task: string;
  kind: 'task' | 'reply';
  slug: string;
  teamId?: string;
  key: string;
  target: string;
  text: string;
  /** The marks that hold it, in words. */
  why: string;
  /** The card that offers Send and Dismiss, once posted. */
  card?: { channel: string; ts: string };
  createdAt: string;
}

/**
 * A message on its way into a conversation (D11), recorded before the transport is acked: on a
 * restart it is recovered from the session (`injected`) or queued as a turn. Removed once the
 * conversation has it (taken up, answered, or its turn journaled).
 */
export interface DeliveryRecord {
  /** The uuid the message is written with. */
  uuid: string;
  /** The conversation it goes into, its project and tenant (stamped from the key). */
  key: string;
  slug: string;
  teamId?: string;
  reply: ReplyTarget;
  text: string;
  /** The trail step when it folds into a running turn. */
  label: string;
  /** The task it belongs to: an outgoing task (an answer for the asker) or an incoming one (a reply for the shadow conversation). */
  task: { dir: 'out' | 'in'; id: string; origin?: string };
  /** Written into a running turn (vs. queued as a turn of its own), and when. */
  injected?: boolean;
  at: string;
}

/** The messaging part of state.json. Absent on an installation that never used messaging. */
export interface MessagingState {
  out?: Record<string, OutTask>;
  /** `<origin>:<taskId>` → the task. */
  in?: Record<string, InTask>;
  /** Conversation key → its marks (D14). Ends only with the conversation's record or a fresh session. */
  marks?: Record<string, Marks>;
  /** Peer agent `<installation>/<agent>` → the domain its card or messages named. */
  domains?: Record<string, string>;
  held?: Record<string, HeldMessage>;
  /** Daily caps: `send|<slug>|<day>` and `accept|<slug>|<sender>|<day>` → count. */
  counts?: Record<string, number>;
  /** The transports' durable records (transport.ts): written before sending or handing over, removed when done. */
  outbox?: { local?: OutboxRecord[]; hub?: OutboxRecord[] };
  /** Messages on their way into a conversation, by uuid (D11). */
  deliveries?: Record<string, DeliveryRecord>;
}

export const inTaskKey = (origin: string, id: string): string => `${origin}:${id}`;
export const isOpen = (t: { state: TaskState }): boolean => !isTerminal(t.state);

/** Daily cap counters (D9 step 5, the answering side's `acceptPerDay`). `day` is a local date (YYYY-MM-DD). */
export const sendCountKey = (slug: string, day: string): string => `send|${slug}|${day}`;
export const acceptCountKey = (slug: string, sender: string, day: string): string => `accept|${slug}|${sender}|${day}`;
/** The day a counter key counts, for pruning. */
export const countKeyDay = (k: string): string => k.slice(k.lastIndexOf('|') + 1);
