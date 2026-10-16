// K2a (notes/20-iter2.md §K2a.2) — umbrella-first questions. A unit whose client is decided (a structural rung at its
// client confidence ≥ τ) but whose initiative is not is asked with every such unit of the same client that local day:
// "these N items of <client> today — which initiative?" with a guess. One answer covers the group; under the bench's
// effort model each further initiative among them costs one more question, so the group is cheap exactly when the
// client's day was about one thing, and its answer still teaches every member's keys and the rung instances at once.
//
// Everything else keeps K's group (its key with the best expected yield, or its case). A group holds at most K's
// MAX_GROUP members (an overflow becomes `…#2` chunks, ranked lower). Its value is the sum of its members' K values —
// what K expected each answer to buy — plus, once per group, the yield of the rung instances' ctx keys
// (0.5 · reach · h, K's yield formula). Its guess is the surest member's own guess; the form is `confirm` whenever a
// guess exists. Pure: predictions are updated in place.

import type { Prediction } from '../../types.js';
import { MAX_GROUP } from '../keys/questions.js';

export interface ClientView {
  client: string;
  umbrellaConf: number;
}

export interface UmbrellaOpts {
  day: string; // the local day being decided
  tau: number;
  weight: (id: string) => number; // minutes for a fragment (1 when it has none), 1 for an item
  gain?: (ids: readonly string[]) => number; // the yield an answer about these units buys (added once per group)
  max?: number;
}

export const umbrellaGroupOf = (client: string, day: string): string => `umb:${client}:${day}`;

/** Regroup the day's questions whose client is decided; returns how many units moved. */
export function umbrellaFirst(preds: Prediction[], clientOf: (id: string) => ClientView | undefined, o: UmbrellaOpts): number {
  const max = o.max ?? MAX_GROUP;
  const byClient = new Map<string, Prediction[]>();
  for (const p of preds) {
    if (p.label !== null && p.conf >= o.tau) continue; // decided: not a question
    const c = clientOf(p.id);
    if (!c || c.umbrellaConf < o.tau) continue;
    const list = byClient.get(c.client) ?? [];
    list.push(p);
    byClient.set(c.client, list);
  }
  const own = (p: Prediction): number => o.weight(p.id) * (1 - Math.min(1, Math.max(0, p.label === null ? 0 : p.conf)));
  let moved = 0;
  for (const [client, members] of [...byClient].sort(([a], [b]) => a.localeCompare(b))) {
    members.sort((a, b) => own(b) - own(a) || a.id.localeCompare(b.id));
    for (let i = 0; i < members.length; i += max) {
      const chunk = members.slice(i, i + max);
      const group = `${umbrellaGroupOf(client, o.day)}${i ? `#${i / max + 1}` : ''}`;
      const gain = i === 0 && o.gain ? o.gain(chunk.map((p) => p.id)) / chunk.length : 0;
      // the surest member's own guess (its label below τ), ties by id
      const lead = chunk.filter((p) => p.label !== null).sort((a, b) => b.conf - a.conf || a.id.localeCompare(b.id))[0];
      const guess = lead?.label ?? null;
      for (const p of chunk) {
        p.ask = { group, value: (p.ask?.value ?? own(p)) + gain, guess, form: guess ? 'confirm' : 'choose' };
        moved++;
      }
    }
  }
  return moved;
}
