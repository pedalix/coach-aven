// K2b "targeted verification" (notes/20-iter2.md §K2b): K+g as it stands (keys.ts — floor first, earned keys, K's
// questions, the K+g guess, the nightly), plus ONE cheap content check a day over the units the floor would auto-decide
// on a structural rung. Iteration 1 found the floor's structural rungs over-trusted on an imperfect registry: key:VN
// right 52%, key:BKR 54%, the channel rules 17–68% — the errors a SIBLING initiative of the same client, none or
// unregistered — while K's earned keys were right throughout. K2b asks a model to read those decisions, and lets it only
// say "not so sure".
//
//   1. check   every unit decided at conf ≥ τ by a floor rung (rule, key, channel, repo/path, marker, host/app, a reply or
//              twin inheriting one) goes to haiku, 25 per call, as J's card (keys2b/cards.ts) with a closed list of X, its
//              siblings, none and unregistered (keys2b/siblings.ts) — X unmarked and not always first. K's earned-key
//              decisions are not checked: they are human-earned (§3.1), and iteration 1 found them right.
//   2. veto    the check's label ≠ X → the unit keeps X but drops to conf .70: a question, 'confirm' X, grouped by its case
//              and ranked by K's value term plus a targeting yield (keys2b/veto.ts). The check's label agrees → nothing
//              changes. No valid answer (a failed call, a label off the unit's list) → nothing changes either.
//   3. target  the runner's audits stay uniform; the check's disagreements become the targeted half as questions (§K2b.3):
//              their answers are ordinary human rows that feed K's keys and the floor's rung-instance calibration, so a
//              sibling-confused instance (key:VN → shop) stops deciding after its first contradicted answer (§2.5).
//   THE INVARIANT: the check's output is never memory, never evidence (keys, calibration, thresholds, rules), never a guess
//   a person sees (the guess is X, the structural label). It only LOWERS a confidence — it can make the pipeline ask
//   more, never decide more. Every call's spend is split over the units it checked (Prediction.costUsd).
//
// Tasks t1-item and t1-fragment; the others are K+g unchanged. Without a model (ctx.llm null) K2b IS keys+g.
// Ablations (`--opt key=value`): k2bYield (on; off = K's own value term only, no targeting yield), k2bModel (haiku),
// k2bPerCall (25), tau (.95, shared with K).

import { join } from 'node:path';
import { caseKeyOf } from '../cases.js';
import { NONE, UNREGISTERED, type DayCtx, type FragmentUnit, type ItemUnit, type Prediction, type TaskId, type Unit, type Variant } from '../types.js';
import { opt } from './index.js';
import { closedList, loadPeopleDir, registryCards, type ClosedList, type PersonInfo } from './judge/cards.js';
import { seededShuffle } from './judge/text.js';
import { makeKeys } from './keys.js';
import { reachOf } from './keys/questions.js';
import { TAU } from './keys/spec.js';
import { fragmentCheckCard, itemCheckCard } from './keys2b/cards.js';
import { CHECK_MODEL, PER_CALL, runChecks, type CheckUnit } from './keys2b/check.js';
import { checkOptions, siblingIndex } from './keys2b/siblings.js';
import { VETO_CONF, VETO_PREFIX, vetoQuestions, type Vetoed } from './keys2b/veto.js';
import { stage0, type Floor, type Stage0 } from './stage0/index.js';
import { loadTenant } from './stage0/tenant.js';

const CHECKED: ReadonlySet<TaskId> = new Set<TaskId>(['t1-item', 't1-fragment']);
const STATE = 'k2b';

interface K2bState {
  people: Map<string, PersonInfo>;
  list: ClosedList; // registry lines of the closed list (J's card format)
  siblings: (x: string) => string[];
  vetoLog: Map<string, Map<string, number>>; // rung instance → local day → units the check vetoed
  vetoed: Map<string, string>; // unit id → X (to report what the answers to vetoes said; never read as evidence)
  seenRows: Set<string>;
  totals: { checked: number; vetoed: number; invalid: number; calls: number; usd: number; answered: number; overturned: number };
}

function stateOf(ctx: DayCtx, fl: Stage0, task: TaskId): K2bState {
  const cached = ctx.state.get(STATE) as K2bState | undefined;
  if (cached) return cached;
  const tenantDir = join(ctx.dir, 'tenant');
  const tenant = loadTenant(tenantDir, { subject: ctx.dataset.subject ?? null, tz: ctx.dataset.tz });
  const people = loadPeopleDir(tenantDir);
  const cards = registryCards(fl.cards(), tenantDir, ctx.dataset.labelSpace, people);
  const space = fl.labelSpace(task);
  const list = closedList(cards, space.length ? space : [...ctx.dataset.labelSpace.initiatives, NONE, UNREGISTERED], { admin: tenant.admin });
  const sources = cards.map((c) => {
    const ini = tenant.reg.get(c.id);
    return { id: c.id, umbrella: ini?.umbrella ?? c.umbrella, company: ini?.company ?? null, status: ini?.status ?? '', done: ini?.done ?? c.done, label: !(ini?.aliasOf || ini?.splitInto) };
  });
  const siblings = siblingIndex(sources, { admin: Object.values(tenant.admin), personal: tenant.personal, umbrellas: ctx.dataset.labelSpace?.umbrellas });
  const st: K2bState = { people, list, siblings, vetoLog: new Map(), vetoed: new Map(), seenRows: new Set(), totals: { checked: 0, vetoed: 0, invalid: 0, calls: 0, usd: 0, answered: 0, overturned: 0 } };
  ctx.state.set(STATE, st);
  return st;
}

/** Did the floor decide this unit (K's floor-first branch: the floor's label at ≥ τ, kept as is)? Only those are checked. */
export function structural(p: Prediction | undefined, f: Pick<Floor, 'label' | 'conf' | 'rung'>, tau: number): boolean {
  return !!p && p.label !== null && p.conf >= tau && f.label !== null && f.conf >= tau && p.label === f.label && p.rung === f.rung && f.label !== NONE && f.label !== UNREGISTERED;
}

interface Todo {
  u: Unit;
  p: Prediction;
  floor: Floor;
  weight: number;
}

export interface K2bOptions {
  name?: string;
  description?: string;
  floor?: (ctx: DayCtx) => Stage0; // the stage-0 floor (tests inject a fake)
}

export function makeK2b(o: K2bOptions = {}): Variant {
  const floorOf = o.floor ?? stage0;
  const name = o.name ?? 'k2b';
  const k = makeKeys({ name, description: 'K+g inside K2b', guess: true, floor: floorOf });
  return {
    name,
    description:
      o.description ??
      'K2b targeted verification: keys+g, plus a daily haiku content check (25/call, J cards) of every structural auto-decision against the decided initiative, its siblings, none and unregistered; a disagreement vetoes it (conf .70, confirm the structural label) — a veto, never a decision nor evidence',
    tasks: k.tasks,

    async decide(task: TaskId, units: Unit[], ctx: DayCtx): Promise<Prediction[]> {
      const preds = await k.decide(task, units, ctx);
      if (!CHECKED.has(task) || !ctx.llm || !units.length) return preds;
      const fl = floorOf(ctx);
      const tau = opt('tau', TAU);
      const st = stateOf(ctx, fl, task);
      // The pool K decided against (the day's stream, the units to decide included): the floor is memoised per unit,
      // so this reads the very decision K kept.
      const ids = new Set(ctx.pool.map((u) => u.id));
      const pool = [...ctx.pool, ...units.filter((u) => !ids.has(u.id))];
      const byId = new Map(preds.map((p) => [p.id, p]));
      const shuffle = (id: string) => (xs: string[]) => seededShuffle(xs, `k2b|${id}`);
      const todo: Todo[] = [];
      const checks: CheckUnit[] = [];
      const base = { people: st.people, subject: ctx.dataset.subject, tz: ctx.dataset.tz };
      if (task === 't1-item') {
        const items = pool as ItemUnit[];
        for (const u of units as ItemUnit[]) {
          const p = byId.get(u.id);
          const f = fl.item(u, items);
          if (!structural(p, f, tau)) continue;
          todo.push({ u, p: p!, floor: f, weight: 1 });
          checks.push({ id: u.id, decided: f.label!, options: checkOptions(f.label!, st.siblings, shuffle(u.id)), order: u.ts, card: (tag) => itemCheckCard(tag, u, { ...base, pool: items }) });
        }
      } else {
        const frags = pool as FragmentUnit[];
        const floorOfFrag = (x: FragmentUnit) => fl.fragment(x, frags);
        for (const u of units as FragmentUnit[]) {
          const p = byId.get(u.id);
          const f = floorOfFrag(u);
          if (!structural(p, f, tau)) continue;
          todo.push({ u, p: p!, floor: f, weight: u.minutes > 0 ? u.minutes : 1 });
          checks.push({ id: u.id, decided: f.label!, options: checkOptions(f.label!, st.siblings, shuffle(u.id)), order: u.start, card: (tag) => fragmentCheckCard(tag, u, { ...base, pool: frags, floorOf: floorOfFrag, tau }) });
        }
      }
      if (!checks.length) return preds;

      const r = await runChecks(ctx.llm, checks, (id) => st.list.line(id), { model: opt('k2bModel', CHECK_MODEL), perCall: opt('k2bPerCall', PER_CALL) });
      const vetoed: Vetoed[] = [];
      for (const t of todo) {
        const id = t.u.id;
        t.p.costUsd = (t.p.costUsd ?? 0) + (r.cost.get(id) ?? 0);
        const v = r.verdicts.get(id);
        if (!v || v.label === t.floor.label) continue; // agreement, or no valid answer: the floor's decision stands
        const instance = t.floor.rung;
        t.p.conf = VETO_CONF;
        t.p.rung = `${VETO_PREFIX}${instance}`;
        t.p.why = `check says ${v.label}${v.cite ? ` "${v.cite}"` : ''} ≠ ${t.floor.label} (floor ${instance})`;
        vetoed.push({ id, label: t.floor.label!, instance, case: t.floor.case || caseKeyOf(task, t.u), weight: t.weight });
        st.vetoed.set(id, t.floor.label!);
      }
      // Today's vetoes join the instance's 14-day suspicion before the questions are ranked (today included, as K's reach).
      for (const v of vetoed) {
        const log = st.vetoLog.get(v.instance) ?? new Map<string, number>();
        log.set(ctx.day, (log.get(ctx.day) ?? 0) + 1);
        st.vetoLog.set(v.instance, log);
      }
      const targeted = opt('k2bYield', 'on') !== 'off';
      const asks = vetoQuestions(vetoed, (inst) => (targeted ? reachOf(st.vetoLog.get(inst), ctx.day) : 0));
      for (const v of vetoed) {
        const a = asks.get(v.id)!;
        byId.get(v.id)!.ask = { group: a.group, value: a.value, guess: v.label, form: 'confirm' };
      }

      const usd = [...r.cost.values()].reduce((a, x) => a + x, 0);
      const tot = st.totals;
      tot.checked += checks.length;
      tot.vetoed += vetoed.length;
      tot.invalid += r.invalid.size;
      tot.calls += r.calls;
      tot.usd += usd;
      const perInstance = new Map<string, number>();
      for (const v of vetoed) perInstance.set(v.instance, (perInstance.get(v.instance) ?? 0) + 1);
      const top = [...perInstance].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 6);
      ctx.log(
        `${name} ${task} ${ctx.day}: checked ${checks.length} structural auto-decision(s) in ${r.calls} call(s) ($${usd.toFixed(4)}) → ${vetoed.length} veto(es)${top.length ? ` [${top.map(([i, n]) => `${i} ${n}`).join(', ')}]` : ''}${r.invalid.size ? `, ${r.invalid.size} without a verdict` : ''}${r.errors.length ? ` · ${r.errors.length} call error(s): ${r.errors[0]!.slice(0, 80)}` : ''}`,
      );
      return preds;
    },

    async nightly(task: TaskId, ctx: DayCtx): Promise<void> {
      await k.nightly!(task, ctx);
      const st = ctx.state.get(STATE) as K2bState | undefined;
      if (!st || !CHECKED.has(task)) return;
      // Report only: what people said about vetoed units (a measure of the check, never fed back into it or anywhere).
      for (const r of ctx.memory) {
        if (r.task !== task || r.source !== 'human' || !st.vetoed.has(r.id)) continue;
        const sig = `${r.id}\u0000${r.answer ?? r.day}`;
        if (st.seenRows.has(sig)) continue;
        st.seenRows.add(sig);
        st.totals.answered++;
        if (r.label !== st.vetoed.get(r.id)) st.totals.overturned++;
      }
      const t = st.totals;
      ctx.log(`${name} ${task} ${ctx.day} check so far: ${t.checked} checked, ${t.vetoed} vetoed, ${t.invalid} without a verdict, ${t.calls} call(s), $${t.usd.toFixed(4)} · answered vetoes ${t.answered} (X overturned ${t.overturned})`);
    },
  };
}

export const k2b: Variant = makeK2b();
