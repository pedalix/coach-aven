// hybrid-g — the GUARDED hybrid (iteration 3b). The hybrid (hybrid.ts) unchanged — the K2a spine decides what structure
// proves, J judges the residue on the spine as its floor, questions carry J's label — with one rule between J and the
// right to decide: a model's decision must be EARNED on representative evidence (hybrid/guard.ts).
//
//   1. cells     J's cell (kind × agreement/cite) × its relation to the spine: agree (J names the spine's own sub-τ label;
//                on t4 the floor's rung label; kept per family of that rung), silent (no such label), contradict.
//   2. the right a cell decides only when the Wilson lower bound of its prior + its RANDOM evidence is ≥ τ. Random
//                evidence = audits of units it decided + answers to its probes. Ordinary answers (asked because the
//                pipeline was unsure) never count for the right — they still teach J's cells and precedents (J's own
//                confidence, i.e. the question's value) and the spine's keys. Until then J's label is the question's
//                guess, 'confirm': a right confirm costs half a question. An earned decision carries its lower bound.
//   3. probes    each day up to P units (--opt hybProbe, default 1) of not-yet-earned cells are asked as one-unit
//                questions at the top of the queue, one per cell, the least-probed cell first; a cell whose random
//                evidence rules τ out (upper bound < τ) is not probed.
//   4. priors    agree: the spine rung's calibrated precision on the unit (the spine already measured itself); silent and
//                contradict: J's prior means. Strength 10 (--opt hybPriorN), like J's own cells; z = 1.96 (--opt hybZ),
//                the bench's Wilson. A wrong audit can take an earned right back the next day.
//   5. questions J and the spine on one client but two initiatives → that client × day (merge.ts clientAgree), with
//                J's initiative the unit's guess.
//   6. machine rows are never evidence: the guard's nightly reads human rows only (audits, probe answers), like every part
//                of the hybrid.
//
// Everything else — tasks, spine, J, value, groups, nightly passes — is the hybrid's. The hybrid's own ablations stay off
// here: hybGate is ignored, and `--opt hybProbe` is the guard's P, not the hybrid's probation of J's decisions.

import type { DayCtx, Prediction, TaskId, Variant } from '../types.js';
import { opt } from './index.js';
import { makeHybrid, type GuardDay, type HybridGuard, type HybridOptions } from './hybrid.js';
import { earnedConf, GuardCells, guardCell, pickProbes, sharedClient, type GuardCell, type ProbeCandidate, type Ref } from './hybrid/guard.js';
import { PRIOR_STRENGTH } from './judge/cells.js';
import type { Floor } from './stage0/index.js';

const T1: ReadonlySet<TaskId> = new Set<TaskId>(['t1-fragment', 't1-item']);

/** A unit J judged today, as the guard sees it. */
export interface Judged extends GuardCell {
  label: string;
  lb: number;
  earned: boolean;
}

export interface GuardState {
  cells: GuardCells;
  today: Map<string, Judged>; // today's J judgments
  decided: Map<string, { key: string; label: string }>; // units J decided: an audit of one is a random check of its cell
  probed: Map<string, { key: string; label: string; day: string }>; // units asked as probes
  seen: Set<string>; // memory rows already folded
  totals: { decided: number; probes: number; probeAnswers: number; probeRight: number; audits: number; auditRight: number };
}

export interface GuardOptions {
  z?: number; // the Wilson bound's z (default --opt hybZ, else 1.96)
  priorN?: number; // the prior's strength in pseudo-observations (default --opt hybPriorN, else J's 10)
  probes?: number; // probes a day (default --opt hybProbe, else 1)
}

/** The run's guard state for one task (one per variant × task run, inside the hybrid's state). */
export function guardState(ctx: Pick<DayCtx, 'state'>, task: TaskId, o: GuardOptions = {}): GuardState {
  const k = `guard:${task}`;
  let st = ctx.state.get(k) as GuardState | undefined;
  if (!st) {
    st = {
      cells: new GuardCells(o.z ?? opt('hybZ', 1.96), o.priorN ?? opt('hybPriorN', PRIOR_STRENGTH)),
      today: new Map(),
      decided: new Map(),
      probed: new Map(),
      seen: new Set(),
      totals: { decided: 0, probes: 0, probeAnswers: 0, probeRight: 0, audits: 0, auditRight: 0 },
    };
    ctx.state.set(k, st);
  }
  return st;
}

const refOf = (x: Pick<Floor, 'label' | 'conf' | 'rung'> | Prediction | undefined): Ref | null => (x && x.label !== null ? { label: x.label, conf: x.conf, rung: x.rung } : null);
const f3 = (x: number): string => x.toFixed(3);

export function makeGuard(o: GuardOptions = {}): HybridGuard {
  return {
    day(d: GuardDay) {
      const gs = guardState(d.ctx, d.task, o);
      gs.today = new Map();
      const cands: ProbeCandidate[] = [];
      const rel = { agree: 0, silent: 0, contradict: 0 };
      for (const u of d.units) {
        const s = d.spine.get(u.id);
        const j = d.judge.get(u.id);
        if (!j || j.label === null || (s && s.label !== null && s.conf >= d.tau)) continue; // nothing of J's to guard
        const c = d.cellOf(u.id);
        if (!c) continue; // J kept a floor decision or judged nothing: no cell, no right
        // t1: the spine's own sub-τ label; t4: the floor's rung label (stage 0's sender / cue rung).
        const ref = d.task === 't4-kind' ? refOf(d.floorOf(u)) : refOf(s);
        const gc = guardCell(c.kind, c.cell, j.label, ref);
        const lb = gs.cells.lower(gc.key, gc.prior);
        const judged: Judged = { ...gc, label: j.label, lb, earned: lb >= d.tau };
        gs.today.set(u.id, judged);
        rel[gc.relation]++;
        if (!judged.earned) cands.push({ id: u.id, key: gc.key, prior: gc.prior });
      }
      const perDay = o.probes ?? opt('hybProbe', 1);
      const probes = pickProbes(cands, gs.cells, perDay, d.ctx.day, d.tau);
      for (const p of probes) {
        gs.cells.noteProbe(p.key);
        gs.probed.set(p.id, { key: p.key, label: gs.today.get(p.id)!.label, day: d.ctx.day });
        gs.totals.probes++;
      }
      const earned = [...gs.today.values()].filter((x) => x.earned);
      d.ctx.log(
        `guard ${d.task} ${d.ctx.day}: J judged ${gs.today.size} (agree ${rel.agree}, silent ${rel.silent}, contradict ${rel.contradict}) · earned ${earned.length}${earned.length ? ` in ${[...new Set(earned.map((x) => x.key))].join(', ')}` : ''} · probes ${probes.map((p) => p.key).join(', ') || '—'}`,
      );
      return {
        decide: (_s: Prediction | undefined, j: Prediction) => {
          const x = gs.today.get(j.id);
          if (!x?.earned || x.label !== j.label) return null;
          const e = gs.cells.evidence(x.key);
          return { conf: earnedConf(x.lb, d.tau), why: `guard ${x.key} ${e.right}/${e.n} lb ${f3(x.lb)}` };
        },
        probes: new Set(probes.map((p) => p.id)),
        ...(T1.has(d.task) ? { clientAgree: (s: Prediction | undefined, j: Prediction) => sharedClient(s?.label, j.label, d.clientOf) } : {}),
      };
    },

    merged(preds: readonly Prediction[], d: GuardDay): void {
      const gs = guardState(d.ctx, d.task, o);
      for (const p of preds) {
        const x = gs.today.get(p.id);
        if (!x?.earned || p.ask || p.label !== x.label || p.conf < d.tau || !p.rung.startsWith('judge:')) continue;
        gs.decided.set(p.id, { key: x.key, label: x.label });
        gs.totals.decided++;
      }
    },

    nightly(task: TaskId, ctx: DayCtx): void {
      const gs = guardState(ctx, task, o);
      const t = gs.totals;
      let checks = 0;
      for (const r of ctx.memory) {
        // Human rows only: an audit of a J decision, or the answer to a probe (its own one-unit question). Machine and
        // seed rows, and answers to ordinary questions, never move the right to decide.
        if (r.task !== task || r.source !== 'human') continue;
        const sig = `${r.day}\u0000${r.id}\u0000${r.answer ?? ''}\u0000${r.audit ? 1 : 0}`;
        if (gs.seen.has(sig)) continue;
        gs.seen.add(sig);
        if (r.audit) {
          const dd = gs.decided.get(r.id);
          if (!dd) continue;
          gs.cells.observe(dd.key, r.label === dd.label);
          t.audits++;
          if (r.label === dd.label) t.auditRight++;
          checks++;
          continue;
        }
        const p = gs.probed.get(r.id);
        if (!p || p.day !== r.day || (r.answer !== undefined && r.answer !== `${r.day}:probe:${r.id}`)) continue;
        gs.cells.observe(p.key, r.label === p.label);
        t.probeAnswers++;
        if (r.label === p.label) t.probeRight++;
        checks++;
      }
      if (checks) {
        const top = gs.cells
          .table()
          .filter((c) => c.n)
          .slice(0, 6)
          .map((c) => `${c.key} ${c.right}/${c.n}`)
          .join(', ');
        ctx.log(`guard nightly ${task} ${ctx.day}: +${checks} random check(s) · run: probes ${t.probeRight}/${t.probeAnswers} right (${t.probes} asked), audits of J ${t.auditRight}/${t.audits}, J decided ${t.decided} · ${top}`);
      }
    },
  };
}

export interface HybridGOptions extends GuardOptions, Pick<HybridOptions, 'floor' | 'facts' | 'spine'> {
  name?: string;
}

export function makeHybridG(o: HybridGOptions = {}): Variant {
  const { name, z, priorN, probes, ...rest } = o;
  return makeHybrid({
    ...rest,
    name: name ?? 'hybrid-g',
    description:
      'Guarded hybrid: the K2a spine decides what structure proves; J judges the residue, but decides only where its cell (agreement × cite × relation to the spine) has EARNED it — Wilson lower bound of the prior (agree: the spine rung’s calibrated precision) + random evidence (audits of its decisions, answers to its daily probes) ≥ τ; ordinary answers never count; until then J’s label is the confirm question’s guess; client-agreement questions client-day; machine rows never evidence',
    guard: makeGuard({ ...(z !== undefined ? { z } : {}), ...(priorN !== undefined ? { priorN } : {}), ...(probes !== undefined ? { probes } : {}) }),
  });
}

export const hybridG: Variant = makeHybridG();
