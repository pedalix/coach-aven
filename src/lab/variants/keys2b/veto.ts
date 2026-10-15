// K2b's veto questions (notes/20-iter2.md §K2b.2–3). A vetoed unit keeps the floor's label X but drops to conf .70, so it
// is a question: a 'confirm' of X ("routed to velonord/shop by its VN key — is it?"), never of the check's own label. The
// answer is an ordinary human row: it feeds K's keys and the floor's rung-instance calibration (one wrong answer stops a
// .97 instance, design §2.5) like any answer or audit — that is how the check's targeting reaches the learning, while the
// check itself stays out of it.
//
//   group  (X, the unit's case): the comments of one ticket, the topics of one call, the run of one channel-day — one
//          answer covers them, and a case rarely mixes labels. ≤12 members; overflow chunks `#2`… as K does.
//   value  K's own term, Σ (minutes or 1)·(1 − .70), plus a YIELD on the day's lead group of each rung instance:
//          0.5 · the units the check vetoed on that instance over the last 14 days (today included). That is §K2b.3's
//          "targeted audit" share made a question rank: the answer settles a suspicion that recurs on the instance (a wrong
//          X stops the instance; a right one adds to its count), so an instance flagged again and again climbs the queue,
//          while a one-off veto on a sound instance stays cheap and low. The suspicion is machine output used to ORDER
//          questions only — it never moves a key, a calibration, a threshold or a rule.
// Pure.

import { MAX_GROUP } from '../keys/questions.js';

export const VETO_CONF = 0.7;
export const VETO_PREFIX = 'veto:';

export interface Vetoed {
  id: string;
  label: string; // X, the structural label (the question's guess)
  instance: string; // the floor's rung instance that decided it ('key:VN', 'rule:r-booker', …)
  case: string; // the unit's case key (§2.3)
  weight: number; // minutes for a fragment (1 when it has none), 1 otherwise
}

export interface VetoAsk {
  group: string;
  value: number;
}

/** The question unit of a vetoed unit: its own case, per structural label (never merged into one of K's groups). */
export const vetoGroupOf = (v: Pick<Vetoed, 'label' | 'case'>): string => `${VETO_PREFIX}${v.label}|${v.case}`;

/**
 * Group and rank the day's vetoed units. `suspicion(instance)` = the instance's vetoed units over the last 14 days (today
 * included); 0 turns the yield off (K's own value term only).
 */
export function vetoQuestions(vetoed: readonly Vetoed[], suspicion: (instance: string) => number, conf = VETO_CONF, max = MAX_GROUP): Map<string, VetoAsk> {
  const own = (v: Vetoed): number => Math.max(0, v.weight) * (1 - conf);
  const base = new Map<string, Vetoed[]>();
  for (const v of vetoed) {
    const g = vetoGroupOf(v);
    const list = base.get(g);
    if (list) list.push(v);
    else base.set(g, [v]);
  }
  const chunks: { name: string; members: Vetoed[]; first: boolean }[] = [];
  for (const [group, members] of [...base].sort(([a], [b]) => a.localeCompare(b))) {
    members.sort((a, b) => own(b) - own(a) || a.id.localeCompare(b.id));
    for (let i = 0; i < members.length; i += max) chunks.push({ name: i === 0 ? group : `${group}#${i / max + 1}`, members: members.slice(i, i + max), first: i === 0 });
  }
  // The lead chunk of each instance: the first chunk (of a group) holding it with the most own value, ties by name.
  const sumOwn = (c: { members: Vetoed[] }): number => c.members.reduce((a, m) => a + own(m), 0);
  const lead = new Map<string, (typeof chunks)[number]>();
  for (const c of chunks) {
    if (!c.first) continue;
    for (const inst of new Set(c.members.map((m) => m.instance))) {
      const cur = lead.get(inst);
      if (!cur || sumOwn(c) > sumOwn(cur) || (sumOwn(c) === sumOwn(cur) && c.name < cur.name)) lead.set(inst, c);
    }
  }
  const gain = new Map<string, number>();
  for (const [inst, c] of lead) gain.set(c.name, (gain.get(c.name) ?? 0) + 0.5 * Math.max(0, suspicion(inst)));
  const out = new Map<string, VetoAsk>();
  for (const c of chunks) {
    const share = (gain.get(c.name) ?? 0) / c.members.length;
    for (const m of c.members) out.set(m.id, { group: c.name, value: Math.round((own(m) + share) * 1e6) / 1e6 });
  }
  return out;
}
