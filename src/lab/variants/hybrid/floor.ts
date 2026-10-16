// The hybrid (notes/30-iter3.md §2) — the floor J stands on is the SPINE. J (judge.ts, composed unchanged) reads a
// Stage0: it keeps every unit whose floor conf ≥ τ and judges the rest. Handing it this adapter makes "the rest" exactly
// the spine's residue — the units K2a (or K2b) did not auto-decide — and makes the card's "weak hint" what the spine
// actually believes (its held X at .85, a sibling's .60 guess, a sub-τ key guess) instead of raw stage 0.
//
//   fragment() / item() / kind()   the spine's prediction of the unit as a Floor: its label, conf and rung; the rest of
//                                  the Floor (candidates, hint, case, participants, cowork, sender class, family, hosts,
//                                  apps, umbrella) is the floor AS THE SPINE SAW IT — for K2a the trusted floor (stage 0
//                                  after the sibling check: X and its siblings as candidates, the check's reason as the
//                                  hint), else stage 0. A spine label off the candidates joins them first. A pool unit
//                                  the spine did not decide today (no gold, not in the population) is that floor as is.
//   everything else                stage 0 as the spine runs it (one instance per run, the spine's): mentions, addressees,
//                                  dedup, the closed list, the registry cards.
//   calibrate()                    nothing. J's nightly hands it J's `floorDecided` (units the SPINE decided, under the
//                                  spine's rungs — earned:thread, held:key:VN …): the spine calibrates its own floor in
//                                  its own nightly, from human rows only, and must not hear the same answer twice.
//
// The adapter holds today's spine predictions only (set() before J decides); it never writes anything the spine reads.

import type { FragmentUnit, ItemUnit, MemoryRow, Prediction, TaskId } from '../../types.js';
import type { Floor, RegistryCard, Stage0 } from '../stage0/index.js';

/** A unit's floor with the spine's decision on top (the extras of `f` — participants, family … — are kept). */
export function asFloor<F extends Floor>(f: F, p: Prediction | undefined): F {
  if (!p) return f;
  const label = p.label;
  const candidates = label !== null && !f.candidates.includes(label) ? [label, ...f.candidates] : f.candidates;
  return { ...f, label, conf: label === null ? 0 : p.conf, rung: p.rung, candidates };
}

export class SpineFloor implements Stage0 {
  private preds = new Map<string, Prediction>();
  private seen: Stage0 | null = null; // the floor as the spine saw it (K2a: the trusted floor)
  private raw: Stage0 | null = null; // stage 0 as the spine runs it

  /** Today's spine predictions, and the two floors to complete them from. */
  set(seen: Stage0, raw: Stage0, preds: readonly Prediction[]): void {
    this.seen = seen;
    this.raw = raw;
    this.preds = new Map(preds.map((p) => [p.id, p]));
  }

  private get s(): Stage0 {
    if (!this.seen) throw new Error('hybrid: the spine floor was read before the spine decided');
    return this.seen;
  }

  private get r(): Stage0 {
    if (!this.raw) throw new Error('hybrid: the spine floor was read before the spine decided');
    return this.raw;
  }

  fragment(u: FragmentUnit, pool: FragmentUnit[]) {
    return asFloor(this.s.fragment(u, pool), this.preds.get(u.id));
  }

  item(u: ItemUnit, pool: ItemUnit[]) {
    return asFloor(this.s.item(u, pool), this.preds.get(u.id));
  }

  kind(u: ItemUnit): Floor {
    return asFloor(this.r.kind(u), this.preds.get(u.id));
  }

  mention(u: Parameters<Stage0['mention']>[0]) {
    return this.r.mention(u);
  }

  addressee(u: ItemUnit): Floor {
    return this.r.addressee(u);
  }

  dedup(units: ItemUnit[]) {
    return this.r.dedup(units);
  }

  labelSpace(task: TaskId): string[] {
    return this.r.labelSpace(task);
  }

  cards(): RegistryCard[] {
    return this.r.cards();
  }

  calibrate(_rows: MemoryRow[], _decided: Map<string, string>): void {
    // the spine's nightly calibrates its floor (human rows only); see the header
  }
}
