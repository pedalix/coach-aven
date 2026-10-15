// prod-today: the whole of today's pipeline for the subject's fragments, as Owen knows it — the ladder, plus
// the evening review agent's own `model` decisions as the tenant ledger recorded them (design §1.1). A
// reference, not a contender: it reads the ledger as it stood at the freeze, so it can only run static, and
// its model labels sit at the 0.75 the review prompt uses as its own cut. Owen's own lines are NOT used —
// those are the answers the bench scores against.

import { join } from 'node:path';
import { loadFragments } from '../../sources/annotations.js';
import type { DayCtx, Prediction, TaskId, Unit, Variant } from '../types.js';
import { baseline, tenantLadder } from './baseline.js';

export const prodToday: Variant = {
  name: 'prod-today',
  description: 'the ladder + the review agent’s recorded model decisions (conf .75); static only',
  tasks: ['t1-fragment'],
  async decide(task: TaskId, units: Unit[], ctx: DayCtx): Promise<Prediction[]> {
    const floor = await baseline.decide(task, units, ctx);
    let model = ctx.state.get('model') as Map<string, string> | undefined;
    if (!model) {
      const lad = tenantLadder(join(ctx.dir, 'tenant'), ctx.dataset.tz, ctx.dataset.subject);
      model = new Map();
      for (const f of loadFragments(join(ctx.dir, 'tenant', 'annotations', 'fragments.jsonl')).fragments) {
        if (f.status !== 'decided' || f.decided_by !== 'model' || !f.attributions.length) continue;
        const top = [...f.attributions].sort((a, b) => b.share - a.share)[0];
        model.set(f.id, lad.reg.resolveAlias(top.initiative));
      }
      ctx.state.set('model', model);
    }
    return floor.map((p) => {
      if (p.label !== null) return p;
      const m = model!.get(p.id);
      return m ? { id: p.id, label: m, conf: 0.75, rung: 'model:review' } : p;
    });
  },
};

