// Company brain: the use log and what the host derives from it (design D3, D5). One entry per turn that read or
// changed a memory record — names only, no message or answer text — and, from those entries, each record's
// provenance: how many turns started by a person used it, when last, and when it was last revised after a
// person's reply. Nobody marks anything and the agent cannot write any of it: the host reads the turn's stream
// and the mirror, never a record's own claims. Pure.

import { INDEX_FILE } from './index.js';

/** What started a turn: a person's message or command, a scheduled routine, a poller (review, autofix, tracker), another agent. */
export type Starter = 'person' | 'routine' | 'poller' | 'agent';

export interface UseEntry {
  at: string; // ISO
  key: string; // the conversation
  turnId: string;
  by: Starter;
  read: string[]; // record file names a tool input of the turn named — a heuristic
  changed: string[]; // record file names the mirror saw created or changed — exact
}

// The record files a tool input names: `…/memory/<file>.md` anywhere in it (a Read path, a shell command, a
// grep target). A heuristic by design — a record read through `cd memory && cat x.md` is missed, and the only
// cost is a use that is not counted.
export function memoryNames(input: unknown): string[] {
  let text: string;
  try {
    text = typeof input === 'string' ? input : JSON.stringify(input ?? '');
  } catch {
    return [];
  }
  const out = new Set<string>();
  for (const m of text.matchAll(/\/memory\/([A-Za-z0-9._-]+\.md)(?![A-Za-z0-9._-])/g)) if (m[1] !== INDEX_FILE) out.add(m[1]);
  return [...out].sort();
}

const records = (names: readonly string[], known: ReadonlySet<string>): string[] => [...new Set(names)].filter((n) => n !== INDEX_FILE && known.has(n)).sort();

// The entry for one turn, or undefined when it touched no record. `known` is the set of record files the host
// has (a name the agent mistyped is not a use); a changed record also counts as known — it may be new.
export function useEntry(o: { at: string; key: string; turnId: string; by: Starter; read: readonly string[]; changed: readonly string[]; known: readonly string[] }): UseEntry | undefined {
  const known = new Set([...o.known, ...o.changed].filter((n) => n.endsWith('.md')));
  const changed = records(o.changed, known);
  const read = records(o.read, known).filter((n) => !changed.includes(n));
  if (!read.length && !changed.length) return undefined;
  return { at: o.at, key: o.key, turnId: o.turnId, by: o.by, read, changed };
}

export interface Provenance {
  uses: number; // turns started by a person that read or changed the record
  lastUsed?: string;
  // The last time a turn started by a person changed the record in a conversation where an earlier turn had
  // already read or changed it: the agent answered from it, a person replied, the record changed. Evidence of
  // attention, not proof — and its absence after any number of uses means nobody checked.
  revisedAfterReply?: string;
}

export function provenance(entries: readonly UseEntry[]): Map<string, Provenance> {
  const out = new Map<string, Provenance>();
  const touched = new Map<string, Set<string>>(); // conversation → records an earlier turn used
  const get = (n: string): Provenance => out.get(n) ?? (out.set(n, { uses: 0 }), out.get(n)!);
  for (const e of [...entries].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0))) {
    const seen = touched.get(e.key) ?? new Set<string>();
    if (e.by === 'person') {
      for (const n of [...e.read, ...e.changed]) {
        const p = get(n);
        p.uses += 1;
        p.lastUsed = e.at;
      }
      for (const n of e.changed) if (seen.has(n)) get(n).revisedAfterReply = e.at;
    }
    for (const n of [...e.read, ...e.changed]) seen.add(n);
    touched.set(e.key, seen);
  }
  return out;
}

export const parseJsonl = <T>(text: string): T[] => {
  const out: T[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as T);
    } catch {
      /* a torn last line after a crash: skipped */
    }
  }
  return out;
};
