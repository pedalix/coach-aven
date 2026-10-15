// The learning loop's questions and audits (design notes 10 §3.5, §5.1; ported from the lab bench's
// src/lab/variants/keys/questions.ts and the runner's audit credit, src/lab/run.ts). Pure and seeded: the daemon re-derives
// the same queue and the same audit sample on every build of a day.
//
//   group   one answer should teach as much as possible: a client × day for units whose client is decided and initiative
//           is not (K2a: "these 4 items of Velo Nord today: which initiative?"), else the item's learnable key with the best
//           expected yield, else the unit's case (a call, a run-day). At most 12 members; an overflow becomes further
//           chunks (`g#2` …), which rank lower because the first chunk already buys the key.
//   value   Σ over members (minutes or 1)·(1 − conf), plus 0.5·reach·h_T — the second term is the yield: how many later
//           units the answer may decide (learn.ts also counts a structural unit's route — its ctx key — so a doubted
//           route's .85 units get answered at all). Each member carries its own term and an equal share of the yield.
//   audits  a share of the daily budget re-asks auto-decided units, uniformly at random: the only unbiased sample of the
//           machine's own precision. The credit accrues Q × share per day from the first day anyone answered; a day draws
//           its whole part (at Q=3 and 15% one audit about every second day, not floor(.45) = never).

export const MAX_GROUP = 12;
export const REACH_DAYS = 14;

/** FNV-1a, 32 bit: the audit sample's seeded order (the lab bench's split hash). */
export function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export const dayNumber = (day: string): number => Math.floor(Date.parse(`${day}T00:00:00Z`) / 86_400_000);

/** Units of a key over the last `days` days, today included, from its per-day counts. A non-date day counts everything so far. */
export function reachOf(log: ReadonlyMap<string, number> | undefined, today: string, days = REACH_DAYS): number {
  if (!log) return 0;
  const t = dayNumber(today);
  let n = 0;
  for (const [d, c] of log) {
    if (d > today) continue;
    const dn = dayNumber(d);
    if (!Number.isFinite(t) || !Number.isFinite(dn) || t - dn < days) n += c;
  }
  return n;
}

export interface QuestionUnit {
  id: string;
  conf: number; // what the loop said (0 for an abstention)
  weight: number; // minutes for a fragment (1 when it has none), 1 otherwise
  group: string; // the base group: a client-day, a key id or a case key
  yield: number; // 0.5 · reach · h_T of the unit's best key (0 when it has none)
}

export interface Asked {
  group: string;
  value: number;
}

/** Group, chunk (≤ max) and value the day's questions; members of a group are ordered by their own term. */
export function groupQuestions(qs: readonly QuestionUnit[], max = MAX_GROUP): Map<string, Asked> {
  const base = new Map<string, QuestionUnit[]>();
  for (const q of qs) {
    const g = base.get(q.group);
    if (g) g.push(q);
    else base.set(q.group, [q]);
  }
  const own = (q: QuestionUnit): number => q.weight * (1 - Math.min(1, Math.max(0, q.conf)));
  const out = new Map<string, Asked>();
  for (const [group, members] of [...base].sort(([a], [b]) => a.localeCompare(b))) {
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

/**
 * How many audits today draws: the credit accrues `rate` (= Q × share) per day from `firstDay` (the first day with any
 * evidence; null = nobody answered yet, so nothing to audit for) through today, and each day draws its whole part —
 * floor(rate·n) − floor(rate·(n−1)) on the n-th day, the bench's carried credit.
 */
export function auditSize(firstDay: string | null, today: string, rate: number): number {
  if (!firstDay || !(rate > 0)) return 0;
  const n = dayNumber(today) - dayNumber(firstDay) + 1;
  if (!Number.isFinite(n) || n < 1) return 0;
  return Math.max(0, Math.floor(rate * n + 1e-9) - Math.floor(rate * (n - 1) + 1e-9));
}

/** Today's audit sample: `size` of the candidates, ordered by a hash of (seed, today, id) — stable across a day's builds. */
export function auditSample(candidates: readonly string[], seed: string, today: string, size: number): string[] {
  if (size <= 0) return [];
  return [...new Set(candidates)]
    .map((id) => ({ id, h: fnv1a(`${seed}|${today}|${id}`) }))
    .sort((a, b) => a.h - b.h || a.id.localeCompare(b.id))
    .slice(0, size)
    .map((x) => x.id);
}
