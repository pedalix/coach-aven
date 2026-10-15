// K2a (notes/20-iter2.md §K2a.1) — the sibling-aware structural rung, for ONE floor decision. Pure.
//
// A structural decision (tracker key, container/channel rule, registry channel, exclusive marker, title hit — rungs
// key:/rule:/channel:/excl:/title:) mapping a unit to initiative X:
//   S = X's siblings (siblings.ts) is empty   → nothing changes: the route IS the initiative (key:MT, key:SWL …)
//   otherwise the unit's CLIENT is decided at the rung's confidence (umbrellaConf, the rung instance measured on the
//   client question — see floor.ts), and its initiative:
//     own-cue      the text carries a cue of X and none of a sibling      → X at the rung's confidence
//     earned       an earned key built from answers (ctx:<rung instance>) predicts X → X at the rung's confidence
//     sibling-cue  the text carries cues of a sibling Y and none of X     → Y at .60 (a guess: asked)
//     held         anything else (no cue, or cues of both)                → X at .85 (below τ: a confirm with guess X)
// The confidence is never RAISED: a rung instance its calibration already demoted keeps its lower value (X at
// min(.85, conf)); only the sibling guess is a fixed .60 — it is a different label, and a guess either way.
// K's own earned keys (thread, family, host …) need no branch here: when this floor stays below τ, K decides from them.

export const STRUCTURAL = /^(?:key|rule|channel|excl|title):/;
export const HOLD_CONF = 0.85;
export const SIBLING_CONF = 0.6;

export type Branch = 'alone' | 'own-cue' | 'earned' | 'sibling-cue' | 'held';

export interface TrustIn {
  label: string; // X, the floor's label
  conf: number; // the rung's (calibrated) confidence
  rung: string; // the rung instance
  siblings: readonly string[]; // S
  own: readonly string[]; // cue norms of X the text carries (the trigger excluded)
  sib: ReadonlyMap<string, readonly string[]>; // sibling → its cue norms the text carries
  earned: boolean; // an earned answer-built key (ctx:<rung>) predicts X
}

export interface TrustOut {
  label: string;
  conf: number;
  rung: string; // the floor's instance when X keeps its confidence (calibration charges it); held:/sib: otherwise
  branch: Branch;
  why: string;
}

const list = (xs: readonly string[], n = 3): string => (xs.length > n ? `${xs.slice(0, n).join(', ')} +${xs.length - n}` : xs.join(', '));

export function trust(t: TrustIn): TrustOut {
  if (!t.siblings.length) return { label: t.label, conf: t.conf, rung: t.rung, branch: 'alone', why: '' };
  const cued = t.siblings.map((s) => ({ s, n: t.sib.get(s)?.length ?? 0 })).filter((x) => x.n > 0);
  const sibs = `siblings ${list(t.siblings.map((s) => s.split('/').pop()!))}`;
  if (t.own.length && !cued.length) return { label: t.label, conf: t.conf, rung: t.rung, branch: 'own-cue', why: `own cue ${list(t.own)} · ${sibs}` };
  if (t.earned) return { label: t.label, conf: t.conf, rung: t.rung, branch: 'earned', why: `ctx:${t.rung} earned · ${sibs}` };
  if (!t.own.length && cued.length) {
    // the sibling the text names most; a tie goes to registry order (the siblings' order)
    const best = cued.reduce((a, b) => (b.n > a.n ? b : a));
    return { label: best.s, conf: SIBLING_CONF, rung: `sib:${t.rung}`, branch: 'sibling-cue', why: `cue ${list([...(t.sib.get(best.s) ?? [])])} of sibling ${best.s}, none of ${t.label}` };
  }
  const why = t.own.length ? `cues of ${t.label} (${list(t.own)}) and of ${list(cued.map((x) => x.s))}` : `no cue of ${t.label} · ${sibs}`;
  return { label: t.label, conf: Math.min(HOLD_CONF, t.conf), rung: `held:${t.rung}`, branch: 'held', why };
}
