// Questions (design §3.5): what K asks, grouped so one answer teaches a key, and ranked by what the answer buys.
//
//   group  per task (§3.4): t1-item asks about the unit's learnable key with the best expected yield (reach × h_T —
//          see keys.ts for why not raw reach), t1-fragment about its case (the call, the run-day), t3 about the form,
//          t4 about the thread. At most 12 members: an overflow becomes further chunks of the same group (`g#2` …),
//          which rank lower because the first chunk already buys the key.
//   value  Σ over members (minutes or 1)·(1 − conf), plus 0.5·reach·h_T — the second term is the yield: how many later
//          units the answer may decide. The runner sums `ask.value` over a group, so each member carries its own term
//          and an equal share of the yield.
// Pure.

export const MAX_GROUP = 12;

export interface QuestionUnit {
  id: string;
  conf: number; // what K said (0 for an abstention)
  weight: number; // minutes for a fragment (1 when it has none), 1 otherwise
  group: string; // the base group: a key id or a case key
  yield: number; // 0.5 · reach · h_T of the group's key (0 when the group is a bare case)
}

export interface Asked {
  group: string;
  value: number;
}

export function groupQuestions(qs: readonly QuestionUnit[], max = MAX_GROUP): Map<string, Asked> {
  const base = new Map<string, QuestionUnit[]>();
  for (const q of qs) {
    const g = base.get(q.group);
    if (g) g.push(q);
    else base.set(q.group, [q]);
  }
  const own = (q: QuestionUnit): number => q.weight * (1 - Math.min(1, Math.max(0, q.conf)));
  const out = new Map<string, Asked>();
  for (const [group, members] of base) {
    members.sort((a, b) => own(b) - own(a) || a.id.localeCompare(b.id));
    const gain = Math.max(0, ...members.map((m) => m.yield));
    for (let i = 0; i < members.length; i += max) {
      const chunk = members.slice(i, i + max);
      const name = i === 0 ? group : `${group}#${i / max + 1}`;
      for (const m of chunk) out.set(m.id, { group: name, value: own(m) + (i === 0 ? gain / chunk.length : 0) });
    }
  }
  return out;
}

/** Units of a key over the last `days` days (today included), from a per-day count log. Days are local YYYY-MM-DD. */
export function reachOf(log: ReadonlyMap<string, number> | undefined, day: string, days = 14): number {
  if (!log) return 0;
  const t = Date.parse(`${day}T00:00:00Z`);
  // A fixture day that is not a calendar date: everything seen so far counts.
  const from = Number.isFinite(t) ? new Date(t - (days - 1) * 86_400_000).toISOString().slice(0, 10) : '';
  let n = 0;
  for (const [d, c] of log) if (d <= day && d >= from) n += c;
  return n;
}
