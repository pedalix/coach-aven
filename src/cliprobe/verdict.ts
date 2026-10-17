// Pure: a scenario's verdict for one CLI version from its runs (design D1). In this order:
// conclusive runs that disagree → `flaky` (however many there are); fewer conclusive runs than the
// scenario declares → `inconclusive`; otherwise what all conclusive runs say. Only `holds` holds.
import type { RunOutcome, Verdict } from './types.js';

export interface Settled {
  verdict: Verdict;
  holds: number;
  fails: number;
  inconclusive: number;
}

export function settle(runs: readonly RunOutcome[], required: number): Settled {
  const holds = runs.filter((r) => r.verdict === 'holds').length;
  const fails = runs.filter((r) => r.verdict === 'fails').length;
  const inconclusive = runs.length - holds - fails;
  let verdict: Verdict;
  if (holds > 0 && fails > 0) verdict = 'flaky';
  else if (holds + fails < required) verdict = 'inconclusive';
  else verdict = holds > 0 ? 'holds' : 'fails';
  return { verdict, holds, fails, inconclusive };
}

/** Whether the runner should start another run: not settled yet, not flaky, and within the budget. */
export function wantsAnotherRun(runs: readonly RunOutcome[], required: number, extraAttempts = 2): boolean {
  const s = settle(runs, required);
  if (s.verdict === 'flaky') return false;
  if (s.holds + s.fails >= required) return false;
  return runs.length < required + extraAttempts;
}
