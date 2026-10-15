// Earned Keys (design notes/10-design.md §3) — the key types and what each must prove before it may decide.
//
// An answer is about a KEY, not a unit: "this alert family is the shop", "this mail subject is the retainer". A key
// is a typed, deterministic fingerprint of a unit (its thread, its sender's template, its host, its channel …). The
// prior Beta(a, b) of a type is a hypothesis about its homophily — how often a later unit with the same key carries
// the key's label — and k is how many independent human answers one key needs before it may predict at all. A
// type then earns (or loses) the right to decide through trials: every time one of its keys predicted a unit that a
// person later labelled, the type's Beta moves. conf = the type's posterior mean, so a type decides only while its
// MEASURED precision on human-checked units stays at τ or above.

import type { TaskId } from '../../types.js';

export const TAU = 0.95; // the decide/ask cut (design §0); `--opt tau=…` for the sensitivity run

export type KeyType =
  | 'thread' // items: the thread root, or the ticket of a comment
  | 'family' // bot/bulk items: sender + 6-token template + host/app token
  | 'host' // bot items: a hostname the item is about
  | 'app' // bot items: a deploy/app token
  | 'subject' // mail: normalised subject + counterpart domain
  | 'container' // human chat items: the channel or the DM
  | 'domain' // mail: the counterpart's domain (never a free-mail one)
  | 'sender' // human items: the author
  | 'series' // call fragments: a recurring call title
  | 'run' // thread fragments: the container of the run
  | 'cpset' // call/thread fragments: the sorted counterparts
  | 'token' // fragments and items: a rare title/subject word
  | 'cowork' // call/thread fragments: the label of a work block decided by structure next to it
  | 'cue' // t4-kind, human items: which request/question/commitment/incident cues fired
  | 'cont→to' // t4-addressee, unaddressed items: the container's usual addressee
  | 'form'; // t3: a folded surface form

export interface TypeSpec {
  a: number; // Beta prior on the type's homophily
  b: number;
  k: number; // independent answers a key needs before it predicts
  direct?: boolean; // the key's value IS its label (no table to learn: cowork)
}

// §3.2. The priors are hypotheses for the bench to test, not tuned values: weak types start low on purpose.
export const TYPES: Record<KeyType, TypeSpec> = {
  thread: { a: 19, b: 1, k: 1 },
  family: { a: 19, b: 1, k: 1 },
  host: { a: 19, b: 1, k: 1 },
  app: { a: 19, b: 1, k: 1 },
  subject: { a: 9, b: 1, k: 1 },
  container: { a: 8, b: 2, k: 2 },
  domain: { a: 8, b: 2, k: 2 },
  sender: { a: 2, b: 3, k: 3 },
  series: { a: 4, b: 2, k: 2 },
  run: { a: 2, b: 3, k: 3 },
  cpset: { a: 2, b: 3, k: 3 },
  token: { a: 4, b: 2, k: 3 },
  cowork: { a: 2, b: 2, k: 0, direct: true },
  cue: { a: 4, b: 2, k: 2 },
  'cont→to': { a: 4, b: 2, k: 2 },
  form: { a: 39, b: 1, k: 1 },
};

// §3.4: which key types a task consults after the floor. t2-dedup has none: it is the floor's (families are reuse
// keys, not clusters).
export const TASK_TYPES: Partial<Record<TaskId, KeyType[]>> = {
  't1-fragment': ['series', 'run', 'cpset', 'token', 'cowork'],
  't1-item': ['thread', 'family', 'host', 'app', 'subject', 'container', 'domain', 'sender', 'token'],
  't3-identity': ['form'],
  't4-kind': ['family', 'cue'],
  't4-addressee': ['cont→to'],
};

// A key id is "<type>=<value>"; the value may hold anything (titles, hosts, sets), the type never holds '='.
export const keyId = (type: KeyType, value: string): string => `${type}=${value}`;
export const typeOf = (key: string): KeyType => key.slice(0, key.indexOf('=')) as KeyType;
export const valueOf = (key: string): string => key.slice(key.indexOf('=') + 1);
