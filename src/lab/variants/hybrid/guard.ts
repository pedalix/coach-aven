// The guard of hybrid-g (iteration 3b) — pure. Iteration 3 found every frozen error the hybrid added in J's own
// auto-decisions: its cells crossed τ after 1–9 answers to ORDINARY questions, which are chosen because the pipeline was
// unsure — not a sample of what the cell then decides. Here a model's decision must be EARNED on representative evidence:
//
//   cell       J's cell (kind × agreement/cite) split by J's relation to the spine: 'agree' (J names the spine's own
//              sub-τ label — on t4 the floor's rung label), 'silent' (the spine has none), 'contradict' (another label).
//              An agree cell is kept per family of the spine's rung (held, sib, guess, rule, sender …): its prior IS that
//              rung's calibrated precision — the spine already measured itself — and J agreeing with a sender rung (t4:
//              99.5% right in iteration 3) is not J agreeing with a keyword guess (75%).
//   prior      agree: the spine's confidence on the unit (its rung instance's calibrated precision, K2a's caps included);
//              silent / contradict: J's prior means (judge/cells.ts). Either counts as `strength` pseudo-observations.
//   the right  a cell decides only when the Wilson LOWER bound (z) of prior + RANDOM evidence is ≥ τ. Random evidence =
//              audits of units the cell decided + answers to its probes. Answers to ordinary questions never count here
//              (they still teach J's precedents and the spine's keys).
//   probes     each day up to `perDay` units of not-yet-earned cells are asked as one-unit questions, one per cell, the
//              least-probed cell first (rotation); a unit whose cell's random evidence already rules τ out (Wilson UPPER
//              bound < τ) is not probed.
//
// The arithmetic the defaults imply (z 1.96, strength 10): a cell with a .93 prior earns the right after 90 straight
// right random checks, a .85 one after 116, and every wrong check costs ~30 more — certifying 95% is slow by nature.

import { fnv1a, wilson } from '../../metrics.js';
import { PRIOR_MEAN, PRIOR_STRENGTH, type CellId } from '../judge/cells.js';

export type Relation = 'agree' | 'silent' | 'contradict';

/** The opinion J is related to: the spine's sub-τ label (t1), the floor's rung label (t4). */
export interface Ref {
  label: string | null;
  conf: number;
  rung: string;
}

/** A rung instance's family: 'held:key:AC' → held, 'sender:bot' → sender, 'rule:r1' → rule, 'admin' → admin. */
export const rungFamily = (rung: string): string => /^[^:=]+/.exec(rung)?.[0] ?? rung;

export function relationOf(ref: Ref | null | undefined, label: string): Relation {
  if (!ref || ref.label === null) return 'silent';
  return ref.label === label ? 'agree' : 'contradict';
}

export interface GuardCell {
  key: string; // kind|cell|relation (agree: agree:<rung family>)
  relation: Relation;
  prior: number; // the prior mean of the right to decide
}

const clamp = (x: number): number => Math.min(0.999, Math.max(0.001, x));

/** The guard cell of one J judgment and the prior its right to decide starts from. */
export function guardCell(kind: string, cell: string, label: string, ref: Ref | null | undefined): GuardCell {
  const relation = relationOf(ref, label);
  if (relation === 'agree') return { key: `${kind}|${cell}|agree:${rungFamily(ref!.rung)}`, relation, prior: clamp(ref!.conf) };
  return { key: `${kind}|${cell}|${relation}`, relation, prior: clamp(PRIOR_MEAN[cell as CellId] ?? 0.5) };
}

export interface Evidence {
  right: number;
  n: number;
}

/** Random evidence per guard cell, and how often each cell was probed. Machine rows never reach it (the caller's rule). */
export class GuardCells {
  private readonly ev = new Map<string, Evidence>();
  private readonly probes = new Map<string, number>();

  constructor(
    readonly z = 1.96,
    readonly strength = PRIOR_STRENGTH,
  ) {}

  /** One random check of the cell: an audit of a unit it decided, or the answer to its probe. */
  observe(key: string, right: boolean): void {
    const e = this.ev.get(key) ?? { right: 0, n: 0 };
    e.n++;
    if (right) e.right++;
    this.ev.set(key, e);
  }

  evidence(key: string): Evidence {
    return this.ev.get(key) ?? { right: 0, n: 0 };
  }

  private bound(key: string, prior: number): { lo: number; hi: number } {
    const e = this.evidence(key);
    const s = Math.max(0, this.strength);
    return wilson(s * clamp(prior) + e.right, s + e.n, this.z);
  }

  /** The Wilson lower bound of prior + random evidence: the cell decides when it is ≥ τ. */
  lower(key: string, prior: number): number {
    return this.bound(key, prior).lo;
  }

  /** The Wilson upper bound: below τ, the cell's evidence rules τ out and it is not probed. */
  upper(key: string, prior: number): number {
    return this.bound(key, prior).hi;
  }

  probed(key: string): number {
    return this.probes.get(key) ?? 0;
  }

  noteProbe(key: string): void {
    this.probes.set(key, this.probed(key) + 1);
  }

  /** Cells with random evidence or probes, for the nightly log and the report. */
  table(): { key: string; right: number; n: number; probes: number }[] {
    const keys = new Set([...this.ev.keys(), ...this.probes.keys()]);
    return [...keys].map((key) => ({ key, ...this.evidence(key), probes: this.probed(key) })).sort((a, b) => b.n - a.n || a.key.localeCompare(b.key));
  }
}

export interface ProbeCandidate {
  id: string;
  key: string;
  prior: number;
}

/**
 * Today's probes: at most `perDay` units, one per not-yet-earned cell — the least-probed cell first (ties: the cell with
 * more candidates today, then the key), the unit by a hash of day and id. A unit whose upper bound is below τ is skipped.
 */
export function pickProbes(cands: readonly ProbeCandidate[], cells: GuardCells, perDay: number, day: string, tau: number): ProbeCandidate[] {
  if (perDay <= 0) return [];
  const byCell = new Map<string, ProbeCandidate[]>();
  for (const c of cands) {
    if (cells.upper(c.key, c.prior) < tau) continue;
    const list = byCell.get(c.key);
    if (list) list.push(c);
    else byCell.set(c.key, [c]);
  }
  const h = (id: string): number => fnv1a(`probe|${day}|${id}`);
  return [...byCell]
    .sort(([a, x], [b, y]) => cells.probed(a) - cells.probed(b) || y.length - x.length || a.localeCompare(b))
    .slice(0, Math.floor(perDay))
    .map(([, us]) => [...us].sort((a, b) => h(a.id) - h(b.id) || a.id.localeCompare(b.id))[0]!);
}

/** The confidence an earned decision carries: its lower bound (≥ τ by construction), to 4 places. */
export const earnedConf = (lb: number, tau: number): number => Math.max(tau, Math.floor(lb * 10_000) / 10_000);

/** §5 umbrella-first: J and the spine name two initiatives of ONE client → that client (else null). */
export function sharedClient(spineLabel: string | null | undefined, label: string | null | undefined, clientOf: (label: string) => string | null): string | null {
  if (!spineLabel || !label || spineLabel === label) return null;
  const c = clientOf(spineLabel);
  return c && c === clientOf(label) ? c : null;
}
