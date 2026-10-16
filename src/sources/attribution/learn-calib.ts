// The learning loop's rung-instance calibration (design notes 10 §2.5; ported from the lab bench's
// src/lab/variants/stage0/calibrate.ts). Every deciding rung INSTANCE of the floor — `rule:<id>`, `key:VN`,
// `channel:<c>`, `title:<p>`, `admin`, `host:<h>`, `excl:<person>` … — carries a Beta(20c, 20(1−c)) prior, c its graded
// rung confidence: before any evidence its posterior mean IS c. What people said about units the instance decided moves
// it, one count per answer id (an answer covering a whole call is one observation, not one per topic). Its units carry
// the posterior mean as their confidence; once an instance that decided on its own (c ≥ τ) falls below τ it is DEMOTED:
// its units become questions with its label as the guess. This is the only way a stale rule or a registry error is
// caught — auto-decided units are never asked, so only audits and the units sibling trust re-asks (K2a) reach them.
//
// Two levels per instance (K2a): the initiative (did the person give the instance's label?) and the client (did the
// person's label belong to the same client — company, else umbrella?). A route that is right about the client and only
// guesses the initiative (`VN-…` → velonord, shop or ERP sync) keeps the client while it loses the initiative.
//
// THE INVARIANT: only a person's rows count. A seed row never moves an instance (on the bench seeds were the floor's own
// pins: the floor must not grade its own homework), and the loop's own decisions never arrive here at all. Pure.

export const PRIOR_STRENGTH = 20;

export interface InstanceStat {
  right: number; // answers that gave the instance's label
  wrong: number;
  clientRight: number; // answers inside the label's client
  clientWrong: number;
}

/** One answer's verdict on one instance: right only if every unit of that answer under the instance was right. */
export interface Verdict {
  instance: string;
  answer: string;
  ok: boolean;
  clientOk: boolean;
}

/** The posterior mean of Beta(20c + right, 20(1−c) + wrong); the prior itself while nothing was observed. */
export function posterior(prior: number, right: number, wrong: number): number {
  const c = Math.min(1, Math.max(0, prior));
  if (right + wrong <= 0) return c;
  return (PRIOR_STRENGTH * c + right) / (PRIOR_STRENGTH + right + wrong);
}

export class Calibration {
  private readonly stats = new Map<string, InstanceStat>();
  private readonly counted = new Set<string>(); // instance × answer id

  stat(instance: string): InstanceStat | undefined {
    return this.stats.get(instance);
  }

  /** The instance's confidence for a unit whose own graded conf is `prior` (initiative level). */
  mean(instance: string, prior: number): number {
    const s = this.stats.get(instance);
    return s ? posterior(prior, s.right, s.wrong) : prior;
  }

  /** The same at client level: was the person's label at least the route's client? */
  clientMean(instance: string, prior: number): number {
    const s = this.stats.get(instance);
    return s ? posterior(prior, s.clientRight, s.clientWrong) : prior;
  }

  /**
   * Fold a batch of verdicts in. Verdicts of one instance × answer are combined (AND) into one observation; an
   * observation counted in an earlier batch is never counted again.
   */
  apply(verdicts: readonly Verdict[]): void {
    const merged = new Map<string, Verdict>();
    for (const v of verdicts) {
      const id = `${v.instance}\u0000${v.answer}`;
      if (this.counted.has(id)) continue;
      const cur = merged.get(id);
      merged.set(id, cur ? { ...cur, ok: cur.ok && v.ok, clientOk: cur.clientOk && v.clientOk } : v);
    }
    for (const [id, v] of [...merged].sort(([a], [b]) => a.localeCompare(b))) {
      this.counted.add(id);
      const s = this.stats.get(v.instance) ?? { right: 0, wrong: 0, clientRight: 0, clientWrong: 0 };
      if (v.ok) s.right++;
      else s.wrong++;
      if (v.clientOk) s.clientRight++;
      else s.clientWrong++;
      this.stats.set(v.instance, s);
    }
  }
}
