// J "Case Judge" (design notes/10-design.md §4): the model reads, the environment decides how far to trust it.
//
//   1. Stage 0 (./stage0) decides what it can: a floor rung at conf ≥ τ stands (rung-instance calibration may
//      demote it later). Everything else is the RESIDUE.
//   2. The residue is cut into CASES — the unit a person thinks in: a call (all topics), a run-day, a work-day; a bot
//      family × day (one representative, the label fanned out to the family's items of the day); a human thread or
//      ticket; a surface form (T3); an item with ≤3 earlier messages (T4).
//   3. Each case becomes a deterministic card (judge/cards.ts) and is judged TWICE against the full closed list:
//      pass A (sonnet for fragments, haiku otherwise) and pass B (haiku, the closed list permuted, other precedents).
//      An arbiter (sonnet) settles t1 disagreements. Output is validated (one re-ask on labels off the list).
//   4. The judgment lands in a CELL — agreement × grounded cite (judge/cite.ts) — whose MEASURED precision is the
//      confidence (judge/cells.ts). Never the model's self-report.
//   5. Below τ the unit is a question: group = the case, value = Σ (minutes or 1)·(1 − conf), guess = J's label,
//      form 'confirm'.
//   Nightly: today's human rows (answers and audits; one observation per answer id per cell) update the cells and
//   join the precedent pool; stage 0 recalibrates its rung instances. Machine rows are never evidence.
//
// Without a model (ctx.llm null) J abstains on the residue and still returns the floor's decisions. Every call's
// cost is split over the units it judged (Prediction.costUsd). Ablation knobs via --opt (variants/index.ts):
//   tau (.95) · sample (1: the share of cases judged, by a hash of the case key — for cost control on big
//   populations; skipped units abstain with rung judge:sampled-out) · modelA / modelB / arbiter · casesPerCall (8) ·
//   cardsPerCall (15) · t4PerCall (25) · t3PerCall (50) · minSeen (2) · precedents (5)

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fnv1a, setKey } from '../metrics.js';
import { KINDS, NONE, SYSTEM, UNKNOWN, UNREGISTERED, type DayCtx, type FragmentUnit, type ItemUnit, type LlmLike, type MentionUnit, type Prediction, type TaskId, type Unit, type Variant } from '../types.js';
import { opt } from './index.js';
import { stage0, type Floor, type Stage0 } from './stage0/index.js';
import { closedList, fragmentCard, itemCard, loadPeopleDir, mentionCard, registryCards, renderClosedList, rosterLines, t4Card, type Card, type ClosedList, type PersonInfo } from './judge/cards.js';
import { checkCite, type CiteVerdict } from './judge/cite.js';
import { Cells, cellConf, type CellId, type CellKind } from './judge/cells.js';
import { distinctiveTokens, formatPrecedent, PrecedentPool, summaryOf, type Precedent, type Summary } from './judge/precedents.js';
import { arbiterPrompt, arbiterSystem, listPrompt, promptVersion, readLabels, readT4, reaskPrompt, t1Prompt, t1System, t3System, t4System, type Answer, type Read } from './judge/prompt.js';
import { seededShuffle } from './judge/text.js';

// --- run state (ctx.state lives exactly one variant × task run) -----------------------------------------------------

interface Proposal {
  kind: CellKind;
  cell: CellId;
  label: string;
}

export interface JudgeState {
  cells: Cells;
  pool: PrecedentPool;
  seen: Map<string, Summary>; // what is kept of every unit seen (precedents need it once an answer arrives)
  proposals: Map<string, Proposal>; // what J said per unit, by cell (nightly scores it against the answer)
  floorDecided: Map<string, string>; // unit id → the floor rung instance J kept as the decision
  churn: { keys: Map<string, string>; recurring: number; changed: number }; // label churn of recurring families/series
  memo: Map<string, string>; // T3 form memo (§2.5): an answered surface form resolves every later occurrence
  caseOf: Map<string, string>; // unit id → its case key (the memo is keyed by the form's case)
  people: Map<string, PersonInfo>;
  list?: ClosedList;
  logged: Set<string>;
}

export function judgeState(ctx: DayCtx, task: TaskId): JudgeState {
  const k = `judge:${task}`;
  let st = ctx.state.get(k) as JudgeState | undefined;
  if (!st) {
    st = { cells: new Cells(), pool: new PrecedentPool(), seen: new Map(), proposals: new Map(), floorDecided: new Map(), churn: { keys: new Map(), recurring: 0, changed: 0 }, memo: new Map(), caseOf: new Map(), people: loadPeopleDir(join(ctx.dir, 'tenant')), logged: new Set() };
    ctx.state.set(k, st);
  }
  return st;
}

type FloorLite = Floor & { participants?: string[]; cowork?: string[]; senderClass?: string; family?: string; hosts?: string[]; apps?: string[] };

const tauOf = (): number => opt('tau', 0.95);

/** The tenant's admin map (attribution.json `admin`), when it has one. */
function adminMap(dir: string): Record<string, string> | undefined {
  const f = join(dir, 'tenant', 'annotations', 'attribution.json');
  if (!existsSync(f)) return undefined;
  try {
    const a = (JSON.parse(readFileSync(f, 'utf8')) as { admin?: unknown }).admin;
    return a && typeof a === 'object' ? (a as Record<string, string>) : undefined;
  } catch {
    return undefined;
  }
}

function listOf(ctx: DayCtx, st: JudgeState, s0: Stage0, task: TaskId): ClosedList {
  if (!st.list) {
    const cards = registryCards(s0.cards(), join(ctx.dir, 'tenant'), ctx.dataset.labelSpace, st.people);
    const space = s0.labelSpace(task);
    st.list = closedList(cards, space.length ? space : [...ctx.dataset.labelSpace.initiatives, NONE, UNREGISTERED], { admin: adminMap(ctx.dir) });
  }
  return st.list;
}

const sampled = (key: string): boolean => {
  const share = opt('sample', 1);
  return share >= 1 || (fnv1a(`sample|${key}`) % 10_000) / 10_000 < share;
};

// --- model calls -----------------------------------------------------------------------------------------------------

interface PassResult extends Read {
  costs: Map<string, number>; // tag → its share of the pass's spend
}

async function callModel(llm: LlmLike, model: string, system: string, prompt: string, log: (m: string) => void): Promise<{ text: string; cost: number; error?: string }> {
  try {
    const r = await llm.call({ model, system, prompt });
    if (r.error) log(`judge: ${model} call failed: ${r.error.slice(0, 160)}`);
    return { text: r.error ? '' : r.text, cost: r.costUsd || 0, error: r.error };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log(`judge: ${model} call threw: ${msg.slice(0, 160)}`);
    return { text: '', cost: 0, error: msg };
  }
}

const spread = (costs: Map<string, number>, tags: readonly string[], usd: number): void => {
  if (!tags.length || !usd) return;
  for (const t of tags) costs.set(t, (costs.get(t) ?? 0) + usd / tags.length);
};

/** One pass with its one re-ask (design §4.5): a label off the list, or a unit left out, is asked again once. */
async function pass(llm: LlmLike, model: string, system: string, prompt: string, tags: string[], read: (text: string, tags: string[]) => Read, log: (m: string) => void): Promise<PassResult> {
  const costs = new Map<string, number>();
  const r1 = await callModel(llm, model, system, prompt, log);
  spread(costs, tags, r1.cost);
  if (r1.error) return { ok: new Map(), bad: new Map(tags.map((t) => [t, 'model error'])), costs };
  const first = read(r1.text, tags);
  if (!first.bad.size) return { ...first, costs };
  const again = [...first.bad.keys()];
  const r2 = await callModel(llm, model, system, reaskPrompt(prompt, first.bad), log);
  spread(costs, again, r2.cost);
  if (r2.error) return { ...first, costs };
  const second = read(r2.text, again);
  for (const [t, a] of second.ok) first.ok.set(t, a);
  return { ok: first.ok, bad: second.bad, costs };
}

// --- t1: fragments and items -----------------------------------------------------------------------------------------

interface CaseUnit {
  tag: string;
  u: Unit;
  floor: FloorLite;
  fan: Unit[]; // the units this tag's judgment covers (itself first; a bot family's items of the day)
}

interface T1Case {
  key: string;
  kind: CellKind;
  units: CaseUnit[];
  card: Card;
  summary: Summary;
  prec: { a: Precedent[]; b: Precedent[] };
}

interface Judged {
  label: string | null;
  conf: number;
  rung: string;
  why: string;
  cost: number;
  cell?: CellId;
  kind?: CellKind;
}

/**
 * Content-defined batches: cut after an element whose key hashes to 0 mod `size` (mean batch = size), or at 3×size.
 * Adding or removing one element changes only its own batch, so the call cache survives a floor that moves the
 * residue a little (t3/t4 cards do not depend on the floor at all).
 */
export function stableBatches<T>(xs: readonly T[], key: (x: T) => string, size: number): T[][] {
  const out: T[][] = [];
  let cur: T[] = [];
  for (const x of xs) {
    cur.push(x);
    if (cur.length >= 3 * size || fnv1a(`cut|${key(x)}`) % Math.max(1, size) === 0) {
      out.push(cur);
      cur = [];
    }
  }
  if (cur.length) out.push(cur);
  return out;
}

const tagger = () => {
  let n = 0;
  return () => `u${++n}`;
};

/** People whose exclusive or narrow marker holds the label: naming them supports it. A broad marker (one person on a
 *  dozen initiatives) supports nothing in particular. Stage 0's cards write "Name (narrow)"; the name is what a cite carries. */
function markerNames(label: string, list: ClosedList, people: ReadonlyMap<string, PersonInfo>): string[] {
  const names = new Set(
    (list.cards.get(label)?.people ?? [])
      .filter((n) => !/\(broad\)\s*$/.test(n))
      .map((n) => n.replace(/\s*\([^)]*\)\s*$/, '')),
  );
  for (const p of people.values()) if (p.marker && p.marker.type !== 'broad' && p.marker.initiatives.includes(label)) names.add(p.name);
  return [...names];
}

function verdict(a: Answer | undefined, c: T1Case, shown: Precedent[], list: ClosedList, people: ReadonlyMap<string, PersonInfo>): CiteVerdict {
  if (!a) return { grounded: false, why: 'no answer' };
  return checkCite(a.cite, {
    fields: { ...c.card.fields, precedent: shown.map(formatPrecedent).join('\n') },
    labelTokens: list.tokens(a.label),
    markerNames: markerNames(a.label, list, people),
    precedentTokens: distinctiveTokens(shown, a.label),
  });
}

async function judgeT1(ctx: DayCtx, st: JudgeState, list: ClosedList, cases: T1Case[], cfg: { modelA: string; modelB: string; perCall: number }): Promise<Map<string, Judged>> {
  const out = new Map<string, Judged>();
  const llm = ctx.llm!;
  const canon = (l: string): string | null => {
    if (list.ids.includes(l)) return l;
    const low = l.toLowerCase();
    return list.ids.find((x) => x.toLowerCase() === low) ?? null;
  };
  const sysA = t1System(renderClosedList(list));
  const sysB = t1System(renderClosedList(list, seededShuffle(list.ids, `B|${ctx.dataset.name}`)));
  const sysR = arbiterSystem(renderClosedList(list));
  const pv = promptVersion(sysA);
  const once = (k: string, m: string) => {
    if (!st.logged.has(k)) ctx.log(m);
    st.logged.add(k);
  };
  once(`pv:${pv}`, `judge: prompt_v A ${pv} · B ${promptVersion(sysB)} · arbiter ${promptVersion(sysR)} (closed list ${list.ids.length} ids)`);
  const read = (text: string, tags: string[]) => readLabels(text, tags, canon);

  // Passes A and B per batch of cases, concurrently (the runner meters and caps concurrency).
  const batches: T1Case[][] = [];
  for (let i = 0; i < cases.length; i += cfg.perCall) batches.push(cases.slice(i, i + cfg.perCall));
  const A = new Map<string, Answer>();
  const B = new Map<string, Answer>();
  const costs = new Map<string, number>();
  const addCosts = (m: Map<string, number>) => {
    for (const [t, usd] of m) costs.set(t, (costs.get(t) ?? 0) + usd);
  };
  await Promise.all(
    batches.map(async (batch) => {
      const tags = batch.flatMap((c) => c.units.map((x) => x.tag));
      const prompt = (which: 'a' | 'b') => t1Prompt(batch.map((c) => ({ card: c.card.text, precedents: c.prec[which].map(formatPrecedent), tags: c.units.map((x) => x.tag) })));
      const [ra, rb] = await Promise.all([pass(llm, cfg.modelA, sysA, prompt('a'), tags, read, ctx.log), pass(llm, cfg.modelB, sysB, prompt('b'), tags, read, ctx.log)]);
      for (const [t, a] of ra.ok) A.set(t, a);
      for (const [t, b] of rb.ok) B.set(t, b);
      addCosts(ra.costs);
      addCosts(rb.costs);
    }),
  );

  // The arbiter, on disagreements only: ≤10 units per call, grouped by case; the option order is seeded per unit.
  const disputes = cases.flatMap((c) => c.units.filter((x) => A.get(x.tag) && B.get(x.tag) && A.get(x.tag)!.label !== B.get(x.tag)!.label).map((x) => ({ c, tag: x.tag })));
  const R = new Map<string, Answer>();
  if (disputes.length) {
    const arbiter = opt('arbiter', 'sonnet');
    const chunks: (typeof disputes)[] = [];
    for (let i = 0; i < disputes.length; i += 10) chunks.push(disputes.slice(i, i + 10));
    await Promise.all(
      chunks.map(async (chunk) => {
        const byCase = new Map<T1Case, string[]>();
        for (const d of chunk) byCase.set(d.c, [...(byCase.get(d.c) ?? []), d.tag]);
        const prompt = arbiterPrompt(
          [...byCase.entries()].map(([c, tags]) => ({
            card: c.card.text,
            disputes: tags.map((tag) => {
              const two: [string, string] = [A.get(tag)!.label, B.get(tag)!.label];
              return { tag, options: fnv1a(`${ctx.day}|${tag}|arb`) % 2 ? [two[1], two[0]] : two };
            }),
          })),
        );
        const tags = chunk.map((d) => d.tag);
        const r = await callModel(llm, arbiter, sysR, prompt, ctx.log);
        spread(costs, tags, r.cost);
        if (r.error) return;
        for (const [t, a] of read(r.text, tags).ok) R.set(t, a);
      }),
    );
  }

  // Cells → confidence.
  for (const c of cases) {
    for (const x of c.units) {
      const a = A.get(x.tag);
      const b = B.get(x.tag);
      const r = R.get(x.tag);
      const vA = verdict(a, c, c.prec.a, list, st.people);
      const vB = verdict(b, c, c.prec.b, list, st.people);
      let cell: CellId | null = null;
      let label: string | null = null;
      let why = '';
      if (a && b && a.label === b.label) {
        label = a.label;
        cell = label === NONE ? 'AA-none' : label === UNREGISTERED ? 'AA-unreg' : vA.grounded || vB.grounded ? 'AA+g' : 'AA';
        why = `A=B ${label} · cite ${vA.grounded ? vA.why : vB.grounded ? vB.why : vA.why}`;
      } else if (a && b) {
        const vR = r ? checkCite(r.cite, { fields: c.card.fields, labelTokens: list.tokens(r.label), markerNames: markerNames(r.label, list, st.people) }) : { grounded: false, why: 'no arbiter' };
        if (r && (r.label === a.label || r.label === b.label)) {
          label = r.label;
          cell = vR.grounded ? 'AR+g' : 'AR';
        } else {
          label = r?.label ?? a.label;
          cell = list.umbrellaOf(a.label) === list.umbrellaOf(b.label) ? 'UU' : 'XX';
        }
        why = `A ${a.label} · B ${b.label} · R ${r?.label ?? '—'} · cite ${vR.why}`;
      } else if (a || b) {
        label = (a ?? b)!.label;
        cell = 'SP';
        why = `only ${a ? 'A' : 'B'}: ${label}`;
      }
      const cost = costs.get(x.tag) ?? 0;
      if (!cell || !label) {
        for (const f of x.fan) out.set(f.id, { label: null, conf: 0, rung: 'judge:invalid', why: 'no valid answer after the re-ask', cost: cost / x.fan.length });
        continue;
      }
      const conf = cellConf(st.cells, c.kind, cell, {
        precedentAgrees: c.prec.a[0]?.label === label,
        inCandidates: x.floor.candidates.includes(label),
        candidatesMiss: x.floor.candidates.length > 0 && !x.floor.candidates.includes(label),
      });
      for (const f of x.fan) out.set(f.id, { label, conf, rung: `judge:${cell}`, why: `${why} · pv ${pv}`, cost: cost / x.fan.length, cell, kind: c.kind });
    }
  }
  return out;
}

function fragmentCases(ctx: DayCtx, st: JudgeState, s0: Stage0, residue: FragmentUnit[], floors: Map<string, FloorLite>, tau: number): T1Case[] {
  const pool = (ctx.pool as FragmentUnit[]).filter((p) => 'kind' in p && 'minutes' in p);
  const memo = new Map<string, FloorLite>(floors);
  const floorOf = (u: FragmentUnit): FloorLite => {
    let f = memo.get(u.id);
    if (!f) memo.set(u.id, (f = s0.fragment(u, pool)));
    return f;
  };
  const byCase = new Map<string, FragmentUnit[]>();
  for (const u of residue) {
    const k = floors.get(u.id)!.case;
    byCase.set(k, [...(byCase.get(k) ?? []), u]);
  }
  const next = tagger();
  const keys = [...byCase.keys()].sort((a, b) => byCase.get(a)![0]!.start.localeCompare(byCase.get(b)![0]!.start) || a.localeCompare(b));
  return keys.map((key) => {
    const us = byCase.get(key)!.sort((a, b) => a.start.localeCompare(b.start) || a.id.localeCompare(b.id));
    const units = us.map((u) => ({ tag: next(), u, floor: floors.get(u.id)!, fan: [u] as Unit[] }));
    const card = fragmentCard({ key, units: units.map((x) => ({ tag: x.tag, u: x.u as FragmentUnit, floor: x.floor })), pool, floorOf, caseOf: (p) => floorOf(p).case, people: st.people, subject: ctx.dataset.subject, tz: ctx.dataset.tz, tau });
    const summary = summaryOf('t1-fragment', us[0]!, ctx.dataset.subject);
    const k = opt('precedents', 5);
    return { key, kind: us[0]!.kind as CellKind, units, card, summary, prec: st.pool.forPasses(summary, `${ctx.day}|${key}`, new Set(), k) };
  });
}

function itemCases(ctx: DayCtx, st: JudgeState, residue: ItemUnit[], floors: Map<string, FloorLite>): T1Case[] {
  const pool = (ctx.pool as ItemUnit[]).filter((p) => 'ts' in p && 'isBot' in p);
  const byThread = new Map<string, ItemUnit[]>();
  for (const p of pool) if (p.thread) byThread.set(p.thread, [...(byThread.get(p.thread) ?? []), p]);
  const groups = new Map<string, { bot: boolean; us: ItemUnit[] }>();
  for (const u of residue) {
    const f = floors.get(u.id)!;
    const bot = !!f.senderClass && f.senderClass !== 'human';
    const key = bot ? `family:${f.family ?? u.id}:${u.day}` : f.case;
    const g = groups.get(key) ?? { bot, us: [] };
    g.us.push(u);
    groups.set(key, g);
  }
  const next = tagger();
  const keys = [...groups.keys()].sort((a, b) => groups.get(a)!.us[0]!.ts.localeCompare(groups.get(b)!.us[0]!.ts) || a.localeCompare(b));
  const out: T1Case[] = [];
  for (const key of keys) {
    const g = groups.get(key)!;
    const us = g.us.sort((a, b) => a.ts.localeCompare(b.ts) || a.id.localeCompare(b.id));
    // A bot family is judged once (its first item today); a human thread up to 8 units per card.
    const chunks: ItemUnit[][] = g.bot ? [[us[0]!]] : [];
    if (!g.bot) for (let i = 0; i < us.length; i += 8) chunks.push(us.slice(i, i + 8));
    chunks.forEach((chunk, ci) => {
      const units: CaseUnit[] = chunk.map((u) => ({ tag: next(), u, floor: floors.get(u.id)!, fan: g.bot ? us : [u] }));
      const first = chunk[0]!;
      const f0 = floors.get(first.id)!;
      const seen = new Set(chunk.map((u) => u.id));
      const earlier = [
        ...(first.context ?? []).map((m) => ({ id: m.ref, author: m.author, ts: m.ts, text: m.text })),
        ...(byThread.get(first.thread ?? '') ?? []).filter((p) => p.ts < first.ts && !seen.has(p.id)).map((p) => ({ id: p.id, author: p.author, ts: p.ts, text: p.text })),
      ];
      const uniq = [...new Map(earlier.map((m) => [m.id, m])).values()].sort((a, b) => a.ts.localeCompare(b.ts));
      const thread = uniq.length > 6 ? [uniq[0]!, ...uniq.slice(-5)] : uniq;
      const card = itemCard({
        key,
        units: units.map((x) => ({ tag: x.tag, u: x.u as ItemUnit, floor: x.floor })),
        ...(g.bot ? { family: { size: us.length, sender: first.author ?? first.authorPerson ?? '?', hosts: f0.hosts ?? [], apps: f0.apps ?? [] } } : {}),
        thread,
        people: st.people,
        subject: ctx.dataset.subject,
        tz: ctx.dataset.tz,
      });
      const summary = summaryOf('t1-item', first, ctx.dataset.subject);
      const k = opt('precedents', 5);
      out.push({ key: chunks.length > 1 ? `${key}#${ci}` : key, kind: g.bot ? 'item-bot' : 'item-human', units, card, summary, prec: st.pool.forPasses(summary, `${ctx.day}|${key}`, new Set(), k) });
    });
  }
  return out;
}

// --- t4: kind and addressee -------------------------------------------------------------------------------------------

async function judgeT4(ctx: DayCtx, st: JudgeState, task: TaskId, judged: ItemUnit[]): Promise<Map<string, Judged>> {
  const out = new Map<string, Judged>();
  const llm = ctx.llm!;
  const roster = ctx.dataset.labelSpace.people.length ? ctx.dataset.labelSpace.people : [...st.people.keys()];
  const rosterSet = new Set(roster);
  const sysA = t4System(KINDS, rosterLines(roster, st.people, false));
  const sysB = t4System(seededShuffle(KINDS, `B|kinds|${ctx.dataset.name}`), rosterLines(seededShuffle(roster, `B|roster|${ctx.dataset.name}`), st.people, false));
  const pv = promptVersion(sysA);
  if (!st.logged.has(pv)) ctx.log(`judge: t4 prompt_v A ${pv} · B ${promptVersion(sysB)}`);
  st.logged.add(pv);
  const per = opt('t4PerCall', 25);
  const sorted = [...judged].sort((a, b) => a.ts.localeCompare(b.ts) || a.id.localeCompare(b.id));
  const read = (text: string, tags: string[]) => readT4(text, tags, rosterSet, task === 't4-kind' ? 'kind' : 'addressee');
  const modelA = opt('modelA', 'haiku');
  const modelB = opt('modelB', 'haiku');
  await Promise.all(
    stableBatches(sorted, (u) => u.id, per).map(async (batch) => {
      const tags = batch.map((_, i) => `u${i + 1}`);
      const cards = batch.map((u, i) => t4Card(tags[i]!, u, st.people, ctx.dataset.tz));
      const prompt = listPrompt(
        cards.map((c) => c.text),
        tags,
        'messages',
      );
      const [ra, rb] = await Promise.all([pass(llm, modelA, sysA, prompt, tags, read, ctx.log), pass(llm, modelB, sysB, prompt, tags, read, ctx.log)]);
      batch.forEach((u, i) => {
        const tag = tags[i]!;
        const a = ra.ok.get(tag);
        const b = rb.ok.get(tag);
        const cost = (ra.costs.get(tag) ?? 0) + (rb.costs.get(tag) ?? 0);
        if (!a && !b) {
          out.set(u.id, { label: null, conf: 0, rung: 'judge:invalid', why: 'no valid answer after the re-ask', cost });
          return;
        }
        let cell: CellId;
        let label: string;
        let why: string;
        const kind: CellKind = task === 't4-kind' ? 't4' : 't4-addr';
        if (task === 't4-kind') {
          const fields = { ...cards[i]!.fields };
          const g = (x?: Answer) => (x ? checkCite(x.cite, { fields, labelTokens: [], markerNames: [], kind: x.label }) : { grounded: false, why: 'none' });
          if (a && b && a.label === b.label) {
            const vA = g(a);
            const vB = g(b);
            cell = vA.grounded || vB.grounded ? 'AA+g' : 'AA';
            label = a.label;
            why = `A=B ${label} · cue ${vA.grounded ? vA.why : vB.why}`;
          } else if (a && b) {
            cell = 'XX';
            label = a.label;
            why = `A ${a.label} · B ${b.label}`;
          } else {
            cell = 'SP';
            label = (a ?? b)!.label;
            why = `only ${a ? 'A' : 'B'}`;
          }
        } else {
          const set = (x?: Answer): string => (!x || x.addressee === 'none' || !x.addressee?.length ? NONE : setKey(x.addressee));
          if (a && b && set(a) === set(b)) {
            label = set(a);
            cell = label === NONE ? 'AA-none' : 'AA';
            why = `A=B ${label}`;
          } else if (a && b) {
            label = set(a);
            cell = 'XX';
            why = `A ${set(a)} · B ${set(b)}`;
          } else {
            label = set(a ?? b);
            cell = 'SP';
            why = `only ${a ? 'A' : 'B'}`;
          }
        }
        out.set(u.id, { label, conf: cellConf(st.cells, kind, cell), rung: `judge:${cell}`, why: `${why} · pv ${pv}`, cost, cell, kind });
      });
    }),
  );
  return out;
}

// --- t3: identity (people exact: only 'system' may auto-decide) -------------------------------------------------------

async function judgeT3(ctx: DayCtx, st: JudgeState, forms: { key: string; rep: MentionUnit; fan: MentionUnit[] }[], tau: number): Promise<Map<string, Judged>> {
  const out = new Map<string, Judged>();
  const llm = ctx.llm!;
  const roster = ctx.dataset.labelSpace.people.length ? ctx.dataset.labelSpace.people : [...st.people.keys()];
  const rosterSet = new Set(roster);
  const sysA = t3System(rosterLines(roster, st.people, true));
  const sysB = t3System(rosterLines(seededShuffle(roster, `B|roster|${ctx.dataset.name}`), st.people, true));
  const pv = promptVersion(sysA);
  // 'system' | 'unknown' | 'person:<id>[+<id>…]' → the bench's label: system | unknown | <id>[+<id>…] (sorted)
  const canon = (l: string): string | null => {
    const x = l.trim();
    if (x.toLowerCase() === SYSTEM) return SYSTEM;
    if (x.toLowerCase() === UNKNOWN) return UNKNOWN;
    const ids = x.replace(/^person:/i, '').split('+').map((s) => s.trim().replace(/^person:/i, ''));
    return ids.length && ids.every((id) => rosterSet.has(id)) ? [...new Set(ids)].sort().join('+') : null;
  };
  const per = opt('t3PerCall', 50);
  const modelA = opt('modelA', 'haiku');
  const modelB = opt('modelB', 'haiku');
  const read = (text: string, tags: string[]) => readLabels(text, tags, canon);
  await Promise.all(
    stableBatches(forms, (f) => f.key, per).map(async (batch) => {
      const tags = batch.map((_, i) => `u${i + 1}`);
      const cards = batch.map((f, i) => mentionCard(tags[i]!, f.rep));
      const prompt = listPrompt(
        cards.map((c) => c.text),
        tags,
        'names',
      );
      const [ra, rb] = await Promise.all([pass(llm, modelA, sysA, prompt, tags, read, ctx.log), pass(llm, modelB, sysB, prompt, tags, read, ctx.log)]);
      batch.forEach((f, i) => {
        const tag = tags[i]!;
        const a = ra.ok.get(tag);
        const b = rb.ok.get(tag);
        const cost = ((ra.costs.get(tag) ?? 0) + (rb.costs.get(tag) ?? 0)) / f.fan.length;
        let res: Judged;
        if (!a && !b) res = { label: null, conf: 0, rung: 'judge:invalid', why: 'no valid answer after the re-ask', cost };
        else {
          let cell: CellId;
          const label = (a ?? b)!.label;
          if (a && b && a.label === b.label) cell = label === SYSTEM ? 'AA-sys' : label === UNKNOWN ? 'AA-unk' : 'AA-person';
          else if (a && b) cell = 'XX';
          else cell = 'SP';
          let conf = cellConf(st.cells, 't3', cell);
          // People exact (design §4.1): only 'system' may auto-decide; a person is always a confirm question.
          if (label !== SYSTEM) conf = Math.min(conf, tau - 0.02);
          res = { label, conf, rung: `judge:${cell}`, why: `A ${a?.label ?? '—'} · B ${b?.label ?? '—'} · pv ${pv}`, cost, cell, kind: 't3' };
        }
        for (const m of f.fan) out.set(m.id, res);
      });
    }),
  );
  return out;
}

// --- the variant -------------------------------------------------------------------------------------------------

const minutesOf = (u: Unit): number => ('minutes' in u && typeof u.minutes === 'number' && u.minutes > 0 ? u.minutes : 1);

function question(u: Unit, group: string, label: string | null, conf: number): Prediction['ask'] {
  return { group, value: Math.round(minutesOf(u) * (1 - conf) * 1000) / 1000, guess: label, form: label ? 'confirm' : 'choose' };
}

/** The floor's decision, kept as is (its rung instance is what the nightly calibration scores). */
function keepFloor(st: JudgeState, u: Unit, f: Floor): Prediction {
  st.floorDecided.set(u.id, f.rung);
  return { id: u.id, label: f.label, conf: f.conf, rung: f.rung, why: f.hint ? `floor · ${f.hint.slice(0, 80)}` : 'floor', ask: question(u, f.case, f.label, f.conf) };
}

function fromJudged(st: JudgeState, u: Unit, group: string, j: Judged | undefined, fallback: string): Prediction {
  if (!j) return { id: u.id, label: null, conf: 0, rung: fallback, ask: question(u, group, null, 0) };
  if (j.cell && j.kind && j.label) st.proposals.set(u.id, { kind: j.kind, cell: j.cell, label: j.label });
  return { id: u.id, label: j.label, conf: j.conf, rung: j.rung, costUsd: j.cost, why: j.why, ask: question(u, group, j.label, j.conf) };
}

function noteChurn(st: JudgeState, key: string, label: string | null): void {
  if (!label) return;
  const prev = st.churn.keys.get(key);
  if (prev !== undefined) {
    st.churn.recurring++;
    if (prev !== label) st.churn.changed++;
  }
  st.churn.keys.set(key, label);
}

type FloorFactory = (ctx: DayCtx) => Stage0;

async function decide(floor: FloorFactory, task: TaskId, units: Unit[], ctx: DayCtx): Promise<Prediction[]> {
  const s0 = floor(ctx);
  const st = judgeState(ctx, task);
  const tau = tauOf();
  for (const p of ctx.pool) if (!st.seen.has(p.id)) st.seen.set(p.id, summaryOf(task, p, ctx.dataset.subject));

  switch (task) {
    case 't2-dedup': {
      const m = s0.dedup(units as ItemUnit[]);
      return units.map((u) => {
        const d = m.get(u.id);
        return d ? { id: u.id, label: d.cluster, conf: d.conf, rung: 'floor:dedup' } : { id: u.id, label: u.id, conf: 1, rung: 'floor:singleton' };
      });
    }

    case 't1-fragment': {
      const frags = units as FragmentUnit[];
      const pool = (ctx.pool as FragmentUnit[]).filter((p) => 'minutes' in p);
      const floors = new Map<string, FloorLite>(frags.map((u) => [u.id, s0.fragment(u, pool)]));
      const residue = frags.filter((u) => floors.get(u.id)!.conf < tau || !floors.get(u.id)!.label);
      const judged = residue.filter((u) => sampled(floors.get(u.id)!.case));
      let res = new Map<string, Judged>();
      if (ctx.llm && judged.length) {
        const list = listOf(ctx, st, s0, task);
        const cases = fragmentCases(ctx, st, s0, judged, floors, tau);
        res = await judgeT1(ctx, st, list, cases, { modelA: opt('modelA', 'sonnet'), modelB: opt('modelB', 'haiku'), perCall: opt('casesPerCall', 8) });
      }
      const judgedIds = new Set(judged.map((u) => u.id));
      return frags.map((u) => {
        const f = floors.get(u.id)!;
        if (f.label && f.conf >= tau) return keepFloor(st, u, f);
        const p = fromJudged(st, u, f.case, res.get(u.id), !ctx.llm ? 'judge:no-llm' : judgedIds.has(u.id) ? 'judge:invalid' : 'judge:sampled-out');
        if (u.kind === 'call') noteChurn(st, `series:${summaryOf(task, u).series}`, p.label);
        return p;
      });
    }

    case 't1-item': {
      const items = units as ItemUnit[];
      const pool = (ctx.pool as ItemUnit[]).filter((p) => 'isBot' in p);
      const floors = new Map<string, FloorLite>(items.map((u) => [u.id, s0.item(u, pool)]));
      const groupOf = (u: ItemUnit): string => {
        const f = floors.get(u.id)!;
        return f.senderClass && f.senderClass !== 'human' ? `family:${f.family ?? u.id}:${u.day}` : f.case;
      };
      const residue = items.filter((u) => floors.get(u.id)!.conf < tau || !floors.get(u.id)!.label);
      const judged = residue.filter((u) => sampled(groupOf(u)));
      let res = new Map<string, Judged>();
      if (ctx.llm && judged.length) {
        const list = listOf(ctx, st, s0, task);
        const cases = itemCases(ctx, st, judged, floors);
        const per = opt('cardsPerCall', 15);
        res = await judgeT1(ctx, st, list, cases, { modelA: opt('modelA', 'haiku'), modelB: opt('modelB', 'haiku'), perCall: per });
      }
      const judgedIds = new Set(judged.map((u) => u.id));
      return items.map((u) => {
        const f = floors.get(u.id)!;
        if (f.label && f.conf >= tau) return keepFloor(st, u, f);
        const p = fromJudged(st, u, groupOf(u), res.get(u.id), !ctx.llm ? 'judge:no-llm' : judgedIds.has(u.id) ? 'judge:invalid' : 'judge:sampled-out');
        if (f.senderClass && f.senderClass !== 'human' && f.family) noteChurn(st, `family:${f.family}`, p.label);
        return p;
      });
    }

    case 't4-kind':
    case 't4-addressee': {
      const items = units as ItemUnit[];
      const floors = new Map<string, Floor>(items.map((u) => [u.id, task === 't4-kind' ? s0.kind(u) : s0.addressee(u)]));
      // Incoming = not the subject's own. The design said "incoming HUMAN items" while the floor still called every
      // bot/bulk/system item noise at .95; stage 0 now leaves some of them open on purpose (a firing alert .90, a bot
      // post with an incident or request cue), so J judges whatever non-subject item the floor leaves below τ.
      const incoming = (u: ItemUnit): boolean => u.fromSubject !== true;
      // t4-addressee: the floor's explicit addressee stands; `none` and implicit replies go to the judge.
      const open = (u: ItemUnit): boolean => {
        const f = floors.get(u.id)!;
        if (!f.label || f.conf < tau) return true;
        return task === 't4-addressee' && (f.label === NONE || /implicit/.test(f.rung));
      };
      const judged = items.filter((u) => open(u) && incoming(u) && sampled(floors.get(u.id)!.case));
      let res = new Map<string, Judged>();
      if (ctx.llm && judged.length) res = await judgeT4(ctx, st, task, judged);
      const judgedIds = new Set(judged.map((u) => u.id));
      return items.map((u) => {
        const f = floors.get(u.id)!;
        if (!open(u)) return keepFloor(st, u, f);
        if (!incoming(u)) return f.label ? { id: u.id, label: f.label, conf: f.conf, rung: f.rung, ask: question(u, f.case, f.label, f.conf) } : { id: u.id, label: null, conf: 0, rung: 'judge:not-incoming', ask: question(u, f.case, null, 0) };
        return fromJudged(st, u, f.case, res.get(u.id), !ctx.llm ? 'judge:no-llm' : judgedIds.has(u.id) ? 'judge:invalid' : 'judge:sampled-out');
      });
    }

    case 't3-identity': {
      const ms = units as MentionUnit[];
      const floors = new Map<string, Floor>(ms.map((u) => [u.id, s0.mention(u)]));
      for (const [id, f] of floors) st.caseOf.set(id, f.case);
      const minSeen = opt('minSeen', 2);
      const forms = new Map<string, MentionUnit[]>();
      for (const u of ms) {
        const f = floors.get(u.id)!;
        if ((f.label && f.conf >= tau) || st.memo.has(f.case)) continue;
        forms.set(f.case, [...(forms.get(f.case) ?? []), u]);
      }
      const todo = [...forms.entries()]
        .filter(([key, us]) => us.some((u) => u.seen >= minSeen) && sampled(key))
        .map(([key, us]) => {
          const fan = us.sort((a, b) => a.day.localeCompare(b.day) || a.id.localeCompare(b.id));
          return { key, rep: fan[0]!, fan };
        })
        .sort((a, b) => a.key.localeCompare(b.key));
      let res = new Map<string, Judged>();
      if (ctx.llm && todo.length) res = await judgeT3(ctx, st, todo, tau);
      const judgedIds = new Set(todo.flatMap((t) => t.fan.map((m) => m.id)));
      return ms.map((u) => {
        const f = floors.get(u.id)!;
        if (f.label && f.conf >= tau) return keepFloor(st, u, f);
        // The form memo: a person already answered this surface form (a human row, never a machine one).
        const known = st.memo.get(f.case);
        if (known) return { id: u.id, label: known, conf: 0.99, rung: 'memo:form', why: 'answered form', ask: question(u, f.case, known, 0.99) };
        const fallback = !ctx.llm ? 'judge:no-llm' : judgedIds.has(u.id) ? 'judge:invalid' : u.seen < minSeen ? 'judge:once' : 'judge:sampled-out';
        const p = fromJudged(st, u, f.case, res.get(u.id), fallback);
        // A judge that abstains still has the floor's below-τ guess for the question.
        if (!p.label && f.label) p.ask = question(u, f.case, f.label, f.conf);
        return p;
      });
    }
  }
}

const same = (task: TaskId, a: string, b: string): boolean => (task === 't4-addressee' ? setKey(a === NONE ? [] : a.split('|')) === setKey(b === NONE ? [] : b.split('|')) : a === b);

async function nightly(floor: FloorFactory, task: TaskId, ctx: DayCtx): Promise<void> {
  const st = judgeState(ctx, task);
  const rows = ctx.memory.filter((r) => r.day === ctx.day && r.task === task && (r.source === 'human' || r.source === 'seed'));
  // 1. Cells: one observation per answer id per cell (the share of its units the cell got right).
  const obs = new Map<string, { kind: CellKind; cell: CellId; right: number[] }>();
  for (const r of rows) {
    const p = st.proposals.get(r.id);
    if (!p) continue;
    const k = `${r.answer ?? `${r.day}:${r.id}`}|${p.kind}|${p.cell}`;
    const o = obs.get(k) ?? { kind: p.kind, cell: p.cell, right: [] };
    o.right.push(same(task, p.label, r.label) ? 1 : 0);
    obs.set(k, o);
  }
  for (const o of obs.values()) st.cells.observe(o.kind, o.cell, o.right.reduce((a, x) => a + x, 0) / o.right.length);
  // 2. Precedents: today's human answers join the pool (never machine rows).
  for (const r of rows) {
    const s = st.seen.get(r.id);
    if (s) st.pool.add(r.id, r.label, r.day, r.source === 'seed' ? 'seed' : 'human', s);
  }
  // T3: the form memo — an answered surface form resolves every later occurrence of it (§2.5; people.json in prod).
  if (task === 't3-identity') for (const r of rows) if (r.source === 'human' && st.caseOf.has(r.id)) st.memo.set(st.caseOf.get(r.id)!, r.label);
  // 3. Rung-instance calibration of the floor (§2.5) from the same human rows.
  floor(ctx).calibrate(
    rows.filter((r) => r.source === 'human'),
    st.floorDecided,
  );
  if (obs.size) {
    const t = st.cells.table().map((c) => `${c.kind}|${c.cell} ${c.a.toFixed(1)}/${c.b.toFixed(1)}→${c.mean.toFixed(3)}`);
    ctx.log(`judge nightly ${ctx.day}: ${obs.size} cell observation(s); precedents ${st.pool.size}; cells ${t.join(', ')}`);
  }
  if (st.churn.recurring) ctx.log(`judge churn: ${st.churn.changed}/${st.churn.recurring} recurring keys changed label`);
}

/** J over a given floor (tests inject a fixed one; the bench uses stage 0 as it stands). */
export function makeJudge(floor: FloorFactory = stage0, name = 'judge'): Variant {
  return {
    name,
    description: 'J "Case Judge": the stage-0 floor, then two model passes over cases against the full closed list; confidence = the measured precision of the agreement × cite cell (design §4)',
    tasks: ['t1-fragment', 't1-item', 't2-dedup', 't3-identity', 't4-kind', 't4-addressee'],
    decide: (task, units, ctx) => decide(floor, task, units, ctx),
    nightly: (task, ctx) => nightly(floor, task, ctx),
  };
}

export const judge: Variant = makeJudge();
