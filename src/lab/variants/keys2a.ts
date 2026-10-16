// K2a — "trust repair" (notes/20-iter2.md §K2a): concept K (keys.ts, composed unchanged) on a floor whose structural
// rungs know that a client has several initiatives. Deterministic; the model only pre-fills question guesses (K+g).
//
// Iteration 1: nobody held 95% on bench-agency because the floor's structural rungs were over-trusted on an imperfect
// registry — key:VN 51.6% right, key:BKR 54%, the Alpenhof channel rule 68%, every error inside the client — and with
// 15% audits (one every ~2 days, uniform over everything auto-decided) the rung calibration never saw enough of them:
// 85 frozen errors in four weeks. K2a changes three things and keeps everything else of K:
//
//   1. sibling-aware structural rungs (keys2a/trust.ts, siblings.ts, cues.ts): a key/rule/channel/exclusive/title
//      decision for X whose client has other active initiatives decides the CLIENT at the rung's confidence; the
//      initiative stays X at that confidence only with an own cue of X and none of a sibling, or an earned answer-built
//      key; a sibling-only cue makes the sibling a .60 guess; anything else is X at .85 — a confirm question
//   2. umbrella-first questions (keys2a/groups.ts): those questions are grouped by (client, local day), one answer each
//   3. answer scope (keys2a/ctxkeys.ts): an answer on such a unit teaches the key ctx=<rung instance> — and, because
//      these units are now ASKED, the floor's rung-instance calibration (stage0 §2.5) hears ordinary answers instead
//      of waiting for the rare audit: once key:VN → the shop disagrees with answers, key:VN stops deciding
//   4. K as is: keys, trials, nightly, rule candidates; K+g guesses when ctx.llm exists (keys2a/guesses.ts runs them
//      after the regrouping, on the groups actually asked)
//
// Tasks: t1-item and t1-fragment get the above; every other task is K+g unchanged.
//
// THE INVARIANT (§3.1): machine output is never evidence. The cues are tenant facts (the registry), the client and
// initiative confidences move only on human rows, the ctx keys only on human/seed rows (machine rows only under the
// poisoning ablation's machineWeight, like K). The model's guess may make a question cheaper; it never decides, never
// raises a confidence, and is never written anywhere a later decision reads.
//
// Ablations (`--opt key=value`, besides K's): ctxA/ctxB/ctxK (the ctx key type's prior and k), umbrellaFirst=off
// (keep K's groups), siblingScope=umbrella (siblings by umbrella, not client), ownRouteCues=off (X's own key prefixes
// and channels do not corroborate X), tau.

import type { DayCtx, FragmentUnit, Prediction, TaskId, Unit, Variant } from '../types.js';
import { opt } from './index.js';
import { makeKeys } from './keys.js';
import { reachOf } from './keys/questions.js';
import { TAU } from './keys/spec.js';
import { stage0, type Stage0 } from './stage0/index.js';
import { trustedOf, type TenantFacts, type Trusted } from './keys2a/floor.js';
import { umbrellaFirst } from './keys2a/groups.js';
import { guessTop } from './keys2a/guesses.js';

const T1: ReadonlySet<TaskId> = new Set<TaskId>(['t1-item', 't1-fragment']);

export interface K2aOptions {
  name: string;
  description: string;
  guess: boolean; // K+g: one model call a day pre-fills the guesses of the top questions (when ctx.llm exists)
  floor?: (ctx: DayCtx) => Stage0; // the stage-0 floor (tests inject a fake)
  facts?: (ctx: DayCtx) => TenantFacts; // the registry facts (tests inject their own)
}

const fmt = (x: number): string => x.toFixed(3);

export function makeK2a(o: K2aOptions): Variant {
  const inner = o.floor ?? stage0;
  const trusted = (ctx: DayCtx): Trusted => trustedOf(ctx, inner, o.facts);
  // K over the trusted floor, without its own guess pass (K2a guesses after regrouping); K+g as is for the other tasks.
  const k = makeKeys({ name: o.name, description: o.description, guess: false, floor: (ctx) => trusted(ctx).floor });
  const kg = makeKeys({ name: o.name, description: o.description, guess: o.guess, floor: inner });

  return {
    name: o.name,
    description: o.description,
    tasks: k.tasks,

    async decide(task: TaskId, units: Unit[], ctx: DayCtx): Promise<Prediction[]> {
      if (!T1.has(task)) return kg.decide(task, units, ctx);
      const preds = await k.decide(task, units, ctx);
      const t = trusted(ctx);
      const tau = opt('tau', TAU);
      const byId = new Map(units.map((u) => [u.id, u]));
      const weight = (id: string): number => {
        const m = task === 't1-fragment' ? (byId.get(id) as FragmentUnit | undefined)?.minutes : undefined;
        return m && m > 0 ? m : 1;
      };
      // What K2a did to each unit, on its `why` (the client confidence is what umbrella-level analysis reads).
      for (const p of preds) {
        const m = t.meta.get(p.id);
        if (m) p.why = `${p.why ? `${p.why} · ` : ''}k2a ${m.branch}${m.why ? `: ${m.why}` : ''} · client=${m.client}@${fmt(m.umbrellaConf)}`;
      }
      if (opt('umbrellaFirst', 'on') !== 'off') {
        const h = t.ctxKeys.h();
        umbrellaFirst(
          preds,
          (id) => {
            const m = t.meta.get(id);
            return m ? { client: m.client, umbrellaConf: m.umbrellaConf } : undefined;
          },
          {
            day: ctx.day,
            tau,
            weight,
            // the yield of the group's answer for the ctx keys it teaches: 0.5 · reach · h (K's formula), best key once
            gain: (ids) => Math.max(0, ...ids.map((id) => t.meta.get(id)?.ctxKey).filter((k): k is string => !!k).map((k) => 0.5 * reachOf(t.ctxKeys.reach.get(k), ctx.day) * h)),
          },
        );
      }
      if (o.guess) await guessTop(task, units, preds, tau, t.floor, ctx);
      return preds;
    },

    async nightly(task: TaskId, ctx: DayCtx): Promise<void> {
      if (!T1.has(task)) return kg.nightly?.(task, ctx);
      await k.nightly!(task, ctx);
      const t = trusted(ctx);
      const r = t.nightly(ctx.memory, task, opt('machineWeight', 0));
      const branches = new Map<string, number>();
      for (const m of t.meta.values()) branches.set(m.branch, (branches.get(m.branch) ?? 0) + 1);
      const census = t.ctxKeys.learner.census().ctx;
      ctx.log(
        `${o.name} ${task} ${ctx.day} trust (units so far): ${[...branches].map(([b, n]) => `${b} ${n}`).join(' ') || '—'} · client rows ${r.client} · ctx ${r.ctx.rows} rows → ${r.ctx.observations} obs, ${r.ctx.trials} trials (${r.ctx.right} right), keys consistent/contradicted ${census ? `${census.consistent}/${census.contradicted}` : '0/0'}, h ${fmt(t.ctxKeys.h())}`,
      );
    },
  };
}

export const k2a: Variant = makeK2a({
  name: 'k2a',
  description:
    'K2a trust repair: K on a sibling-aware floor (a structural rung decides the client; the initiative only with an own cue and no sibling cue, or an earned key), umbrella-first questions, answers feed ctx:<rung> keys and the rung calibration; K+g guesses',
  guess: true,
});
