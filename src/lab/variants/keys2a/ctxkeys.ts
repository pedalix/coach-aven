// K2a (notes/20-iter2.md §K2a.3) — answer scope: a person's answer about a unit a structural rung mapped also teaches
// the key `ctx=<rung instance>` (e.g. `ctx=key:VN`), measured like any key type of K (keys/learner.ts, design §3.2):
//   observe  every human row (answer or audit) on a unit carrying the key, one observation per answer id — an
//            umbrella-day answer that labels its VN items shop AND erp-sync contradicts the key for good
//   predict  a key with ≥ k agreeing independent answers predicts their label at the type's measured homophily
//   trial    a key that predicted a unit a person then labelled moves the TYPE's Beta (one trial per key × answer id)
// A ctx key that predicts X at ≥ τ is an "earned key" for trust.ts (X keeps its rung confidence); below τ it is a
// guess like any of K's. The rung instance's own confidence is the floor's calibration (stage0 §2.5): it falls on the
// same answers — these units are now ASKED, so ordinary answers reach it, not only the rare audit.
//
// The type's prior is the `container` type's (8,2) → .80, k = 2 — a rung instance is a container-like route, and a
// prior strong enough to re-enable an instance after two lucky answers would re-create the over-trust iteration 1
// measured (auto-decided units are never asked again, so only audits could then catch it). `--opt ctxA/ctxB/ctxK`.
//
// THE INVARIANT: only human (and seed) rows are evidence; machine rows only under the poisoning ablation's
// `machineWeight` (K's evidenceWeight). The key's own predictions never reach observe().

import type { MemoryRow, TaskId } from '../../types.js';
import { Learner, evidenceWeight, obsIdOf, type KeyPrediction } from '../keys/learner.js';
import type { KeyType, TypeSpec } from '../keys/spec.js';

export const CTX = 'ctx' as KeyType;
export const CTX_SPEC: TypeSpec = { a: 8, b: 2, k: 2 };
export const ctxKeyOf = (instance: string): string => `ctx=${instance}`;

const sigOf = (r: MemoryRow): string => `${r.source}\u0000${r.day}\u0000${r.id}\u0000${r.answer ?? ''}\u0000${r.audit ? 1 : 0}`;

export class CtxKeys {
  readonly learner: Learner;
  readonly keyOf = new Map<string, string>(); // unit → its ctx key
  readonly predicted = new Map<string, { key: string; label: string }>(); // unit → what its ctx key predicted at decide time
  readonly reach = new Map<string, Map<string, number>>(); // ctx key → local day → units carrying it
  private readonly processed = new Set<string>();
  private readonly trialsDone = new Set<string>();

  constructor(spec: TypeSpec = CTX_SPEC) {
    this.learner = new Learner({ [CTX]: spec } as Record<KeyType, TypeSpec>);
  }

  /** A unit the structural rung `instance` mapped (siblings present): it carries the instance's ctx key. */
  attach(unit: string, instance: string, day: string): string {
    const key = ctxKeyOf(instance);
    if (!this.keyOf.has(unit)) {
      this.keyOf.set(unit, key);
      const log = this.reach.get(key) ?? new Map<string, number>();
      log.set(day, (log.get(day) ?? 0) + 1);
      this.reach.set(key, log);
    }
    return key;
  }

  /** What the key predicts now (consistent: ≥ k agreeing answers), recorded as the unit's trial-to-be. */
  predict(unit: string, key: string): KeyPrediction | null {
    const p = this.learner.predict(key);
    if (p) this.predicted.set(unit, { key, label: p.label });
    else this.predicted.delete(unit);
    return p;
  }

  h(): number {
    return this.learner.h(CTX);
  }

  /** The nightly pass: today's evidence rows into the keys, then one trial per key × answer id. */
  nightly(memory: readonly MemoryRow[], task: TaskId, machineWeight: number): { rows: number; observations: number; trials: number; right: number } {
    const fresh = memory.filter((r) => r.task === task && !this.processed.has(sigOf(r)));
    for (const r of fresh) this.processed.add(sigOf(r));
    const evidence = fresh.filter((r) => evidenceWeight(r, machineWeight) > 0 && this.keyOf.has(r.id));
    let observations = 0;
    for (const r of evidence) if (this.learner.observe(this.keyOf.get(r.id)!, r.label, obsIdOf(r), evidenceWeight(r, machineWeight))) observations++;
    const outcome = new Map<string, { ok: boolean; w: number }>();
    for (const r of evidence) {
      const p = this.predicted.get(r.id);
      if (!p) continue;
      const id = `${p.key}\u0000${obsIdOf(r)}`;
      if (this.trialsDone.has(id)) continue;
      const cur = outcome.get(id);
      outcome.set(id, { ok: (cur?.ok ?? true) && r.label === p.label, w: Math.max(cur?.w ?? 0, evidenceWeight(r, machineWeight)) });
    }
    let right = 0;
    for (const [id, t] of outcome) {
      this.trialsDone.add(id);
      this.learner.trial(CTX, t.ok, t.w);
      if (t.ok) right++;
    }
    return { rows: evidence.length, observations, trials: outcome.size, right };
  }
}
