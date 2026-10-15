// Bench metrics. Every pipeline variant answers, per unit (an item, a fragment, a participant
// mention), with a label or an abstention plus a confidence. The headline number is the AUTO SHARE
// at a precision floor: the largest share of units the pipeline may decide without a person while
// the decided ones stay at least `floor` correct. A variant that is right 99% of the time on 10% of
// the stream loses to one that is right 96% of the time on 60% — the person answers the rest.
//
// The threshold is chosen on one split (dev) and the share is measured on another (test): picking
// it on the units it is then scored on flatters every variant, the noisier ones most. Gold sets
// are small (hundreds), so precision is reported with a Wilson interval and comparisons between
// variants with a paired bootstrap — a 2-point gap on 300 units is usually noise.

export interface Scored {
  id: string;
  pred: string | null; // null = the variant abstained (goes to a person)
  conf: number; // [0,1]; only the ORDER matters for thresholds, so rungs need not be calibrated
  gold: string;
  weight?: number; // minutes for timelog fragments; 1 by default
}

const w = (s: Scored): number => s.weight ?? 1;

export interface Wilson {
  p: number;
  lo: number;
  hi: number;
}

// Wilson score interval: honest at the extremes (10/10 correct is not "100% ± 0").
export function wilson(k: number, n: number, z = 1.96): Wilson {
  if (n === 0) return { p: 0, lo: 0, hi: 1 };
  const p = k / n;
  const z2 = z * z;
  const den = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / den;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / den;
  return { p, lo: Math.max(0, centre - half), hi: Math.min(1, centre + half) };
}

export interface CurvePoint {
  threshold: number; // decide every unit with conf >= threshold
  decided: number; // units decided
  correct: number;
  coverage: number; // decided / all units (by weight)
  precision: number; // correct / decided (by weight)
}

// Risk–coverage curve: one point per distinct confidence, strongest first. Ties are decided
// together (a threshold cannot split equal confidences), which is why points are per value.
export function riskCoverage(units: Scored[]): CurvePoint[] {
  const total = units.reduce((a, u) => a + w(u), 0);
  const decided = units.filter((u) => u.pred !== null).sort((a, b) => b.conf - a.conf);
  const out: CurvePoint[] = [];
  let dw = 0;
  let cw = 0;
  let nd = 0;
  let nc = 0;
  for (let i = 0; i < decided.length; i++) {
    const u = decided[i];
    dw += w(u);
    nd++;
    if (u.pred === u.gold) {
      cw += w(u);
      nc++;
    }
    const last = i === decided.length - 1 || decided[i + 1].conf !== u.conf;
    if (last) {
      out.push({
        threshold: u.conf,
        decided: nd,
        correct: nc,
        coverage: total ? dw / total : 0,
        precision: dw ? cw / dw : 1,
      });
    }
  }
  return out;
}

export interface Operating {
  threshold: number; // Infinity = decide nothing
  coverage: number;
  precision: number;
  decided: number;
  correct: number;
  ci: Wilson; // over unit counts, not weights
}

const NOTHING: Operating = { threshold: Infinity, coverage: 0, precision: 1, decided: 0, correct: 0, ci: wilson(0, 0) };

// The widest operating point whose precision meets the floor. `lowerBound` asks the Wilson lower
// bound (not the point estimate) to meet it — the conservative choice for a production threshold,
// since it refuses to promise 95% on twenty lucky units.
export function operatingPoint(units: Scored[], floor: number, opts: { lowerBound?: boolean; minDecided?: number } = {}): Operating {
  const pts = riskCoverage(units);
  let best: Operating = NOTHING;
  for (const p of pts) {
    if (p.decided < (opts.minDecided ?? 1)) continue;
    const ci = wilson(p.correct, p.decided);
    const ok = opts.lowerBound ? ci.lo >= floor : p.precision >= floor;
    if (ok && p.coverage >= best.coverage) best = { threshold: p.threshold, coverage: p.coverage, precision: p.precision, decided: p.decided, correct: p.correct, ci };
  }
  return best;
}

// Score `units` at a fixed threshold (chosen elsewhere).
export function atThreshold(units: Scored[], threshold: number): Operating {
  const total = units.reduce((a, u) => a + w(u), 0);
  const dec = units.filter((u) => u.pred !== null && u.conf >= threshold);
  const dw = dec.reduce((a, u) => a + w(u), 0);
  const ok = dec.filter((u) => u.pred === u.gold);
  const cw = ok.reduce((a, u) => a + w(u), 0);
  return {
    threshold,
    coverage: total ? dw / total : 0,
    precision: dw ? cw / dw : 1,
    decided: dec.length,
    correct: ok.length,
    ci: wilson(ok.length, dec.length),
  };
}

export interface AutoShare {
  floor: number;
  dev: Operating; // where the threshold was chosen
  test: Operating; // the reported number
  oracle: Operating; // best possible on test (threshold peeking) — an upper bound, never the headline
  accuracyAll: number; // plain accuracy over every unit (abstentions count as wrong)
}

// The headline: calibrate on dev, report on test.
export function autoShare(dev: Scored[], test: Scored[], floor = 0.95, opts: { lowerBound?: boolean } = {}): AutoShare {
  const d = operatingPoint(dev, floor, opts);
  const total = test.reduce((a, u) => a + w(u), 0);
  const right = test.filter((u) => u.pred !== null && u.pred === u.gold).reduce((a, u) => a + w(u), 0);
  return {
    floor,
    dev: d,
    test: atThreshold(test, d.threshold),
    oracle: operatingPoint(test, floor),
    accuracyAll: total ? right / total : 0,
  };
}

// Deterministic split by id hash: the same unit lands in the same split across variants and runs.
export function splitOf(id: string, devShare = 0.5): 'dev' | 'test' {
  return (fnv1a(id) % 1000) / 1000 < devShare ? 'dev' : 'test';
}

export function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// Seeded PRNG (mulberry32): bootstrap resamples must be reproducible run to run.
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface Paired {
  delta: number; // metric(b) - metric(a) on the full set
  lo: number; // 2.5th percentile of the bootstrap deltas
  hi: number; // 97.5th
  pBetter: number; // share of resamples where b beats a
}

// Paired bootstrap over units: both variants are scored on the SAME resample, so the per-unit
// correlation (both fail on the same hard units) is kept and the interval is honest.
export function pairedBootstrap(
  a: Scored[],
  b: Scored[],
  metric: (units: Scored[]) => number,
  iters = 1000,
  seed = 7,
): Paired {
  const byId = new Map(b.map((u) => [u.id, u]));
  const pairs = a.filter((u) => byId.has(u.id)).map((u) => [u, byId.get(u.id)!] as const);
  const r = rng(seed);
  const deltas: number[] = [];
  for (let i = 0; i < iters; i++) {
    const sa: Scored[] = [];
    const sb: Scored[] = [];
    for (let j = 0; j < pairs.length; j++) {
      const p = pairs[Math.floor(r() * pairs.length)];
      sa.push(p[0]);
      sb.push(p[1]);
    }
    deltas.push(metric(sb) - metric(sa));
  }
  deltas.sort((x, y) => x - y);
  const q = (f: number) => deltas[Math.min(deltas.length - 1, Math.floor(f * deltas.length))] ?? 0;
  return {
    delta: metric(pairs.map((p) => p[1])) - metric(pairs.map((p) => p[0])),
    lo: q(0.025),
    hi: q(0.975),
    pBetter: deltas.filter((d) => d > 0).length / Math.max(1, deltas.length),
  };
}

// --- clusters (dedup families, identity groups) ---------------------------------------------------
// A clustering is a map unit → cluster id. Pairwise precision is the share of predicted same-cluster
// pairs that are truly together: a false merge (two people glued into one, two different invoices
// collapsed) is the expensive error, so precision is the floor-checked side here too.

export interface PairScores {
  precision: number;
  recall: number;
  f1: number;
  predPairs: number;
  goldPairs: number;
  truePairs: number;
}

function pairsOf(assign: Map<string, string>): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  for (const [unit, c] of assign) {
    const g = groups.get(c);
    if (g) g.push(unit);
    else groups.set(c, [unit]);
  }
  return groups;
}

const choose2 = (n: number): number => (n * (n - 1)) / 2;

export function pairwise(pred: Map<string, string>, gold: Map<string, string>): PairScores {
  const units = [...pred.keys()].filter((u) => gold.has(u));
  const p = new Map(units.map((u) => [u, pred.get(u)!]));
  const g = new Map(units.map((u) => [u, gold.get(u)!]));
  let predPairs = 0;
  let truePairs = 0;
  for (const members of pairsOf(p).values()) {
    predPairs += choose2(members.length);
    const byGold = new Map<string, number>();
    for (const m of members) byGold.set(g.get(m)!, (byGold.get(g.get(m)!) ?? 0) + 1);
    for (const n of byGold.values()) truePairs += choose2(n);
  }
  let goldPairs = 0;
  for (const members of pairsOf(g).values()) goldPairs += choose2(members.length);
  const precision = predPairs ? truePairs / predPairs : 1;
  const recall = goldPairs ? truePairs / goldPairs : 1;
  return { precision, recall, f1: precision + recall ? (2 * precision * recall) / (precision + recall) : 0, predPairs, goldPairs, truePairs };
}

// B-cubed: per-unit precision/recall averaged over units — unlike pairwise it does not let one huge
// cluster (a notification family of 400) drown every small one.
export function bcubed(pred: Map<string, string>, gold: Map<string, string>): { precision: number; recall: number; f1: number } {
  const units = [...pred.keys()].filter((u) => gold.has(u));
  if (!units.length) return { precision: 1, recall: 1, f1: 1 };
  const pg = pairsOf(new Map(units.map((u) => [u, pred.get(u)!])));
  const gg = pairsOf(new Map(units.map((u) => [u, gold.get(u)!])));
  let P = 0;
  let R = 0;
  for (const u of units) {
    const pm = pg.get(pred.get(u)!)!;
    const gm = new Set(gg.get(gold.get(u)!)!);
    const both = pm.filter((m) => gm.has(m)).length;
    P += both / pm.length;
    R += both / gm.size;
  }
  P /= units.length;
  R /= units.length;
  return { precision: P, recall: R, f1: P + R ? (2 * P * R) / (P + R) : 0 };
}

// --- sets (addressees) ------------------------------------------------------------------------------

export function jaccard(a: Iterable<string>, b: Iterable<string>): number {
  const A = new Set(a);
  const B = new Set(b);
  if (!A.size && !B.size) return 1;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}

// Canonical key for a set label, so set-valued predictions can go through the Scored machinery
// (exact-set match = correct).
export const setKey = (xs: Iterable<string>): string => [...new Set(xs)].sort().join('|');

// --- per-class --------------------------------------------------------------------------------------

export interface ClassRow {
  label: string;
  support: number;
  predicted: number;
  correct: number;
  precision: number;
  recall: number;
  f1: number;
}

// Per-class precision/recall over DECIDED units (abstentions are neither right nor wrong here; the
// auto share already charges for them).
export function perClass(units: Scored[]): ClassRow[] {
  const labels = new Set<string>();
  for (const u of units) {
    labels.add(u.gold);
    if (u.pred !== null) labels.add(u.pred);
  }
  const rows: ClassRow[] = [];
  for (const label of [...labels].sort()) {
    const support = units.filter((u) => u.gold === label).length;
    const predicted = units.filter((u) => u.pred === label).length;
    const correct = units.filter((u) => u.pred === label && u.gold === label).length;
    const precision = predicted ? correct / predicted : 1;
    const recall = support ? correct / support : 1;
    rows.push({ label, support, predicted, correct, precision, recall, f1: precision + recall ? (2 * precision * recall) / (precision + recall) : 0 });
  }
  return rows;
}

export function macroF1(units: Scored[]): number {
  const rows = perClass(units).filter((r) => r.support > 0);
  return rows.length ? rows.reduce((a, r) => a + r.f1, 0) / rows.length : 0;
}
