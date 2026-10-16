// prod-today: the whole of today's pipeline for the subject's fragments, as Owen knows it — the ladder, plus
// the evening review agent's own `model` decisions as the tenant ledger recorded them (design §1.1). A
// reference, not a contender: it reads the ledger as it stood at the freeze, so it can only run static, and
// its model labels sit at the 0.75 the review prompt uses as its own cut. Owen's own lines are NOT used —
// those are the answers the bench scores against.
//
// The agent's decision is its LAST `model` line per fragment in the raw history, even when a later line of
// Owen's (or a rule's) overrode it: the effective ledger keeps only the latest line, and reading that would
// score the model rung on exactly the decisions nobody corrected — the ones Owen fixed would vanish.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isHumanLine, parseFragment, type Attribution } from '../../sources/annotations.js';
import type { DayCtx, Prediction, TaskId, Unit, Variant } from '../types.js';
import { baseline, tenantLadder } from './baseline.js';

/** fragment id → the attributions of the review agent's last decided line for it (raw ledger text in, every line read). */
export function modelDecisions(ledgerText: string): Map<string, Attribution[]> {
  const out = new Map<string, Attribution[]>();
  for (const line of ledgerText.split('\n')) {
    if (!line.trim()) continue;
    let f: ReturnType<typeof parseFragment>;
    try {
      f = parseFragment(JSON.parse(line));
    } catch {
      continue; // a torn or malformed line is nobody's decision
    }
    // parseFragment reads a `human:<id>` decider as decided_by 'model' + decider: a person's line is not the agent's.
    if (!f || f.status !== 'decided' || f.decided_by !== 'model' || isHumanLine(f) || !f.attributions.length) continue;
    out.set(f.id, f.attributions);
  }
  return out;
}

export const prodToday: Variant = {
  name: 'prod-today',
  description: 'the ladder + the review agent’s recorded model decisions (conf .75); static only',
  tasks: ['t1-fragment'],
  async decide(task: TaskId, units: Unit[], ctx: DayCtx): Promise<Prediction[]> {
    const floor = await baseline.decide(task, units, ctx);
    let model = ctx.state.get('model') as Map<string, string> | undefined;
    if (!model) {
      const lad = tenantLadder(join(ctx.dir, 'tenant'), ctx.dataset.tz, ctx.dataset.subject);
      const ledger = join(ctx.dir, 'tenant', 'annotations', 'fragments.jsonl');
      model = new Map();
      for (const [id, atts] of modelDecisions(existsSync(ledger) ? readFileSync(ledger, 'utf8') : '')) {
        const top = [...atts].sort((a, b) => b.share - a.share)[0]!;
        model.set(id, lad.reg.resolveAlias(top.initiative));
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
