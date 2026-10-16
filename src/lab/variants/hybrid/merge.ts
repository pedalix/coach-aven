// The hybrid's decision (notes/30-iter3.md §1–§3, §5): one unit, two opinions — the spine's (K2a: structure, earned keys)
// and J's (the model's content judgment, confidence = the measured precision of its cell). Pure.
//
//   1. the spine at conf ≥ τ is FINAL (J never saw the unit: it was not residue)
//   2. else J at conf ≥ τ decides (J's calibrated cell, as in J)
//   3. else the unit is a QUESTION, labelled with J's judgment (the spine's sub-τ guess when J has none):
//        group  the spine's umbrella-first group (client × day, K2a §2) when the spine put it in one; for fragments, when
//               J's two passes named two initiatives of ONE client, that client × day too (§5: one cheap question per
//               client per day instead of one per call topic); else J's case (the call, the run-day, the thread, the
//               ticket, the bot family × day). Client-day groups hold at most MAX_GROUP members (overflow `#2` …).
//        guess  J's label, the best content judgment (the spine's own guess when J has none); one guess per group — the
//               members' guesses weighed by their confidence — 'confirm' whenever there is one
//        value  (minutes or 1) · (1 − conf) per member, plus (the hybrid's default, MergeOpts.value 'yield') the spine's
//               yield — what its answer teaches the spine; the runner sums a group's members
// Whatever is decided carries no question. J's spend on a unit stays on it whoever decided (Prediction.costUsd).

import { fnv1a } from '../../metrics.js';
import type { Prediction } from '../../types.js';
import { umbrellaGroupOf } from '../keys2a/groups.js';
import { MAX_GROUP } from '../keys/questions.js';

export interface MergeOpts {
  day: string; // the local day being decided
  tau: number;
  weight: (id: string) => number; // minutes for a fragment (1 when it has none), 1 for an item
  /** Fragments: the client J's two passes agreed on while naming two of its initiatives (null: no such split). */
  clientSplit?: (j: Prediction) => string | null;
  max?: number; // members per client-day question (MAX_GROUP)
  /** 'own' (the spec): (minutes or 1)·(1 − conf). 'yield': plus the spine's yield — what its answer would teach the
   *  spine (K's key reach, K2a's ctx keys): the part of the spine's own value beyond its own (1 − conf) term. */
  value?: 'own' | 'yield';
  /** Outside client-day groups: 'case' (the spec) — J's case; 'spine' — the spine's group (K's key with the best yield). */
  groups?: 'case' | 'spine';
  /** May J's judgment at ≥ τ decide this unit? (default: always — the spec). A gated judgment stays a question, its
   *  confidence held just under τ. */
  gate?: (s: Prediction | undefined, j: Prediction) => boolean;
  /** Probation (an ablation): of the units J would decide today, `perDay` — one per J cell, the cells with the most such
   *  units first, the unit by a hash of day and id — are asked instead, at the top of the queue. A cell is measured on the
   *  questions it did NOT decide (ranked by value, not drawn at random) and on rare uniform audits; a random draw of what
   *  it does decide is the sample that tells its real precision. */
  probe?: { perDay: number; cellOf: (id: string) => string | null };
}

/** What a probation question adds to its value: enough to come first in the runner's queue. */
export const PROBE_VALUE = 100;

export type Source = 'spine' | 'judge' | 'question';

export interface MergeStats {
  spine: number; // auto-decided by the spine
  judge: number; // auto-decided by J
  gated: number; // J at ≥ τ held back by the gate (asked instead)
  probed: number; // J at ≥ τ asked on probation
  questions: number;
  guessed: number; // questions whose group guess is J's label
  umbrella: number; // questions in a client-day group
  splitUmbrella: number; // of those, put there by J's split passes (fragments)
}

const decided = (p: Prediction | undefined, tau: number): boolean => !!p && p.label !== null && p.conf >= tau;
const baseGroup = (g: string): string => g.replace(/#\d+$/, '');
const f3 = (x: number): string => x.toFixed(3);

/** What the spine's question was worth beyond its own (1 − conf) term: K's key yield, K2a's ctx-key gain. */
export function spineYield(s: Prediction | undefined, weight: number): number {
  if (!s || s.ask?.value === undefined) return 0;
  const own = weight * (1 - Math.min(1, Math.max(0, s.label === null ? 0 : s.conf)));
  return Math.max(0, s.ask.value - own);
}

/** How the spine stood on a unit, for the `why` of a decision it did not make (and the offline analysis). */
export const spineNote = (s: Prediction | undefined): string => (s ? `spine ${s.label ?? '—'}@${f3(s.label === null ? 0 : s.conf)} ${s.rung}` : 'spine —');

/** J's two passes when they disagreed: `A <id> · B <id> · R <id>` opens J's `why` (judge.ts judgeT1). */
export function passesOf(j: Prediction): { a: string; b: string } | null {
  const m = /^A (\S+) · B (\S+) · R /.exec(j.why ?? '');
  return m ? { a: m[1]!, b: m[2]! } : null;
}

/** The group's one guess: the members' guesses weighed by confidence; ties by the surest single member, then by id. */
export function leadGuess(members: readonly { guess: string | null; conf: number }[]): string | null {
  const by = new Map<string, { w: number; top: number }>();
  for (const m of members) {
    if (!m.guess) continue;
    const c = Math.max(0, m.conf);
    const cur = by.get(m.guess) ?? { w: 0, top: 0 };
    by.set(m.guess, { w: cur.w + c, top: Math.max(cur.top, c) });
  }
  let best: [string, { w: number; top: number }] | null = null;
  for (const e of by) if (!best || e[1].w > best[1].w || (e[1].w === best[1].w && (e[1].top > best[1].top || (e[1].top === best[1].top && e[0] < best[0])))) best = e;
  return best ? best[0] : null;
}

interface Q {
  p: Prediction;
  group: string; // base group
  guess: string | null;
  value: number;
  umbrella: boolean;
  split: boolean;
}

export function merge(ids: readonly string[], spine: ReadonlyMap<string, Prediction>, judge: ReadonlyMap<string, Prediction>, o: MergeOpts): { preds: Prediction[]; stats: MergeStats } {
  const stats: MergeStats = { spine: 0, judge: 0, gated: 0, probed: 0, questions: 0, guessed: 0, umbrella: 0, splitUmbrella: 0 };
  const out: Prediction[] = [];
  const qs: Q[] = [];
  const probe = new Set<string>();
  if (o.probe && o.probe.perDay > 0) {
    const byCell = new Map<string, string[]>();
    for (const id of ids) {
      const s = spine.get(id);
      const j = judge.get(id);
      if ((s && decided(s, o.tau)) || !j || !decided(j, o.tau) || (o.gate && !o.gate(s, j))) continue;
      const c = o.probe.cellOf(id) ?? j.rung;
      byCell.set(c, [...(byCell.get(c) ?? []), id]);
    }
    const h = (id: string): number => fnv1a(`probe|${o.day}|${id}`);
    const cells = [...byCell].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0])).slice(0, o.probe.perDay);
    for (const [, us] of cells) probe.add([...us].sort((a, b) => h(a) - h(b) || a.localeCompare(b))[0]!);
  }
  for (const id of ids) {
    const s = spine.get(id);
    const j = judge.get(id);
    if (s && decided(s, o.tau)) {
      const { ask: _drop, ...rest } = s;
      out.push(rest);
      stats.spine++;
      continue;
    }
    const cost = j?.costUsd !== undefined ? { costUsd: j.costUsd } : {};
    let held = false;
    if (j && decided(j, o.tau) && o.gate && !o.gate(s, j)) {
      held = true;
      stats.gated++;
    } else if (probe.has(id)) {
      held = true;
      stats.probed++;
    }
    if (j && !held && decided(j, o.tau)) {
      const { ask: _drop, ...rest } = j;
      out.push({ ...rest, ...cost, why: `${j.why ?? j.rung} · ${spineNote(s)}` });
      stats.judge++;
      continue;
    }
    // A question: J's judgment when it has one, else the spine's guess, else whichever abstention explains itself.
    const base: Prediction = j && j.label !== null ? j : s && s.label !== null ? s : (s ?? j ?? { id, label: null, conf: 0, rung: 'abstain' });
    const conf = base.label === null ? 0 : held && base === j ? Math.min(base.conf, o.tau - 0.001) : base.conf;
    const p: Prediction = { id, label: base.label, conf, rung: base.rung, ...cost, why: base === s ? `${s.why ?? s.rung} · J ${j?.rung ?? '—'}` : `${spineNote(s)} · ${held ? `${probe.has(id) ? 'probation' : 'gated'} ${j!.conf} · ` : ''}${j?.why ?? j?.rung ?? 'J —'}` };
    const spineGroup = s?.ask?.group ?? s?.group;
    let group: string;
    let umbrella = false;
    let split = false;
    if (spineGroup && spineGroup.startsWith('umb:')) {
      group = baseGroup(spineGroup);
      umbrella = true;
    } else {
      const client = j && o.clientSplit ? o.clientSplit(j) : null;
      if (client) {
        group = umbrellaGroupOf(client, o.day);
        umbrella = split = true;
      } else if (o.groups === 'spine' && spineGroup) group = spineGroup;
      else group = j?.ask?.group ?? j?.group ?? spineGroup ?? id;
    }
    const guess = j?.label ?? s?.ask?.guess ?? s?.label ?? null;
    const w = o.weight(id);
    const value = w * (1 - conf) + (o.value === 'yield' ? spineYield(s, w) : 0) + (probe.has(id) ? PROBE_VALUE : 0);
    qs.push({ p, group, guess, value: Math.round(value * 1000) / 1000, umbrella, split });
    out.push(p);
  }

  // Client-day groups: at most `max` members, the most valuable first (K2a's chunking); a case stays whole (J's).
  const max = o.max ?? MAX_GROUP;
  const byGroup = new Map<string, Q[]>();
  for (const q of qs) {
    const g = byGroup.get(q.group);
    if (g) g.push(q);
    else byGroup.set(q.group, [q]);
  }
  for (const [group, members] of byGroup) {
    const umbrellaGroup = members.some((m) => m.umbrella);
    const chunks: Q[][] = [];
    if (umbrellaGroup && members.length > max) {
      members.sort((a, b) => b.value - a.value || a.p.id.localeCompare(b.p.id));
      for (let i = 0; i < members.length; i += max) chunks.push(members.slice(i, i + max));
    } else chunks.push(members);
    chunks.forEach((chunk, i) => {
      const name = i === 0 ? group : `${group}#${i + 1}`;
      const guess = leadGuess(chunk.map((m) => ({ guess: m.guess, conf: m.p.conf })));
      for (const m of chunk) {
        m.p.ask = { group: name, value: m.value, guess, form: guess ? 'confirm' : 'choose' };
        stats.questions++;
        if (m.umbrella) stats.umbrella++;
        if (m.split) stats.splitUmbrella++;
        if (guess && judge.get(m.p.id)?.label === guess) stats.guessed++;
      }
    });
  }
  return { preds: out, stats };
}
