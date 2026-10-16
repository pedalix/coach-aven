// Stage 0 — rung-instance calibration (design notes/10-design.md §2.5). Every deciding rung INSTANCE (rule:<id>, key:VN,
// channel:C…, title:<pattern>, admin, host:<h>, excl:<person> …) carries a Beta(20c, 20(1−c)) prior, c its graded rung
// confidence: before any evidence its posterior mean IS c. Human rows — answers and audits — on units the instance
// decided move it, one count per answer id (an answer covering a whole call is one observation, not one per topic).
// Its units then carry the posterior mean as their confidence; once that falls below τ the instance no longer decides
// on its own, its units become guesses (asked, or handed to K/J). This is the only way a stale rule or a registry error
// is caught: auto-decided units are never asked, so only audits reach them.
//
// THE INVARIANT (§0, §3.1): only `human` rows count. A `machine` row (the loop's own decisions) or a seed row never moves
// an instance — the floor must not grade its own homework.

import type { MemoryRow } from '../../types.js';

export const PRIOR_STRENGTH = 20;
export const TAU = 0.95;

export interface InstanceStat {
  instance: string;
  right: number; // observations (answer ids) that confirmed the instance
  wrong: number; // observations that contradicted it
}

/** What the floor said about a unit when it decided it: the instance and its label. */
export interface Said {
  instance: string;
  label: string | null;
}

export class Calibration {
  private readonly stats = new Map<string, InstanceStat>();
  private readonly counted = new Set<string>(); // `${instance}\0${answer id}`

  /** Posterior mean of an instance whose rung prior is `prior`; the prior itself while nothing was observed. */
  mean(instance: string, prior: number): number {
    const s = this.stats.get(instance);
    if (!s || prior <= 0) return prior;
    const a = PRIOR_STRENGTH * prior + s.right;
    const b = PRIOR_STRENGTH * (1 - prior) + s.wrong;
    return a / (a + b);
  }

  stat(instance: string): InstanceStat | undefined {
    return this.stats.get(instance);
  }

  all(): InstanceStat[] {
    return [...this.stats.values()].sort((a, b) => a.instance.localeCompare(b.instance));
  }

  /**
   * Fold human rows into the instances that decided their units. `said(unitId)` is what the floor said at decide time;
   * `decided` (unit → instance) overrides the instance when a caller (K, J) tracked it itself. Rows of one answer id
   * under one instance are ONE observation: right only if every unit of it was right. Idempotent — the runner hands the
   * nightly pass every row so far, and an answer counted once is never counted again.
   */
  update(rows: readonly MemoryRow[], said: (id: string) => Said | undefined, decided?: ReadonlyMap<string, string>): void {
    const verdicts = new Map<string, { instance: string; ok: boolean }>();
    for (const r of rows) {
      if (r.source !== 'human') continue;
      const s = said(r.id);
      const instance = decided?.get(r.id) ?? s?.instance;
      const label = s?.label ?? r.predicted ?? null;
      if (!instance || instance === 'abstain' || !label) continue;
      const key = `${instance}\u0000${r.answer ?? `${r.day}:${r.id}${r.audit ? ':audit' : ''}`}`;
      if (this.counted.has(key)) continue;
      const ok = r.label === label;
      const cur = verdicts.get(key);
      verdicts.set(key, { instance, ok: (cur?.ok ?? true) && ok });
    }
    for (const [key, v] of verdicts) {
      this.counted.add(key);
      const s = this.stats.get(v.instance) ?? { instance: v.instance, right: 0, wrong: 0 };
      if (v.ok) s.right++;
      else s.wrong++;
      this.stats.set(v.instance, s);
    }
  }
}
