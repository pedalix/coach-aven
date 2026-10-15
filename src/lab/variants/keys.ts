// Concept K, "Earned Keys" (design notes/10-design.md §3): a deterministic learner on the stage-0 floor. An answer is
// about a KEY, not a unit — the thread, the alert family, the host, the mail subject, the channel, the call series —
// and a key type earns the right to decide later units only by being right on units people checked. The model never
// decides anything: K+g (`keys+g`) may only pre-fill the guess of a question.
//
//   decide   floor first (conf ≥ τ); then the unit's active keys that are consistent (≥ k answers, all agreeing)
//            predict at their type's measured homophily; all agree at ≥ τ → decided; they disagree → asked; anything
//            else is a guess below τ, i.e. a question (learner.ts decideUnit)
//   ask      grouped so one answer teaches a key, ranked by (minutes or 1)·(1 − conf) + the answer's yield
//            (questions.ts); 'confirm' when K's own deterministic guess is surer than not, else 'choose'; K+g
//            replaces the guess of the day's top groups with one haiku guess each, as 'confirm' (guess.ts)
//   nightly  today's human rows feed the key tables (one observation per answer id), the keys that predicted a
//            checked unit record a trial for their type, the floor recalibrates its rung instances, rule candidates
//            are counted (§3.6)
//
// Per task (§3.4): t1-fragment series/run/cpset/token/cowork · t1-item thread/family/host/app/subject/container/
// domain/sender/token · t3-identity the form memo · t4-kind family/cue · t4-addressee cont→to · t2-dedup the floor's.
//
// Ablations (`--opt key=value`): machineWeight (0; the poisoning test gives the pipeline's own auto-decisions this
// weight as evidence), tau (.95), groupBy ('decidable' = the best reach × h_T among keys whose type would decide after k
// answers, else among all; 'yield' = reach × h_T among all learnable keys; 'reach' = the design's literal rule),
// confirmMin (.5; 1 = K always asks 'choose', the design's literal K).
//
// One deliberate reading of §3.5: the group is the learnable key with the best EXPECTED yield (reach × h_T), and
// "learnable" means a key whose type would decide after its k answers alone. Raw reach makes a person's channel or a
// sender the group of almost every chat item; those groups are mixed by construction (homophily .40–.80), so under
// the effort model they cost one question per extra label, and the answer teaches a key that still cannot decide.
// On a real tenant's t1-item replay (opus silver, Q=3) it gave the most auto-decisions of the three policies.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadPeople } from '../../sources/people.js';
import { caseKeyOf } from '../cases.js';
import type { DayCtx, FragmentUnit, ItemUnit, MemoryRow, MentionUnit, Prediction, TaskId, Unit, Variant } from '../types.js';
import { opt } from './index.js';
import { stage0, type Floor, type Stage0 } from './stage0/index.js';
import {
  addresseeKeys,
  coworkOf,
  fragmentKeys,
  isActive,
  itemKeys,
  kindKeys,
  mentionKeys,
  nameVocab,
  newPoolStats,
  notePool,
  type PoolStats,
  type Vocab,
} from './keys/extract.js';
import { GUESSABLE, MAX_GUESS_GROUPS, guessGroups, type GuessGroup } from './keys/guess.js';
import { Learner, decideUnit, evidenceWeight, obsIdOf } from './keys/learner.js';
import { groupQuestions, reachOf, type QuestionUnit } from './keys/questions.js';
import { TASK_TYPES, TAU, TYPES, typeOf, type KeyType } from './keys/spec.js';

// Structure next to a call that may lend it its label (cowork): a work block the floor decided at least this sure.
const COWORK_MIN_CONF = 0.97;

interface KState {
  learner: Learner;
  stats: PoolStats;
  unitKeys: Map<string, string[]>; // candidate keys of every unit seen (pool included): what an answer about it teaches
  reach: Map<string, Map<string, number>>; // key → local day → units carrying it
  predicted: Map<string, { key: string; label: string }[]>; // unit → the keys that predicted it at decide time
  floorDecided: Map<string, string>; // unit → the floor rung instance that decided it (for its calibration)
  processed: Set<string>; // memory rows already consumed
  trialsDone: Set<string>; // key × answer id: one trial each
  vocab: Vocab | null;
}

export interface KeysOptions {
  name: string;
  description: string;
  guess: boolean; // K+g: one model call a day pre-fills the guesses of the top questions
  floor?: (ctx: DayCtx) => Stage0; // the stage-0 floor (tests inject a fake)
}

const TASKS: TaskId[] = ['t1-fragment', 't1-item', 't2-dedup', 't3-identity', 't4-kind', 't4-addressee'];

function stateOf(ctx: DayCtx): KState {
  let st = ctx.state.get('keys') as KState | undefined;
  if (!st) {
    st = {
      learner: new Learner(TYPES),
      stats: newPoolStats(),
      unitKeys: new Map(),
      reach: new Map(),
      predicted: new Map(),
      floorDecided: new Map(),
      processed: new Set(),
      trialsDone: new Set(),
      vocab: null,
    };
    ctx.state.set('keys', st);
  }
  return st;
}

// Names are not topics: the tenant's roster (a tenant fact) plus the dataset's person ids.
function vocabOf(ctx: DayCtx, st: KState): Vocab {
  if (st.vocab) return st.vocab;
  const file = join(ctx.dir, 'tenant', 'annotations', 'people.json');
  let people: { person_id: string; name?: string; identities?: string[] }[] = [];
  try {
    if (existsSync(file)) people = loadPeople(file);
  } catch {
    people = [];
  }
  const ids = (ctx.dataset.labelSpace?.people ?? []).map((person_id) => ({ person_id }));
  st.vocab = nameVocab([...people, ...ids]);
  return st.vocab;
}

// Would a key of this type decide once it holds k agreeing answers (its measured homophily plus the tie-break ≥ τ)?
const decidable = (l: Learner, t: KeyType, tau: number): boolean => l.h(t) + 0.001 * Math.min(TYPES[t].k, 9) >= tau;

const sigOf = (r: MemoryRow): string => `${r.source}\u0000${r.day}\u0000${r.id}\u0000${r.answer ?? ''}\u0000${r.audit ? 1 : 0}`;

// What the floor and the keys know of one unit.
interface View {
  floor: Floor;
  keys: string[]; // candidate keys
  case: string; // the case key (question unit for case-grouped tasks)
  weight: number; // minutes (fragments) or 1
}

function viewsOf(task: TaskId, pool: Unit[], fl: Stage0, ctx: DayCtx, st: KState, tau: number): Map<string, View> {
  const out = new Map<string, View>();
  if (task === 't1-fragment') {
    const frags = pool as FragmentUnit[];
    const floors = new Map(frags.map((u) => [u.id, fl.fragment(u, frags)]));
    const work = frags
      .filter((u) => u.kind === 'work')
      .flatMap((u) => {
        const f = floors.get(u.id)!;
        return f.label !== null && f.conf >= COWORK_MIN_CONF ? [{ start: u.start, end: u.end, label: f.label }] : [];
      });
    const vocab = vocabOf(ctx, st);
    for (const u of frags) {
      const f = floors.get(u.id)!;
      const cowork = [...new Set([...(f.cowork ?? []), ...coworkOf(u, work)])];
      out.set(u.id, { floor: f, keys: fragmentKeys(u, { participants: f.participants ?? [], cowork }, ctx.dataset.subject, vocab), case: f.case || caseKeyOf(task, u), weight: u.minutes > 0 ? u.minutes : 1 });
    }
  } else if (task === 't1-item' || task === 't4-kind' || task === 't4-addressee') {
    const items = pool as ItemUnit[];
    const vocab = vocabOf(ctx, st);
    for (const u of items) {
      if (task === 't1-item') {
        const it = fl.item(u, items);
        out.set(u.id, { floor: it, keys: itemKeys(u, it, vocab), case: it.case || caseKeyOf(task, u), weight: 1 });
      } else if (task === 't4-kind') {
        const f = fl.kind(u) as Floor & { cues?: string[] };
        out.set(u.id, { floor: f, keys: kindKeys(u, fl.item(u, items), Array.isArray(f.cues) ? f.cues : undefined), case: f.case || caseKeyOf(task, u), weight: 1 });
      } else {
        const f = fl.addressee(u);
        out.set(u.id, { floor: f, keys: addresseeKeys(u, f.label !== null && f.conf >= tau), case: f.case || caseKeyOf(task, u), weight: 1 });
      }
    }
  } else if (task === 't3-identity') {
    for (const u of pool as MentionUnit[]) {
      const f = fl.mention(u);
      const keys = mentionKeys(u);
      out.set(u.id, { floor: f, keys, case: keys[0]!, weight: 1 });
    }
  }
  return out;
}

export function makeKeys(o: KeysOptions): Variant {
  const floorOf = o.floor ?? stage0;
  return {
    name: o.name,
    description: o.description,
    tasks: TASKS,

    async decide(task: TaskId, units: Unit[], ctx: DayCtx): Promise<Prediction[]> {
      const fl = floorOf(ctx);
      if (task === 't2-dedup') {
        // The floor's clusters (F10): K learns nothing here — families are reuse keys, not clusters.
        const got = fl.dedup(units as ItemUnit[]);
        return units.map((u) => {
          const c = got.get(u.id);
          return c ? { id: u.id, label: c.cluster, conf: c.conf, rung: 'floor:dedup' } : { id: u.id, label: u.id, conf: 1, rung: 'floor:singleton' };
        });
      }
      const st = stateOf(ctx);
      const tau = opt('tau', TAU);
      const learner = st.learner;
      // The pool is the day's stream (decided or not); the units to decide are in it, but never trust that blindly.
      const ids = new Set(ctx.pool.map((u) => u.id));
      const pool = [...ctx.pool, ...units.filter((u) => !ids.has(u.id))];
      const views = viewsOf(task, pool, fl, ctx, st, tau);

      // Pool statistics first (a series is "seen twice" counting today), then reach, once per unit.
      for (const u of pool) {
        const v = views.get(u.id)!;
        st.unitKeys.set(u.id, v.keys);
        if (st.stats.counted.has(u.id)) continue;
        notePool(st.stats, u.id, v.keys, v.case);
        for (const k of v.keys) {
          const log = st.reach.get(k) ?? new Map<string, number>();
          log.set(ctx.day, (log.get(ctx.day) ?? 0) + 1);
          st.reach.set(k, log);
        }
      }

      const types = new Set(TASK_TYPES[task] ?? []);
      const active = (keys: string[]) => keys.filter((k) => types.has(typeOf(k)) && isActive(st.stats, k));
      const preds: Prediction[] = [];
      const questions: QuestionUnit[] = [];
      const guesses = new Map<string, string | null>();
      const byGroupKeyType = new Map<string, string>();
      const groupBy = opt('groupBy', 'decidable');
      for (const u of units) {
        const v = views.get(u.id)!;
        const keys = active(v.keys);
        const d = decideUnit(v.floor, keys, learner, tau);
        st.predicted.set(
          u.id,
          d.preds.map((p) => ({ key: p.key, label: p.label })),
        );
        if (v.floor.label !== null && v.floor.conf >= tau) st.floorDecided.set(u.id, v.floor.rung);
        preds.push({ id: u.id, label: d.label, conf: d.conf, rung: d.rung, why: d.why });
        if (d.label !== null && d.conf >= tau) continue;
        // A question. Its yield: what the best learnable key of the unit would then decide (0.5 · reach · h_T).
        // 'decidable' (default) prefers keys whose type would decide after k answers alone (h_T ≥ τ): an answer
        // about a .80 channel teaches a key that still cannot decide anything.
        const learnable = keys.filter((k) => !TYPES[typeOf(k)].direct && !learner.contradicted(k));
        const pool2 = groupBy === 'decidable' ? learnable.filter((k) => decidable(learner, typeOf(k), tau)) : learnable;
        let best: { key: string; reach: number; score: number } | null = null;
        for (const k of pool2.length ? pool2 : learnable) {
          const reach = reachOf(st.reach.get(k), ctx.day);
          const score = groupBy === 'reach' ? reach : reach * learner.h(typeOf(k));
          if (!best || score > best.score || (score === best.score && (reach > best.reach || (reach === best.reach && k < best.key)))) best = { key: k, reach, score };
        }
        const gain = best ? 0.5 * best.reach * learner.h(typeOf(best.key)) : 0;
        // §3.4: items ask about their key; fragments about their call or run-day; mentions about the form; t4 about the thread.
        const group = task === 't1-item' && best ? best.key : v.case;
        byGroupKeyType.set(group, task === 't1-item' && best ? typeOf(best.key) : 'case');
        questions.push({ id: u.id, conf: d.label === null ? 0 : d.conf, weight: v.weight, group, yield: gain });
        guesses.set(u.id, d.guess);
      }

      const asked = groupQuestions(questions);
      const byId = new Map(preds.map((p) => [p.id, p]));
      // One guess per group (the runner reads the first member's): the surest member's. K's own guesses are
      // deterministic (a weak key, a sub-τ rung); it asks 'confirm' only when the guess is likelier right than wrong —
      // under the effort model a confirm costs 1.5 − P(right), a choose 1.
      const confirmMin = opt('confirmMin', 0.5);
      const lead = new Map<string, Prediction>();
      for (const [id, a] of asked) {
        const p = byId.get(id)!;
        const cur = lead.get(a.group);
        if (guesses.get(id) && (!cur || p.conf > cur.conf || (p.conf === cur.conf && p.id < cur.id))) lead.set(a.group, p);
      }
      for (const [id, a] of asked) {
        const l = lead.get(a.group);
        const guess = l ? (guesses.get(l.id) ?? null) : null;
        byId.get(id)!.ask = { group: a.group, value: a.value, guess, form: guess && l!.conf > confirmMin ? 'confirm' : 'choose' };
      }

      if (o.guess && ctx.llm && GUESSABLE.has(task) && asked.size) await guessTopGroups(task, units, asked, byId, byGroupKeyType, fl, ctx);
      return preds;
    },

    async nightly(task: TaskId, ctx: DayCtx): Promise<void> {
      if (task === 't2-dedup') return;
      const st = stateOf(ctx);
      const fl = floorOf(ctx);
      const mw = opt('machineWeight', 0);
      const fresh = ctx.memory.filter((r) => r.task === task && !st.processed.has(sigOf(r)));
      for (const r of fresh) st.processed.add(sigOf(r));
      const evidence = fresh.filter((r) => evidenceWeight(r, mw) > 0);

      // 1. Today's rows into the key tables: every candidate key of the unit, one observation per answer id.
      let obs = 0;
      for (const r of evidence) for (const k of st.unitKeys.get(r.id) ?? []) if (st.learner.observe(k, r.label, obsIdOf(r), evidenceWeight(r, mw))) obs++;

      // 2. Trials: a key that predicted a unit someone then labelled — one per key × answer id; a success only if
      //    every unit of that answer the key predicted carries the predicted label.
      const outcome = new Map<string, { key: string; ok: boolean; w: number }>();
      for (const r of evidence) {
        for (const p of st.predicted.get(r.id) ?? []) {
          const id = `${p.key}\u0000${obsIdOf(r)}`;
          if (st.trialsDone.has(id)) continue;
          const cur = outcome.get(id);
          outcome.set(id, { key: p.key, ok: (cur?.ok ?? true) && r.label === p.label, w: Math.max(cur?.w ?? 0, evidenceWeight(r, mw)) });
        }
      }
      let won = 0;
      for (const [id, t] of outcome) {
        st.trialsDone.add(id);
        st.learner.trial(typeOf(t.key), t.ok, t.w);
        if (t.ok) won++;
      }

      // 3. Contradictions are automatic (a key with two labels stops predicting). 4. The floor's rung instances
      //    recalibrate on what people said — never on machine rows.
      const human = ctx.memory.filter((r) => r.task === task && r.source !== 'machine');
      fl.calibrate(human, st.floorDecided);

      // 5. Rule candidates: keys confirmed ≥3 times of a type measured ≥ .9 (in production, R-questions).
      const rules = st.learner.ruleCandidates();
      const ruleTypes = new Map<string, number>();
      for (const k of rules) ruleTypes.set(typeOf(k), (ruleTypes.get(typeOf(k)) ?? 0) + 1);
      const census = st.learner.census();
      const consistent = Object.entries(census)
        .filter(([, c]) => c.consistent || c.contradicted)
        .map(([t, c]) => `${t} ${c.consistent}/${c.contradicted}`)
        .join(' ');
      const types = (TASK_TYPES[task] ?? []).map((t) => `${t} ${st.learner.h(t).toFixed(3)}`).join(' ');
      ctx.log(
        `${o.name} ${task} ${ctx.day} nightly: ${evidence.length} rows → ${obs} observations, ${outcome.size} trials (${won} right) · keys consistent/contradicted: ${consistent || '—'} · h: ${types} · rule candidates ${rules.length}${rules.length ? ` (${[...ruleTypes].map(([t, n]) => `${t} ${n}`).join(', ')})` : ''}`,
      );
    },
  };
}

// K+g: the day's top groups by value get one haiku guess each, as a 'confirm' question. Never a label, never evidence.
async function guessTopGroups(
  task: TaskId,
  units: Unit[],
  asked: Map<string, { group: string; value: number }>,
  byId: Map<string, Prediction>,
  keyType: Map<string, string>,
  fl: Stage0,
  ctx: DayCtx,
): Promise<void> {
  const groups = new Map<string, { value: number; ids: string[] }>();
  for (const [id, a] of asked) {
    const g = groups.get(a.group) ?? { value: 0, ids: [] };
    g.value += a.value;
    g.ids.push(id);
    groups.set(a.group, g);
  }
  const top = [...groups.entries()].sort(([ka, a], [kb, b]) => b.value - a.value || ka.localeCompare(kb)).slice(0, MAX_GUESS_GROUPS);
  const unitById = new Map(units.map((u) => [u.id, u]));
  const tags = new Map<string, string>();
  const asks: GuessGroup[] = top.map(([group, g], i) => {
    const tag = `g${i + 1}`;
    tags.set(tag, group);
    const members = [...g.ids].sort((a, b) => (asked.get(b)!.value - asked.get(a)!.value) || a.localeCompare(b)).map((id) => unitById.get(id)!);
    const base = group.replace(/#\d+$/, '');
    return { tag, members, size: g.ids.length, keyType: keyType.get(base) ?? 'case', kGuess: byId.get(g.ids[0]!)?.ask?.guess ?? null };
  });
  const r = await guessGroups(ctx.llm!, task, asks, fl.labelSpace(task), task === 't4-kind' ? [] : fl.cards());
  if (r.error) ctx.log(`keys+g ${task} ${ctx.day}: guess call failed (${r.error.slice(0, 80)}) — the questions keep K's own guesses`);
  for (const [tag, guess] of r.guesses) {
    const group = tags.get(tag)!;
    for (const id of groups.get(group)!.ids) {
      const p = byId.get(id)!;
      p.ask = { ...p.ask, guess, form: 'confirm' };
    }
  }
}

export const keys: Variant = makeKeys({
  name: 'keys',
  description: 'Earned Keys: stage-0 floor, then typed keys that decide once their type is measured ≥ τ on human answers; no model',
  guess: false,
});

export const keysG: Variant = makeKeys({
  name: 'keys+g',
  description: 'Earned Keys + one haiku call a day to pre-fill the guesses of the top questions (confirm form); the guess is never a decision nor evidence',
  guess: true,
});
