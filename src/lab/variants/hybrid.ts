// The hybrid "H" (notes/30-iter3.md): structure decides what it can prove, the model judges the rest, people calibrate
// both. Iterations 1–2 found structure (stage 0 + K/K2) cheap and — once its over-trusted rungs were repaired (K2a) —
// precise, and the model (J) far more ACCURATE on content but only trustworthy once its confidence is earned from answers.
// H composes the two unchanged:
//
//   1. spine     K2a (iteration 2's winner; `spine: 'k2b'` as a constructor parameter or `--opt spine=k2b`) decides the
//                day's units in its own sub-state. Its decisions at conf ≥ τ are FINAL.
//   2. residue   J (judge.ts) on a floor that IS the spine (hybrid/floor.ts): J keeps what the spine decided and judges
//                exactly the rest — two passes, an arbiter, the cell's measured precision as the confidence — in its own
//                sub-state. The card's weak hint is the spine's belief (a held X, a sibling guess, a sub-τ key guess).
//   3. decision  J's calibrated cell at ≥ τ decides; anything else is a question labelled with J's judgment, grouped by the
//                spine's client-day group when it had one, by the client-day when J's passes split inside one client
//                (fragments), else by J's case; guess = J's label, 'confirm'; value = Σ (minutes or 1)·(1 − conf) PLUS the
//                spine's yield (hybrid/merge.ts). The spec's value alone (`--opt hybValue=own`) starves the spine: K2a's
//                trust repair lives on asking its client-day groups (their answers demote an over-trusted rung instance and
//                teach its ctx key), and those rank by K2a's yield, not by (1 − conf). Measured without a model on
//                bench-agency t1-item (replay Q=3, audits .15): 'own' 317 auto at 92.4%, 23 frozen errors; with the yield
//                398 at 98.2%, 7 frozen — K2a's own 411 at 98.3%, 7. `--opt hybGroups=spine` keeps K's key groups.
//   4. nightly   both passes: the spine's (keys, ctx keys, client and rung calibration) and J's (cells, precedents).
//
// Tasks: t1-fragment, t1-item and t4-kind go through 1–4; t2-dedup, t3-identity and t4-addressee are the spine alone
// (K2a's K as is).
//
// THE INVARIANT: machine output is never evidence. Both sub-states see the memory WITHOUT machine rows — whatever the
// run's memory policy or `machineWeight` — so neither the spine's nor J's decisions ever come back as a key, a cell, a
// precedent or a calibration count: the spine's keys, ctx keys and rung instances and J's cells and precedents move on
// human (and seed) rows only. The spine's K+g guess call is off by default (`spineGuess`): J's label is the guess, and the
// guess never decides anything either way.
//
// Sub-state: the run's ctx.state holds one entry, 'hybrid'; the spine and J each get a Map of their own inside it (the
// spine's stage 0, K's tables and K2a's trusted floor in one, J's cells, precedents and the adapter in the other).
//
// A GUARD (`guard`, hybrid-g — hybrid-guarded.ts) takes step 3's "J at ≥ τ decides" over: it sees the day's two opinions
// and J's cells, says which J judgments have EARNED the right to decide, which units to probe and which questions go
// client-day (merge.ts hooks), and folds the day's human rows into its own sub-state (a third Map, created only for it).
// Without one, every line above holds as is.

import type { DayCtx, FragmentUnit, ItemUnit, MemoryRow, Prediction, TaskId, Unit, Variant } from '../types.js';
import { opt } from './index.js';
import { judgeState, makeJudge } from './judge.js';
import { makeK2a } from './keys2a.js';
import { trustedOf, type TenantFacts, type Trusted } from './keys2a/floor.js';
import { makeK2b } from './keys2b.js';
import { TAU } from './keys/spec.js';
import { stage0, type Floor, type Stage0 } from './stage0/index.js';
import { SpineFloor } from './hybrid/floor.js';
import { merge, passesOf, type MergeOpts, type MergeStats } from './hybrid/merge.js';

export type SpineName = 'k2a' | 'k2b';

/** The tasks J judges the spine's residue of; the others are the spine alone. */
export const JUDGED: ReadonlySet<TaskId> = new Set<TaskId>(['t1-fragment', 't1-item', 't4-kind']);
const T1: ReadonlySet<TaskId> = new Set<TaskId>(['t1-fragment', 't1-item']);

const STATE = 'hybrid';
const FLOOR = 'hybrid:floor';

export interface HybridState {
  spine: Map<string, unknown>; // the spine's own ctx.state
  judge: Map<string, unknown>; // J's own ctx.state (the adapter lives in it)
  guard?: Map<string, unknown>; // the guard's own ctx.state (hybrid-g only)
  floor: SpineFloor;
  totals: MergeStats & { units: number; days: number };
}

/** The run's hybrid state (one per variant × task run, like every ctx.state entry). */
export function hybridState(ctx: Pick<DayCtx, 'state'>): HybridState {
  let st = ctx.state.get(STATE) as HybridState | undefined;
  if (!st) {
    const floor = new SpineFloor();
    st = { spine: new Map(), judge: new Map<string, unknown>([[FLOOR, floor]]), floor, totals: { units: 0, days: 0, spine: 0, judge: 0, gated: 0, probed: 0, questions: 0, guessed: 0, umbrella: 0, splitUmbrella: 0, clientAgree: 0 } };
    ctx.state.set(STATE, st);
  }
  return st;
}

/** One day of a judged task as a guard sees it: both opinions, J's cell per unit, the floor's rung label (t4). */
export interface GuardDay {
  task: TaskId;
  ctx: DayCtx; // the guard's sub-context: its own state, the memory without machine rows
  units: Unit[];
  spine: ReadonlyMap<string, Prediction>;
  judge: ReadonlyMap<string, Prediction>;
  cellOf: (id: string) => { kind: string; cell: string } | undefined; // J's cell of a unit it judged today
  floorOf: (u: Unit) => Floor | undefined; // t4-kind: stage 0's own rung label as the spine runs it (else undefined)
  clientOf: (label: string) => string | null; // the client of a label (K2a's scope, else the dataset's umbrella)
  tau: number;
}

/** What may decide besides the spine (hybrid-g). Machine rows never reach it: its nightly sees human rows only. */
export interface HybridGuard {
  day(d: GuardDay): Pick<MergeOpts, 'decide' | 'probes' | 'clientAgree'>;
  merged(preds: readonly Prediction[], d: GuardDay): void; // what the merge made of the day (J's decisions, for audits)
  nightly(task: TaskId, ctx: DayCtx): void;
}

/** Memory as the hybrid's parts may see it: never the loop's own decisions. */
export const withoutMachine = (memory: readonly MemoryRow[]): MemoryRow[] => memory.filter((r) => r.source !== 'machine');

const sub = (ctx: DayCtx, state: Map<string, unknown>): DayCtx => ({ ...ctx, state, memory: withoutMachine(ctx.memory) });

export interface HybridOptions {
  name?: string;
  description?: string;
  spine?: SpineName; // default: `--opt spine=…`, else k2a (iteration 2's winner)
  spineGuess?: boolean; // the spine's own K+g guess call (default off: J's label is the question's guess)
  floor?: (ctx: DayCtx) => Stage0; // stage 0 for the spine (tests inject a fake)
  facts?: (ctx: DayCtx) => TenantFacts; // K2a's registry facts (tests inject their own)
  guard?: HybridGuard; // hybrid-g: who besides the spine may decide (default: J at its own ≥ τ — the hybrid)
}

const fmtPct = (n: number, d: number): string => (d ? `${Math.round((100 * n) / d)}%` : '—');

export function makeHybrid(o: HybridOptions = {}): Variant {
  const name = o.name ?? 'hybrid';
  const inner = o.floor ?? stage0;
  const description =
    o.description ??
    'Hybrid: the K2a spine decides what structure proves (conf ≥ τ final); J judges the residue on the spine as its floor (cells calibrated on human rows only); questions grouped client-day / case with J’s label as the guess; both nightly passes; machine rows never reach either';
  const spines: Record<SpineName, Variant> = {
    k2a: makeK2a({ name: `${name}:spine`, description: 'the hybrid’s K2a spine', guess: o.spineGuess ?? false, floor: inner, ...(o.facts ? { facts: o.facts } : {}) }),
    k2b: makeK2b({ name: `${name}:spine`, floor: inner }),
  };
  const which = (): SpineName => o.spine ?? (opt('spine', 'k2a') === 'k2b' ? 'k2b' : 'k2a');
  const judge = makeJudge((jctx) => {
    const f = jctx.state.get(FLOOR) as SpineFloor | undefined;
    if (!f) throw new Error('hybrid: J ran outside the hybrid (no spine floor in its state)');
    return f;
  }, `${name}:judge`);

  return {
    name,
    description,
    tasks: spines.k2a.tasks,

    async decide(task: TaskId, units: Unit[], ctx: DayCtx): Promise<Prediction[]> {
      const st = hybridState(ctx);
      const spine = spines[which()];
      const sctx = sub(ctx, st.spine);
      const fromSpine = await spine.decide(task, units, sctx);
      if (!JUDGED.has(task)) return fromSpine;

      // The floor as the spine saw it (K2a on t1: the trusted floor — X and its siblings, the check's reason), stage 0 for
      // the rest; both are the spine's own cached instances.
      const raw = inner(sctx);
      const trusted: Trusted | null = which() === 'k2a' && T1.has(task) ? trustedOf(sctx, inner, o.facts) : null;
      st.floor.set(trusted?.floor ?? raw, raw, fromSpine);
      const fromJudge = await judge.decide(task, units, sub(ctx, st.judge));

      const tau = opt('tau', TAU);
      const byId = new Map(units.map((u) => [u.id, u]));
      const weight = (id: string): number => {
        const m = task === 't1-fragment' ? (byId.get(id) as FragmentUnit | undefined)?.minutes : undefined;
        return m && m > 0 ? m : 1;
      };
      // The client a label belongs to: K2a's (company, else umbrella) so J's client-day groups are the spine's; the
      // dataset's umbrella map otherwise. none / unregistered have none.
      const umbrellas = ctx.dataset.labelSpace?.umbrellas ?? {};
      const clientOf = (label: string): string | null => trusted?.scope(label)?.scope ?? umbrellas[label] ?? null;
      const clientSplit =
        task === 't1-fragment'
          ? (j: Prediction): string | null => {
              const ab = passesOf(j);
              if (!ab || ab.a === ab.b) return null;
              const c = clientOf(ab.a);
              return c && c === clientOf(ab.b) ? c : null;
            }
          : undefined;
      const spineOf = new Map(fromSpine.map((p) => [p.id, p]));
      const judgeOf = new Map(fromJudge.map((p) => [p.id, p]));
      let who: Pick<MergeOpts, 'gate' | 'probe' | 'decide' | 'probes' | 'clientAgree'>;
      let gday: GuardDay | null = null;
      if (o.guard) {
        // The guard decides who besides the spine may decide (the hybGate / hybProbe ablations are the hybrid's own).
        const proposals = judgeState({ ...ctx, state: st.judge }, task).proposals;
        gday = { task, ctx: sub(ctx, (st.guard ??= new Map())), units, spine: spineOf, judge: judgeOf, cellOf: (id) => proposals.get(id), floorOf: (u) => (task === 't4-kind' ? raw.kind(u as ItemUnit) : undefined), clientOf, tau };
        who = o.guard.day(gday);
      } else {
        // --opt hybGate=agree (an ablation, not the spec): J may decide only where it names the spine's own sub-τ label.
        const gate = opt('hybGate', 'none') === 'agree' ? (s: Prediction | undefined, j: Prediction): boolean => !!s && s.label !== null && s.label === j.label : undefined;
        // --opt hybProbe=<n> (an ablation): n units a day that J would decide are asked instead, one per J cell (merge.ts).
        const probeN = opt('hybProbe', 0);
        const proposals = probeN > 0 ? judgeState({ ...ctx, state: st.judge }, task).proposals : null;
        const probe = proposals ? { perDay: probeN, cellOf: (id: string): string | null => (proposals.get(id) ? `${proposals.get(id)!.kind}|${proposals.get(id)!.cell}` : null) } : undefined;
        who = { ...(gate ? { gate } : {}), ...(probe ? { probe } : {}) };
      }
      const m = merge(
        units.map((u) => u.id),
        spineOf,
        judgeOf,
        { day: ctx.day, tau, weight, ...(clientSplit ? { clientSplit } : {}), value: opt('hybValue', 'yield') === 'own' ? 'own' : 'yield', groups: opt('hybGroups', 'case') === 'spine' ? 'spine' : 'case', ...who },
      );
      if (o.guard && gday) o.guard.merged(m.preds, gday);
      const t = st.totals;
      t.units += units.length;
      t.days++;
      t.spine += m.stats.spine;
      t.judge += m.stats.judge;
      t.gated += m.stats.gated;
      t.probed += m.stats.probed;
      t.questions += m.stats.questions;
      t.guessed += m.stats.guessed;
      t.umbrella += m.stats.umbrella;
      t.splitUmbrella += m.stats.splitUmbrella;
      t.clientAgree += m.stats.clientAgree;
      ctx.log(
        `${name} ${task} ${ctx.day}: ${units.length} units → spine auto ${m.stats.spine}, J auto ${m.stats.judge}${m.stats.gated ? ` (gated ${m.stats.gated})` : ''}${m.stats.probed ? ` (probation ${m.stats.probed})` : ''}, questions ${m.stats.questions} (J guess ${m.stats.guessed}, client-day ${m.stats.umbrella}${m.stats.splitUmbrella ? `, ${m.stats.splitUmbrella} by J's split` : ''}${m.stats.clientAgree ? `, ${m.stats.clientAgree} by client agreement` : ''}) · run so far: spine ${fmtPct(t.spine, t.units)}, J ${fmtPct(t.judge, t.units)}`,
      );
      return m.preds;
    },

    async nightly(task: TaskId, ctx: DayCtx): Promise<void> {
      const st = hybridState(ctx);
      await spines[which()].nightly?.(task, sub(ctx, st.spine));
      if (JUDGED.has(task)) await judge.nightly!(task, sub(ctx, st.judge));
      if (o.guard && JUDGED.has(task)) o.guard.nightly(task, sub(ctx, (st.guard ??= new Map())));
    },
  };
}

export const hybrid: Variant = makeHybrid();
