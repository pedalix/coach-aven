// The Earned Keys learner (design §3.1–§3.3, §3.6): key tables, type reliabilities, trials, and the per-unit decision
// over the keys that are allowed to speak. Pure and deterministic — no I/O, no model, no clock.
//
// THE INVARIANT (§3.1): machine output is never evidence. Only memory rows a person wrote (answers AND audits, source
// 'human') and the tenant's seed rows move a key or a type. The pipeline's own auto-decisions (source 'machine') are
// ignored unless the poisoning ablation gives them a weight (`machineWeight`); K's predictions, sub-τ floor rungs and
// model guesses never reach this class at all.
//
// Independence: one answer id is ONE observation for a key, however many of the key's units it covered — twelve alerts
// of one family answered together are one fact about the family, not twelve.

import type { MemoryRow } from '../../types.js';
import { TYPES, typeOf, valueOf, type KeyType, type TypeSpec } from './spec.js';

export interface KeyEntry {
  labels: Map<string, number>; // label → evidence weight
  obs: Set<string>; // observation (answer) ids already counted for this key
  n: number; // independent observations (a machine row counts its weight)
}

export interface KeyPrediction {
  key: string;
  type: KeyType;
  label: string;
  conf: number; // h_T + 0.001·min(n, 9): the type's measured homophily, more answers break ties
  n: number;
}

export interface Beta {
  a: number;
  b: number;
}

/** The observation id of a memory row: its answer, else the row itself (seed lines, oracle rows, machine rows). */
export const obsIdOf = (r: MemoryRow): string => r.answer ?? `${r.source}:${r.day}:${r.id}`;

/** The weight a row carries as evidence: people and seeds 1, the pipeline's own decisions `machineWeight` (0 = none). */
export const evidenceWeight = (r: MemoryRow, machineWeight: number): number => (r.source === 'machine' ? Math.max(0, machineWeight) : 1);

export class Learner {
  readonly tables = new Map<string, KeyEntry>();
  readonly rel: Record<KeyType, Beta>;
  trials = { success: 0, failure: 0 };

  constructor(readonly spec: Record<KeyType, TypeSpec> = TYPES) {
    this.rel = Object.fromEntries(Object.entries(spec).map(([t, s]) => [t, { a: s.a, b: s.b }])) as Record<KeyType, Beta>;
  }

  /** The type's measured homophily: the posterior mean of its Beta. */
  h(type: KeyType): number {
    const r = this.rel[type];
    return r.a / (r.a + r.b);
  }

  /**
   * One evidence row for one key. The label always joins the key's label set (an answer that labels the key's units two
   * ways contradicts it), but an observation id counts once. Returns whether the observation was new.
   */
  observe(key: string, label: string, obs: string, w = 1): boolean {
    if (w <= 0 || this.spec[typeOf(key)].direct) return false;
    let e = this.tables.get(key);
    if (!e) this.tables.set(key, (e = { labels: new Map(), obs: new Set(), n: 0 }));
    e.labels.set(label, (e.labels.get(label) ?? 0) + w);
    if (e.obs.has(obs)) return false;
    e.obs.add(obs);
    e.n += w;
    return true;
  }

  /** Two labels on one key: it never predicts again (§3.6.3 — contradiction is automatic). */
  contradicted(key: string): boolean {
    return (this.tables.get(key)?.labels.size ?? 0) > 1;
  }

  /** A consistent key predicts: ≥ k independent observations, all agreeing. A direct key (cowork) predicts its value. */
  predict(key: string): KeyPrediction | null {
    const type = typeOf(key);
    const s = this.spec[type];
    if (s.direct) return { key, type, label: valueOf(key), conf: this.h(type), n: 0 };
    const e = this.tables.get(key);
    if (!e || e.labels.size !== 1 || e.n <= 0 || e.n < s.k) return null;
    const label = e.labels.keys().next().value as string;
    return { key, type, label, conf: this.h(type) + 0.001 * Math.min(e.n, 9), n: e.n };
  }

  /** A trial of a type: one of its keys predicted a unit a person then labelled (§3.6.2). */
  trial(type: KeyType, success: boolean, w = 1): void {
    if (w <= 0) return;
    if (success) {
      this.rel[type].a += w;
      this.trials.success += w;
    } else {
      this.rel[type].b += w;
      this.trials.failure += w;
    }
  }

  /** Keys a person has confirmed ≥ minN times, of a type measured ≥ minH: in production each is an R-question (§3.6.5). */
  ruleCandidates(minN = 3, minH = 0.9): string[] {
    const out: string[] = [];
    for (const [key, e] of this.tables) if (e.labels.size === 1 && e.n >= minN && this.h(typeOf(key)) >= minH) out.push(key);
    return out.sort();
  }

  /** How many keys of each type are consistent / contradicted (for the nightly log — counts only, never values). */
  census(): Record<string, { consistent: number; contradicted: number }> {
    const out: Record<string, { consistent: number; contradicted: number }> = {};
    for (const [key, e] of this.tables) {
      const t = typeOf(key);
      const row = (out[t] ??= { consistent: 0, contradicted: 0 });
      if (e.labels.size > 1) row.contradicted++;
      else if (e.n >= this.spec[t].k) row.consistent++;
    }
    return out;
  }
}

// --- the decision (§3.3) ------------------------------------------------------------------------------------------

export interface FloorView {
  label: string | null;
  conf: number;
  rung: string;
  candidates: string[];
}

export interface UnitDecision {
  label: string | null;
  conf: number;
  rung: string;
  why: string;
  guess: string | null; // what K would propose if the unit is asked
  preds: KeyPrediction[]; // every key that predicted, agreeing or not (the trials of tonight)
  best: KeyPrediction | null; // the strongest predicting key
}

// A disagreement or a lone floor candidate is a guess only: it must sort below anything the keys agree on.
const SPLIT_PENALTY = 0.5;
const CANDIDATE_CONF = 0.3;

const stronger = (a: KeyPrediction, b: KeyPrediction): number => b.conf - a.conf || b.n - a.n || a.key.localeCompare(b.key);
const short = (s: string, n = 48): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/**
 * Decide one unit after the floor:
 *   1. the floor decides when its conf ≥ τ (its rung calibration may already have demoted it below);
 *   2. every active key that is consistent predicts its label at h_T (+ a tie-break on the number of answers);
 *   3. all predicting keys agree → that label at the strongest conf (no noisy-OR: keys of one unit are correlated);
 *      they disagree → nothing is decided;
 *   4. otherwise the best guess below τ: the agreeing keys, the strongest key of a split, the floor's own sub-τ label,
 *      its single candidate — whichever is surest — else nothing.
 */
export function decideUnit(floor: FloorView, keys: readonly string[], learner: Learner, tau: number): UnitDecision {
  const preds = keys.map((k) => learner.predict(k)).filter((p): p is KeyPrediction => !!p).sort(stronger);
  const best = preds[0] ?? null;
  if (floor.label !== null && floor.conf >= tau) {
    return { label: floor.label, conf: floor.conf, rung: floor.rung, why: `floor ${floor.rung}`, guess: floor.label, preds, best };
  }
  const labels = new Set(preds.map((p) => p.label));
  const options: { label: string; conf: number; rung: string; why: string }[] = [];
  if (best && labels.size === 1) {
    const why = `${best.type} "${short(valueOf(best.key))}" ${best.n} answer${best.n === 1 ? '' : 's'} · type ${learner.h(best.type).toFixed(3)}${preds.length > 1 ? ` · ${preds.length} keys agree` : ''}`;
    if (best.conf >= tau) return { label: best.label, conf: best.conf, rung: `earned:${best.type}`, why, guess: best.label, preds, best };
    options.push({ label: best.label, conf: best.conf, rung: `guess:${best.type}`, why });
  } else if (best) {
    options.push({ label: best.label, conf: Math.min(best.conf, tau) * SPLIT_PENALTY, rung: 'guess:split', why: `${labels.size} labels from ${preds.length} keys; strongest ${best.type}` });
  }
  if (floor.label !== null) options.push({ label: floor.label, conf: floor.conf, rung: floor.rung, why: `floor ${floor.rung} below τ` });
  else if (floor.candidates.length === 1) options.push({ label: floor.candidates[0]!, conf: CANDIDATE_CONF, rung: 'guess:candidate', why: 'the floor’s only candidate' });
  const pick = options.sort((a, b) => b.conf - a.conf)[0];
  if (!pick) return { label: null, conf: 0, rung: 'abstain', why: 'no key, no floor', guess: null, preds, best };
  // Never a decision from here: a guess stays below τ whatever its source said.
  return { label: pick.label, conf: Math.min(pick.conf, tau - 0.001), rung: pick.rung, why: pick.why, guess: pick.label, preds, best };
}
