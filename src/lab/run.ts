// The bench runner: one variant × one task × one dataset, replayed day by day the way production met the
// stream — a variant only ever sees the day it decides and what it was allowed to remember of earlier days.
//
//   static — every day decided cold: memory is always empty and nobody answers anything. What the pipeline
//            does with no learning at all (and the only fair mode for a variant without memory).
//   replay — after each day the person answers up to `questionsPerDay` of the day's questions (abstentions
//            and labels under the run's threshold; the costliest fragments first, then the least sure) with
//            the gold label. What later days may remember is the `memory` policy:
//              none   — the person's answers only (source 'human'): learning from people alone
//              loop   — the answers plus the pipeline's own auto-decisions (source 'machine', their PREDICTED
//                       label, wrong ones included on purpose: does the loop amplify its own mistakes?)
//              oracle — every gold label of the day (source 'human'): an upper bound on what memory can buy
//            then the variant's nightly pass runs with the day's rows already in (the "dream").
//
// An answered unit counts as resolved by a person, never as auto-decided (score.ts takes it out of the auto
// share). The variant never sees gold: the runner reads it to answer questions and to tally each day, and
// hands the variant only MemoryRows. Every model call goes through a metering proxy, so a day's cost is what
// the variant spent (cached calls included — the cache stores what the call WOULD cost; see llm.ts).
//
// Results land in LAB_DIR/runs/<run>/<dataset>/<variant>/<task>.{predictions.jsonl,result.json}. LAB_DIR
// comes from the environment (default data/lab, gitignored): real datasets and their runs never live in
// the repo.

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { dayOf, goldFor, readJsonl, unitsFor, writeJsonl, type Dataset } from './dataset.js';
import { decidedAt, familyExact, familyMaps, isCorrect, labelMap } from './score.js';
import { fnv1a } from './metrics.js';
import { TASKS, type DayCtx, type FragmentUnit, type GoldTier, type LlmLike, type MemoryRow, type Prediction, type TaskId, type Unit, type Variant } from './types.js';

export type Mode = 'static' | 'replay';
export type MemoryPolicy = 'none' | 'oracle' | 'loop';
export type Population = 'gold' | 'all';

export interface RunOpts {
  mode: Mode;
  memory: MemoryPolicy;
  questionsPerDay?: number; // replay: the person's daily budget in questions (10); a question covers a Prediction.group
  auditShare?: number; // replay: share of that budget spent on random checks of auto-decided units (0)
  threshold?: number; // auto-decided = label !== null && conf >= threshold (default: .95 in replay, 0 in static)
  population?: Population; // 'gold' (default): units with a gold row for the task; t2-dedup is always 'all'
  tiers?: GoldTier[]; // which gold tiers define the population and answer questions (default: all, most trusted wins)
  llm: LlmLike | null;
  runName: string;
  log: (msg: string) => void;
  labDir?: string; // where runs/ goes (default: LAB_DIR from the env, else data/lab)
}

// What a result file keeps of its options (no runner, no logger).
export interface SavedOpts {
  mode: Mode;
  memory: MemoryPolicy;
  questionsPerDay: number;
  auditShare: number;
  threshold: number;
  population: Population;
  tiers: GoldTier[] | null;
  runName: string;
  llm: boolean;
}

export interface DayStat {
  day: string;
  n: number; // population units of the day
  decided: number; // auto-decided (label at/above the threshold, not answered)
  correctDecided: number; // of those, right against gold (units without gold count as not right)
  questions: number; // sent to a person (abstained or under the threshold)
  answered: number; // of those, answered within the budget (replay only) — units, not questions
  asked: number; // questions put to the person (groups answered)
  effort: number; // the person's effort in question units (see the effort model in runTask), audits included
  audited: number; // auto-decided units checked at random (replay with auditShare)
  costUsd: number;
}

export interface RunResult {
  dataset: string; // meta.name
  datasetDir: string; // where it was loaded from (the report reloads it)
  variant: string;
  task: TaskId;
  opts: SavedOpts;
  predictions: Prediction[]; // one per population unit, in day order (a unit the variant skipped = an abstention)
  answered: string[]; // unit ids a person resolved
  audited?: string[]; // auto-decided unit ids a person checked (they stay auto-decided in the score)
  perDay: DayStat[];
  costUsd: number;
  startedAt: string;
  ms: number;
}

export const labDir = (): string => process.env.LAB_DIR || 'data/lab';
const safe = (s: string): string => s.replace(/[^A-Za-z0-9._-]+/g, '_');

export function runDir(runName: string, base = labDir()): string {
  return join(base, 'runs', safe(runName));
}

// Every model call of the run passes through here: what a day cost is what its calls cost.
function metered(llm: LlmLike | null): { llm: LlmLike | null; take: () => number } {
  if (!llm) return { llm: null, take: () => 0 };
  let spent = 0;
  return {
    llm: {
      call: async (c) => {
        const r = await llm.call(c);
        spent += r.costUsd || 0;
        return r;
      },
    },
    take: () => {
      const s = spent;
      spent = 0;
      return s;
    },
  };
}

// One prediction per unit, in the units' order: the first answer per id wins, ids the variant made up are
// dropped, a unit it skipped is an abstention (rung 'missing', so the report shows the variant's gap).
function normalise(raw: Prediction[] | undefined, units: Unit[]): Prediction[] {
  const byId = new Map<string, Prediction>();
  for (const p of raw ?? []) if (p && typeof p.id === 'string' && !byId.has(p.id)) byId.set(p.id, p);
  return units.map((u) => {
    const p = byId.get(u.id);
    if (!p) return { id: u.id, label: null, conf: 0, rung: 'missing' };
    const label = typeof p.label === 'string' ? p.label : null;
    return { ...p, label, conf: Number.isFinite(p.conf) ? p.conf : 0, rung: p.rung || (label === null ? 'abstain' : 'unknown') };
  });
}

function byDay(units: Unit[]): Map<string, Unit[]> {
  const out = new Map<string, Unit[]>();
  for (const u of units) {
    const d = dayOf(u);
    const list = out.get(d);
    if (list) list.push(u);
    else out.set(d, [u]);
  }
  return out;
}

export async function runTask(ds: Dataset, variant: Variant, task: TaskId, opts: RunOpts): Promise<RunResult> {
  if (!variant.tasks.includes(task)) throw new Error(`variant ${variant.name} does not do ${task} (it does ${variant.tasks.join(', ')})`);
  const t0 = Date.now();
  const budget = opts.questionsPerDay ?? 10;
  // τ, the decide/ask cut: a replay asks below .95 by default (design §0); a static run counts every label.
  const thr = opts.threshold ?? (opts.mode === 'replay' ? 0.95 : 0);
  const population: Population = task === 't2-dedup' ? 'all' : (opts.population ?? 'gold');
  const gold = goldFor(ds, task, opts.tiers);
  const all = unitsFor(ds, task);
  const pool = byDay(all);
  const pop = byDay(population === 'all' ? all : all.filter((u) => gold.has(u.id)));
  const unitById = new Map(all.map((u) => [u.id, u]));
  const minutes = (id: string): number => (task === 't1-fragment' ? ((unitById.get(id) as FragmentUnit | undefined)?.minutes ?? 0) : 0);
  const weight = (id: string): number => (task === 't1-fragment' ? ((unitById.get(id) as FragmentUnit | undefined)?.weight ?? 0) : 0);

  const memory: MemoryRow[] = [];
  const state = new Map<string, unknown>();
  const meter = metered(opts.llm);
  const predictions: Prediction[] = [];
  const answered: string[] = [];
  const audited: string[] = [];
  const perDay: DayStat[] = [];
  const dayIds = new Map<string, string[]>();

  for (const day of [...pop.keys()].sort()) {
    const units = pop.get(day)!;
    const ctx: DayCtx = { dataset: ds.meta, dir: ds.dir, day, pool: pool.get(day) ?? units, memory: opts.mode === 'replay' ? memory.slice() : [], state, llm: meter.llm, log: opts.log };
    const got = normalise(await variant.decide(task, units, ctx), units);
    const auto = got.filter((p) => decidedAt(p, thr));
    const questions = got.filter((p) => !decidedAt(p, thr));
    let answeredToday: Prediction[] = [];
    let askedToday = 0;
    let auditedToday: Prediction[] = [];
    let effortToday = 0;
    if (opts.mode === 'replay') {
      // A question is a group (Prediction.group, else the unit): one answer resolves all of it. A person's
      // time goes to what is worth most: the longest fragments first (minutes are what gets billed), then the
      // least sure; the key makes ties reproducible. Part of the budget may go to random audits of auto-decided
      // units — the only unbiased sample of the machine's own precision.
      const groups = new Map<string, Prediction[]>();
      for (const p of questions) {
        const k = p.ask?.group ?? p.group ?? p.id;
        const g = groups.get(k);
        if (g) g.push(p);
        else groups.set(k, [p]);
      }
      const sum = (ps: Prediction[], f: (id: string) => number) => ps.reduce((a, p) => a + f(p.id), 0);
      const minConf = (ps: Prediction[]) => Math.min(...ps.map((p) => p.conf));
      const value = (ps: Prediction[]) => ps.reduce((a, p) => a + (p.ask?.value ?? 0), 0);
      const ranked = [...groups.entries()].sort(
        ([ka, a], [kb, b]) => value(b) - value(a) || sum(b, minutes) - sum(a, minutes) || sum(b, weight) - sum(a, weight) || minConf(a) - minConf(b) || ka.localeCompare(kb),
      );
      // The person's effort, in questions: a group whose members share one gold label is one question; a
      // 'confirm' with the right guess is half of one, a wrong guess one and a half; every further gold label
      // in the group is one more. The budget is filled greedily in this unit (design §5.1 — an assumption).
      const effort = (ps: Prediction[]): number => {
        const labels = new Set(ps.map((p) => gold.get(p.id)?.label).filter((l): l is string => !!l));
        const form = ps[0].ask?.form ?? 'choose';
        const guess = ps[0].ask?.guess ?? null;
        if (form === 'confirm' && guess != null) return (labels.has(guess) ? 0.5 : 1.5) + Math.max(0, labels.size - 1);
        return 1 + Math.max(0, labels.size - 1);
      };
      const audits = Math.min(auto.length, Math.floor(Math.max(0, budget) * (opts.auditShare ?? 0)));
      let left = Math.max(0, budget - audits);
      const asks: [string, Prediction[]][] = [];
      for (const g of ranked) {
        const e = effort(g[1]);
        if (e > left) continue;
        asks.push(g);
        left -= e;
        effortToday += e;
      }
      askedToday = asks.length;
      answeredToday = asks.flatMap(([, ps]) => ps);
      const answerOf = new Map<string, string>();
      for (const [k, ps] of asks) for (const p of ps) answerOf.set(p.id, `${day}:${k}`);
      auditedToday = [...auto].sort((a, b) => fnv1a(`${day}|${a.id}`) - fnv1a(`${day}|${b.id}`)).slice(0, audits);
      effortToday += auditedToday.length;
      const rows: MemoryRow[] = [];
      const said = (p: Prediction) => ({ predicted: p.label ?? p.ask?.guess ?? null, conf: p.conf, rung: p.rung });
      if (opts.memory === 'oracle') {
        for (const u of pool.get(day) ?? units) {
          const g = gold.get(u.id);
          if (g) rows.push({ id: u.id, task, day, label: g.label, source: 'human' });
        }
      } else {
        // An answered unit without gold (population 'all') was resolved, but the bench cannot know the
        // answer: it leaves no memory row rather than an invented one.
        for (const p of answeredToday) {
          const g = gold.get(p.id);
          if (g) rows.push({ id: p.id, task, day, label: g.label, source: 'human', answer: answerOf.get(p.id), ...said(p) });
        }
        for (const p of auditedToday) {
          const g = gold.get(p.id);
          if (g) rows.push({ id: p.id, task, day, label: g.label, source: 'human', audit: true, answer: `${day}:audit:${p.id}`, ...said(p) });
        }
        if (opts.memory === 'loop') for (const p of auto) rows.push({ id: p.id, task, day, label: p.label!, source: 'machine', ...said(p) });
      }
      memory.push(...rows);
      answered.push(...answeredToday.map((p) => p.id));
      audited.push(...auditedToday.map((p) => p.id));
      if (variant.nightly) await variant.nightly(task, { ...ctx, memory: memory.slice() });
    }
    const spent = meter.take();
    const attributed = got.reduce((a, p) => a + (p.costUsd ?? 0), 0);
    predictions.push(...got);
    dayIds.set(day, got.map((p) => p.id));
    perDay.push({ day, n: units.length, decided: auto.length, correctDecided: 0, questions: questions.length, answered: answeredToday.length, asked: askedToday, effort: effortToday, audited: auditedToday.length, costUsd: Math.max(spent, attributed) });
    opts.log(`${variant.name} ${task} ${day}: ${units.length} units, ${auto.length} auto, ${questions.length} questions${opts.mode === 'replay' ? ` (${answeredToday.length} answered)` : ''}${perDay.at(-1)!.costUsd ? `, $${perDay.at(-1)!.costUsd.toFixed(4)}` : ''}`);
  }

  // The daily tally against gold, after the fact: a dedup family is only judgeable once every day is in.
  const done = new Set(answered);
  const right = new Set<string>();
  if (task === 't2-dedup') {
    const maps = familyMaps(predictions, gold, thr, done);
    const byId = new Map(predictions.map((p) => [p.id, p]));
    for (const [id, ok] of familyExact(maps.pred, maps.gold)) if (ok && decidedAt(byId.get(id)!, thr)) right.add(id);
  } else {
    const map = labelMap(ds, task);
    for (const p of predictions) {
      const g = gold.get(p.id);
      if (g && !done.has(p.id) && decidedAt(p, thr) && isCorrect(p.label!, g, map)) right.add(p.id);
    }
  }
  for (const d of perDay) d.correctDecided = (dayIds.get(d.day) ?? []).filter((id) => right.has(id)).length;

  const result: RunResult = {
    dataset: ds.meta.name,
    datasetDir: ds.dir,
    variant: variant.name,
    task,
    opts: { mode: opts.mode, memory: opts.memory, questionsPerDay: budget, auditShare: opts.auditShare ?? 0, threshold: thr, population, tiers: opts.tiers ?? null, runName: opts.runName, llm: !!opts.llm },
    predictions,
    answered,
    audited,
    perDay,
    costUsd: perDay.reduce((a, d) => a + d.costUsd, 0),
    startedAt: new Date(t0).toISOString(),
    ms: Date.now() - t0,
  };
  saveResult(result, opts.labDir);
  return result;
}

// --- persistence ---------------------------------------------------------------------------------------

export function resultDir(r: Pick<RunResult, 'dataset' | 'variant'> & { opts: { runName: string } }, base = labDir()): string {
  return join(runDir(r.opts.runName, base), safe(r.dataset), safe(r.variant));
}

export function saveResult(r: RunResult, base = labDir()): string {
  const dir = resultDir(r, base);
  mkdirSync(dir, { recursive: true });
  writeJsonl(join(dir, `${r.task}.predictions.jsonl`), r.predictions);
  const { predictions, ...rest } = r;
  writeFileSync(join(dir, `${r.task}.result.json`), `${JSON.stringify({ ...rest, predictionCount: predictions.length }, null, 2)}\n`);
  return dir;
}

export function loadResult(resultFile: string): RunResult {
  const r = JSON.parse(readFileSync(resultFile, 'utf8')) as RunResult & { predictionCount?: number };
  const preds = readJsonl<Prediction>(resultFile.replace(/\.result\.json$/, '.predictions.jsonl'));
  delete r.predictionCount;
  return { ...r, predictions: preds };
}

// The run's variant order, so a report compares against the variant that was named first.
export function noteVariants(runName: string, variants: string[], base = labDir()): void {
  const file = join(runDir(runName, base), 'manifest.json');
  const cur = existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as { variants?: string[] }) : {};
  const order = [...(cur.variants ?? [])];
  for (const v of variants) if (!order.includes(v)) order.push(v);
  mkdirSync(runDir(runName, base), { recursive: true });
  writeFileSync(file, `${JSON.stringify({ variants: order, updatedAt: new Date().toISOString() }, null, 2)}\n`);
}

// Every result of a run, ordered dataset → task (TASKS order) → variant (manifest order, else baseline first).
export function loadRun(runName: string, base = labDir()): RunResult[] {
  const root = runDir(runName, base);
  if (!existsSync(root)) throw new Error(`no run ${runName} under ${join(base, 'runs')}`);
  const manifest = join(root, 'manifest.json');
  const order = existsSync(manifest) ? ((JSON.parse(readFileSync(manifest, 'utf8')) as { variants?: string[] }).variants ?? []) : [];
  const out: RunResult[] = [];
  const dirs = (p: string) => readdirSync(p).filter((d) => statSync(join(p, d)).isDirectory()).sort();
  for (const dsName of dirs(root)) {
    for (const v of dirs(join(root, dsName))) {
      const dir = join(root, dsName, v);
      for (const f of readdirSync(dir).filter((x) => x.endsWith('.result.json'))) out.push(loadResult(join(dir, f)));
    }
  }
  const rank = (v: string) => {
    const i = order.indexOf(v);
    return i >= 0 ? i : v === 'baseline' ? -1 : order.length;
  };
  return out.sort((a, b) => a.dataset.localeCompare(b.dataset) || TASKS.indexOf(a.task) - TASKS.indexOf(b.task) || rank(a.variant) - rank(b.variant) || a.variant.localeCompare(b.variant));
}
