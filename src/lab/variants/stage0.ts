// The 'stage0' variant: the shared deterministic floor alone (design notes/10-design.md §1.1, §2) — no memory, no model.
// Every task goes through the floor (stage0/index.ts); T2–T4 through its T2-T4 seam (stage0/t234.ts). It is the bar K
// and J must clear, and the measure of how much the fix pack (§2.1) buys over today's production (baseline) by itself.
//
// Questions: a unit the floor does not decide at τ is asked by its case (§2.3: the call, the run-day, the ticket, the
// thread, the family-day) — `confirm` when the floor has a guess (a title hit, the admin bucket, a calibrated-down rung),
// `choose` otherwise. The only learning is the nightly rung-instance calibration (§2.5): human answers and audits on
// units a rung instance decided move that instance's confidence; machine rows never do.

import type { DayCtx, FragmentUnit, ItemUnit, MentionUnit, Prediction, TaskId, Unit, Variant } from '../types.js';
import { stage0, type Floor } from './stage0/index.js';

const asPrediction = (id: string, f: Floor): Prediction => ({
  id,
  label: f.label,
  conf: f.label ? f.conf : 0,
  rung: f.rung || (f.label ? 'floor' : 'abstain'),
  ...(f.hint ? { why: f.hint } : {}),
  ask: { group: f.case, guess: f.label ?? null, form: f.label ? 'confirm' : 'choose' },
});

export const stage0Variant: Variant = {
  name: 'stage0',
  description: 'the deterministic floor alone (fix pack F1–F12, graded rung confidences, rung-instance calibration) — no memory, no model',
  tasks: ['t1-fragment', 't1-item', 't2-dedup', 't3-identity', 't4-kind', 't4-addressee'],

  async decide(task: TaskId, units: Unit[], ctx: DayCtx): Promise<Prediction[]> {
    const s = stage0(ctx);
    switch (task) {
      case 't1-fragment': {
        const pool = ctx.pool as FragmentUnit[];
        return (units as FragmentUnit[]).map((u) => asPrediction(u.id, s.fragment(u, pool)));
      }
      case 't1-item': {
        const pool = ctx.pool as ItemUnit[];
        return (units as ItemUnit[]).map((u) => asPrediction(u.id, s.item(u, pool)));
      }
      case 't3-identity':
        return (units as MentionUnit[]).map((u) => asPrediction(u.id, s.mention(u)));
      case 't4-kind':
        return (units as ItemUnit[]).map((u) => asPrediction(u.id, s.kind(u)));
      case 't4-addressee':
        return (units as ItemUnit[]).map((u) => asPrediction(u.id, s.addressee(u)));
      case 't2-dedup': {
        const fam = s.dedup(units as ItemUnit[]);
        return units.map((u) => {
          const c = fam.get(u.id);
          return { id: u.id, label: c?.cluster ?? u.id, conf: c?.conf ?? 1, rung: c && c.cluster !== u.id ? 'dedup' : 'singleton' };
        });
      }
    }
  },

  // The "dream" of the floor: fold the day's human answers and audits into the rung instances that decided their units.
  async nightly(task: TaskId, ctx: DayCtx): Promise<void> {
    if (task !== 't1-fragment' && task !== 't1-item') return;
    stage0(ctx).calibrate(
      ctx.memory.filter((r) => r.task === task && r.source === 'human'),
      new Map(),
    );
  },
};
