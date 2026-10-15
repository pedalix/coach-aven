// Scoring one bench run against the dataset's gold. Pure: a RunResult and the gold in, a TaskScore out.
// The report and the CLI table are views of it, and the replay's per-day tally (run.ts) uses the same
// notion of "correct" (isCorrect / familyExact), so the two can never disagree.
//
// One row per unit that has gold. Abstentions stay in — they are exactly what the auto share charges
// for. Units a person resolved during a replay are taken OUT of the auto machinery (a person's answer is
// not an automatic decision) but counted, so a variant cannot buy coverage with questions unnoticed.
// Correct = the primary gold label or one of its alts; set-valued addressees compare as setKeys; at
// umbrella level both sides of a t1 label map to their billing frame first (a P-code mix-up inside one
// client is cheap, a wrong client is not — the two levels tell those errors apart).
//
// t2-dedup is a clustering, not a labelling: family ids are arbitrary, so it is scored with pairwise and
// B-cubed (metrics.ts), compression, and the one safety number that matters before anything is folded
// away — no human message may land in a family with a different item.

import { join } from 'node:path';
import { dayOf, goldFor, readJsonl, unitsFor, type Dataset } from './dataset.js';
import { autoShare, bcubed, jaccard, macroF1, pairwise, perClass, setKey, wilson, type AutoShare, type ClassRow, type PairScores, type Scored } from './metrics.js';
import { splitOfUnit } from './cases.js';
import { NONE, type FragmentUnit, type GoldRow, type GoldTier, type ItemUnit, type Prediction, type TaskId, type Unit } from './types.js';
import type { RunResult } from './run.js';

export type Level = 'initiative' | 'umbrella';

export interface ScoreOpts {
  tiers?: GoldTier[]; // score against these gold tiers only (default: every tier, most trusted wins per unit)
  level?: Level; // t1 only: compare initiatives or their umbrellas
  floor?: number; // the precision floor of the headline (0.95)
}

export interface RungRow {
  rung: string;
  n: number; // scored units this rung answered (abstentions included)
  decided: number;
  correct: number;
}

export interface Confusion {
  gold: string;
  pred: string;
  n: number;
}

export interface ClusterScore {
  units: number; // units with a gold family (answered ones excluded)
  pairwise: PairScores;
  bcubed: { precision: number; recall: number; f1: number };
  families: number; // distinct predicted families over the whole population (gold or not)
  compression: number; // families / population units: 1 = nothing folded, lower = more folded
  humanUnits: number; // gold units whose item is not a bot
  humanSafety: number; // share of those NOT put in a family with an item of another gold family
  exact: number; // share of gold units whose predicted family is exactly their gold family
  pairs?: { n: number; predSame: number; goldSame: number; precision: number; recall: number }; // gold/t2-pairs.jsonl
}

// Replay only: what the loop did over the window (design §6.3). 'auto' here is the RUN's cut (τ), not the dev
// operating point — it is what the pipeline actually let through day by day.
export interface LoopScore {
  autoDecided: number; // auto-decided units with gold (not answered by a person)
  autoCorrect: number;
  precision: number;
  frozenErrors: number; // wrong auto-decided units no audit caught — pinned after a day in production
  frozenMinutes: number; // their minutes (t1-fragment)
  audited: number; // auto-decided units checked at random
  auditCorrect: number;
  auditPrecision: { p: number; lo: number; hi: number }; // what the audits would tell Owen about precision
  effortPerDay: number; // the person's effort in question units per day (audits included)
  weeks: { week: string; n: number; auto: number; autoShare: number; precision: number; effort: number }[];
}

export interface TaskScore {
  dataset: string;
  variant: string;
  task: TaskId;
  mode: 'static' | 'replay';
  memory: string;
  level: Level;
  tiers: GoldTier[] | null;
  floor: number;
  population: number; // units the run decided on
  gold: number; // of those, units with a gold row (in `tiers`)
  answered: number; // of those, resolved by a person during the replay — excluded from everything below
  n: number; // scored units = gold − answered
  split: { dev: number; test: number };
  auto: AutoShare; // the headline: threshold chosen on dev (point precision ≥ floor), measured on test
  autoConservative: AutoShare; // same, but the dev threshold must hold the floor at the Wilson LOWER bound
  autoMinutes?: AutoShare; // t1-fragment: the same weighted by minutes (what the timelog actually bills)
  accuracy: number; // every scored unit (dev + test), abstention = wrong
  rungs: RungRow[];
  confusions: Confusion[]; // decided-but-wrong, gold → pred, most frequent first (all of them; the report shows 10)
  perClass?: ClassRow[]; // t4-kind
  macroF1?: number; // t4-kind
  jaccard?: number; // t4-addressee: mean set overlap over decided units
  cluster?: ClusterScore; // t2-dedup
  costUsd: number;
  costPerUnit: number; // per population unit
  costPerAuto: number | null; // per unit auto-decided at the dev operating point (null: it decides nothing)
  questions: number; // units the run sent to a person (abstained or under the run's threshold)
  days: number;
  questionsPerDay: number;
  answeredPerDay: number;
  loop?: LoopScore;
  units: Scored[]; // per-unit rows for the report's paired bootstrap: ids and labels only, never text
}

const T1: ReadonlySet<TaskId> = new Set<TaskId>(['t1-fragment', 't1-item']);

const setOf = (label: string): string[] => (label === NONE ? [] : label.split('|').map((x) => x.trim()).filter(Boolean));

// The canonical form a label is compared in. Addressee sets are re-keyed so a producer that did not sort
// its ids is not marked wrong for the order; an empty set is 'none'.
export function labelMap(ds: Dataset, task: TaskId, level: Level = 'initiative'): (label: string) => string {
  if (task === 't4-addressee') return (l) => setKey(setOf(l)) || NONE;
  if (level === 'umbrella' && T1.has(task)) {
    const up = ds.meta.labelSpace?.umbrellas ?? {};
    return (l) => up[l] ?? l;
  }
  return (l) => l;
}

export function isCorrect(pred: string, gold: GoldRow, map: (label: string) => string = (l) => l): boolean {
  const p = map(pred);
  return p === map(gold.label) || (gold.alts ?? []).some((a) => map(a) === p);
}

// Auto-decided by the run's own rule: a label at or above the run's threshold. Everything else was a
// question to a person (answered or not), whatever its label says.
export const decidedAt = (p: Prediction, threshold: number): boolean => p.label !== null && p.conf >= threshold;

// t2: unit → predicted family and unit → gold family. An undecided unit stands alone under its own id —
// which also lets a unit that names it ("I repeat x") join it, as the label says.
export function familyMaps(preds: readonly Prediction[], gold: ReadonlyMap<string, GoldRow>, threshold: number, skip: ReadonlySet<string> = new Set()): { pred: Map<string, string>; gold: Map<string, string> } {
  const pred = new Map<string, string>();
  const fam = new Map<string, string>();
  for (const p of preds) {
    if (skip.has(p.id)) continue;
    pred.set(p.id, decidedAt(p, threshold) ? p.label! : p.id);
    const g = gold.get(p.id);
    if (g) fam.set(p.id, g.label);
  }
  return { pred, gold: fam };
}

const groups = (ids: readonly string[], key: (id: string) => string): Map<string, string[]> => {
  const out = new Map<string, string[]>();
  for (const id of ids) {
    const k = key(id);
    const g = out.get(k);
    if (g) g.push(id);
    else out.set(k, [id]);
  }
  return out;
};

// Per unit: is its predicted family — seen through the units that have gold — exactly its gold family?
// Strict on purpose (a false merge AND a missed one both fail it): the per-unit correctness the paired
// bootstrap and the replay's daily tally need for a clustering.
export function familyExact(pred: ReadonlyMap<string, string>, gold: ReadonlyMap<string, string>): Map<string, boolean> {
  const ids = [...pred.keys()].filter((id) => gold.has(id));
  const byPred = groups(ids, (id) => pred.get(id)!);
  const byGold = groups(ids, (id) => gold.get(id)!);
  const out = new Map<string, boolean>();
  for (const id of ids) {
    const mine = byPred.get(pred.get(id)!)!;
    out.set(id, mine.length === byGold.get(gold.get(id)!)!.length && mine.every((m) => gold.get(m) === gold.get(id)));
  }
  return out;
}

function clusterScore(ds: Dataset, result: RunResult, gold: ReadonlyMap<string, GoldRow>, answered: ReadonlySet<string>, tiers: GoldTier[] | undefined): { score: ClusterScore; exact: Map<string, boolean> } {
  const thr = result.opts.threshold ?? 0;
  const maps = familyMaps(result.predictions, gold, thr, answered);
  const exact = familyExact(maps.pred, maps.gold);
  const items = new Map(unitsFor(ds, 't2-dedup').map((u) => [u.id, u as ItemUnit]));
  const goldIds = [...maps.pred.keys()].filter((id) => maps.gold.has(id));
  const byPred = groups(goldIds, (id) => maps.pred.get(id)!);
  const human = goldIds.filter((id) => items.get(id)?.isBot === false);
  const safe = human.filter((id) => byPred.get(maps.pred.get(id)!)!.every((m) => maps.gold.get(m) === maps.gold.get(id)));
  const families = new Set(maps.pred.values()).size;
  const score: ClusterScore = {
    units: goldIds.length,
    pairwise: pairwise(maps.pred, maps.gold),
    bcubed: bcubed(maps.pred, maps.gold),
    families,
    compression: maps.pred.size ? families / maps.pred.size : 1,
    humanUnits: human.length,
    humanSafety: human.length ? safe.length / human.length : 1,
    exact: goldIds.length ? goldIds.filter((id) => exact.get(id)).length / goldIds.length : 0,
  };
  // Hand-checked pairs from the real stores (no full clustering exists there): is "same predicted family"
  // what the checker said?
  const pairRows = readJsonl<{ a: string; b: string; same: boolean; tier?: GoldTier }>(join(ds.dir, 'gold', 't2-pairs.jsonl')).filter(
    (r) => maps.pred.has(r.a) && maps.pred.has(r.b) && (!tiers || !r.tier || tiers.includes(r.tier)),
  );
  if (pairRows.length) {
    const predSame = pairRows.filter((r) => maps.pred.get(r.a) === maps.pred.get(r.b));
    const goldSame = pairRows.filter((r) => r.same);
    const both = predSame.filter((r) => r.same).length;
    score.pairs = { n: pairRows.length, predSame: predSame.length, goldSame: goldSame.length, precision: predSame.length ? both / predSame.length : 1, recall: goldSame.length ? both / goldSame.length : 1 };
  }
  return { score, exact };
}

export function scoreTask(ds: Dataset, result: RunResult, opts: ScoreOpts = {}): TaskScore {
  const task = result.task;
  const floor = opts.floor ?? 0.95;
  const level = opts.level ?? 'initiative';
  const map = labelMap(ds, task, level);
  const gold = goldFor(ds, task, opts.tiers);
  const thr = result.opts.threshold ?? 0;
  const answered = new Set(result.answered);
  const units = new Map(unitsFor(ds, task).map((u) => [u.id, u]));
  const t2 = task === 't2-dedup' ? clusterScore(ds, result, gold, answered, opts.tiers) : undefined;

  const rows: (Scored & { rung: string; minutes: number; correct: boolean; split: 'dev' | 'test' })[] = [];
  let withGold = 0;
  for (const p of result.predictions) {
    const g = gold.get(p.id);
    if (!g) continue;
    withGold++;
    if (answered.has(p.id)) continue;
    const decided = decidedAt(p, thr);
    const pred = decided ? (t2 ? p.label! : map(p.label!)) : null;
    const correct = decided && (t2 ? !!t2.exact.get(p.id) : isCorrect(p.label!, g, map));
    const goldLabel = t2 ? g.label : map(g.label);
    // metrics.ts counts `pred === gold` as correct: an alt match takes the predicted label as its gold,
    // and a wrong family that happens to share the gold family's id must not pass as right.
    const scoredGold = correct ? pred! : goldLabel === pred ? `≠${goldLabel}` : goldLabel;
    const minutes = (units.get(p.id) as FragmentUnit | undefined)?.minutes ?? 0;
    // The split goes by case (cases.ts): the topics of one call never straddle dev and test.
    const split = splitOfUnit(task, units.get(p.id), p.id);
    rows.push({ id: p.id, pred, conf: p.conf, gold: scoredGold, weight: 1, rung: p.rung || 'abstain', minutes, correct, split });
  }

  const scored: Scored[] = rows.map(({ id, pred, conf, gold: g, split }) => ({ id, pred, conf, gold: g, weight: 1, split }));
  const dev = scored.filter((u) => u.split === 'dev');
  const test = scored.filter((u) => u.split === 'test');
  const auto = autoShare(dev, test, floor);
  const autoConservative = autoShare(dev, test, floor, { lowerBound: true });
  let autoMinutes: AutoShare | undefined;
  if (task === 't1-fragment') {
    const byMinutes = rows.map(({ id, pred, conf, gold: g, minutes, split }) => ({ id, pred, conf, gold: g, weight: minutes, split }));
    autoMinutes = autoShare(
      byMinutes.filter((u) => u.split === 'dev'),
      byMinutes.filter((u) => u.split === 'test'),
      floor,
    );
  }

  const rungMap = new Map<string, RungRow>();
  for (const r of rows) {
    const row = rungMap.get(r.rung) ?? { rung: r.rung, n: 0, decided: 0, correct: 0 };
    row.n++;
    if (r.pred !== null) row.decided++;
    if (r.correct) row.correct++;
    rungMap.set(r.rung, row);
  }
  const rungs = [...rungMap.values()].sort((a, b) => b.n - a.n || a.rung.localeCompare(b.rung));

  const conf = new Map<string, Confusion>();
  if (!t2) {
    for (const r of rows) {
      if (r.pred === null || r.correct) continue;
      const k = `${r.gold}\u0000${r.pred}`;
      const c = conf.get(k) ?? { gold: r.gold, pred: r.pred, n: 0 };
      c.n++;
      conf.set(k, c);
    }
  }
  const confusions = [...conf.values()].sort((a, b) => b.n - a.n || a.gold.localeCompare(b.gold) || a.pred.localeCompare(b.pred));

  let jac: number | undefined;
  if (task === 't4-addressee') {
    const decided = rows.filter((r) => r.pred !== null);
    // Against the primary gold set; an alt match is a match.
    jac = decided.length ? decided.reduce((a, r) => a + (r.correct ? 1 : jaccard(setOf(r.pred!), setOf(r.gold))), 0) / decided.length : undefined;
  }

  const opThr = Math.max(thr, auto.dev.threshold);
  const autoN = result.predictions.filter((p) => !answered.has(p.id) && decidedAt(p, opThr)).length;
  const questions = result.perDay.reduce((a, d) => a + d.questions, 0);
  const answeredN = result.perDay.reduce((a, d) => a + d.answered, 0);
  const days = result.perDay.length;
  return {
    dataset: result.dataset,
    variant: result.variant,
    task,
    mode: result.opts.mode,
    memory: result.opts.memory,
    level,
    tiers: opts.tiers ?? null,
    floor,
    population: result.predictions.length,
    gold: withGold,
    answered: withGold - rows.length,
    n: rows.length,
    split: { dev: dev.length, test: test.length },
    auto,
    autoConservative,
    ...(autoMinutes ? { autoMinutes } : {}),
    accuracy: rows.length ? rows.filter((r) => r.correct).length / rows.length : 0,
    rungs,
    confusions,
    ...(task === 't4-kind' ? { perClass: perClass(scored), macroF1: macroF1(scored) } : {}),
    ...(jac !== undefined ? { jaccard: jac } : {}),
    ...(t2 ? { cluster: t2.score } : {}),
    costUsd: result.costUsd,
    costPerUnit: result.costUsd / Math.max(1, result.predictions.length),
    costPerAuto: autoN ? result.costUsd / autoN : null,
    questions,
    days,
    questionsPerDay: days ? questions / days : 0,
    answeredPerDay: days ? answeredN / days : 0,
    ...(result.opts.mode === 'replay' ? { loop: loopScore(result, gold, map, units, thr, t2?.exact) } : {}),
    units: scored,
  };
}

// The loop's own ledger over the replay: what was let through at τ, what was wrong and stayed wrong (frozen),
// and what the random audits would have reported — the only precision estimate production can actually have.
function loopScore(
  result: RunResult,
  gold: ReadonlyMap<string, GoldRow>,
  map: (label: string) => string,
  units: ReadonlyMap<string, Unit>,
  thr: number,
  exact?: ReadonlyMap<string, boolean>,
): LoopScore {
  const answered = new Set(result.answered);
  const audited = new Set(result.audited ?? []);
  const dayOfId = new Map<string, string>();
  for (const u of units.values()) dayOfId.set(u.id, dayOf(u));
  const ok = (p: Prediction): boolean => {
    const g = gold.get(p.id);
    if (!g || p.label === null) return false;
    return exact ? !!exact.get(p.id) : isCorrect(p.label, g, map);
  };
  const auto = result.predictions.filter((p) => gold.has(p.id) && !answered.has(p.id) && decidedAt(p, thr));
  const right = auto.filter(ok);
  const wrong = auto.filter((p) => !ok(p) && !audited.has(p.id));
  const aud = auto.filter((p) => audited.has(p.id));
  const audRight = aud.filter(ok).length;
  const mins = (id: string) => (units.get(id) as FragmentUnit | undefined)?.minutes ?? 0;
  // ISO-ish week buckets by the Monday of each day (UTC arithmetic on local day strings).
  const weekOf = (day: string): string => {
    const t = Date.parse(`${day}T00:00:00Z`);
    if (!Number.isFinite(t)) return day; // not a calendar day (hand-made fixtures): its own bucket
    const dow = (new Date(t).getUTCDay() + 6) % 7;
    return new Date(t - dow * 86_400_000).toISOString().slice(0, 10);
  };
  const weeks = new Map<string, { n: number; auto: number; right: number; effort: number }>();
  for (const p of result.predictions) {
    if (!gold.has(p.id)) continue;
    const w = weekOf(dayOfId.get(p.id) ?? '1970-01-01');
    const row = weeks.get(w) ?? { n: 0, auto: 0, right: 0, effort: 0 };
    row.n++;
    if (!answered.has(p.id) && decidedAt(p, thr)) {
      row.auto++;
      if (ok(p)) row.right++;
    }
    weeks.set(w, row);
  }
  for (const d of result.perDay) {
    const row = weeks.get(weekOf(d.day));
    if (row) row.effort += d.effort ?? 0;
  }
  const days = result.perDay.length || 1;
  return {
    autoDecided: auto.length,
    autoCorrect: right.length,
    precision: auto.length ? right.length / auto.length : 1,
    frozenErrors: wrong.length,
    frozenMinutes: wrong.reduce((a, p) => a + mins(p.id), 0),
    audited: aud.length,
    auditCorrect: audRight,
    auditPrecision: wilson(audRight, aud.length),
    effortPerDay: result.perDay.reduce((a, d) => a + (d.effort ?? 0), 0) / days,
    weeks: [...weeks.entries()].sort().map(([week, r]) => ({ week, n: r.n, auto: r.auto, autoShare: r.n ? r.auto / r.n : 0, precision: r.auto ? r.right / r.auto : 1, effort: r.effort })),
  };
}
