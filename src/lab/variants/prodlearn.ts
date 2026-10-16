// prodlearn — the PRODUCTION learning loop replayed on the bench: the parity check of the port (iteration 2's K2a →
// src/sources/attribution/{items,learn,learn-load}.ts). Not a contender and not a re-implementation: every decision below
// is production code, the bench only feeds it and reads it.
//
//   once per run  the dataset's frozen store is copied byte for byte into a private temp dir (the original is never
//                 opened: a frozen corpus must not even grow a -shm file), the tenant files a build reads beside it, with
//                 annotations/attribution.json's `items: {days: <window>}` switched on and `learn` off (this variant calls
//                 the learner itself). The production build of the layer then runs over the copy as of the window's last
//                 day, 18:00Z (build.ts recomputeAttribution: the fragments' plan and the stage-0 item floor, att_items),
//                 and the learner's units are loaded the way the shadow loop loads them (learn-load.ts loadLearnInputs:
//                 fragments by the ladder alone, items from att_items, typed keys, case keys, texts; the registry's
//                 initiatives). No ledger and no pins: the bench's answers are the only evidence.
//   every day     the person's answers so far — the run's memory rows of source 'human', answers AND audits with their
//                 answer ids; never a machine row — become the learner's Evidence, and learn.ts learn() runs on every
//                 production unit of the task's kind up to today (production decides and asks over the whole stream; the
//                 bench population is a subset of it). Today's bench units get the Learned row: label, conf and rung, and
//                 its question (group, value, guess, form) — the runner ranks and answers those.
//   nightly       nothing: the learner is a pure function of the evidence, re-derived from scratch on every call — that IS
//                 the production design (every build re-derives att_learn from the ledger).
//
// Ids: an item's bench id is its store ref, which is the production id. A fragment's id is the fragmenter's, and the
// fragmenter changed after some datasets were exported (recorder copies merged by call_id): only bench fragments whose id
// production still produces are decided; the rest abstain with rung 'unmatched' (the build log says how many, and how
// many of those share a ref with a production fragment). A bench unit production does not hold at all abstains the same.
//
// A tenant without attribution.json (a team tenant: the layer is off) gets one naming the dataset's subject — or, with
// none, a person id nobody carries: production's parser requires a subject, and for T1 the item floor reads the subject
// only to skip the mailbox owner's own marker, so that id behaves as "nobody's mailbox".
//
// Ablations (`--opt key=value`): prodKinds=both (the learner gets fragments AND items, as a build hands them over — a
// single-task run has evidence for its own kind only), prodPool=population (only the units the bench has handed over so
// far, not the whole stream), prodRank=queue (the person answers in the learner's own queue order, not by the bench
// members' summed values), siblingAware=off, tau.

import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readAttributionInputs, recomputeAttribution, type AttributionSummary } from '../../sources/attribution/build.js';
import { learn, type Evidence, type InitiativeInfo, type Learned, type LearnUnit } from '../../sources/attribution/learn.js';
import { loadLearnInputs, TAU } from '../../sources/attribution/learn-load.js';
import { loadPeople } from '../../sources/people.js';
import { openStore } from '../../sources/store.js';
import { readJsonl } from '../dataset.js';
import type { DatasetMeta, DayCtx, MemoryRow, Prediction, TaskId, Unit, Variant } from '../types.js';
import { opt } from './index.js';

type Kind = 'fragment' | 'item';
const KIND: Partial<Record<TaskId, Kind>> = { 't1-fragment': 'fragment', 't1-item': 'item' };

/** A subject for a tenant that names none: a valid person id no roster carries. */
export const NO_SUBJECT = 'lab-no-subject';
const DAY_MS = 86_400_000;
const daysBetween = (since: string, until: string): number => Math.round((Date.parse(`${until}T00:00:00Z`) - Date.parse(`${since}T00:00:00Z`)) / DAY_MS) + 1;

/** What one production build over the dataset hands the learner. */
export interface ProdBuild {
  units: LearnUnit[]; // every fragment of the horizon and every item of the window, as learn-load.ts loads them
  initiatives: InitiativeInfo[];
  refs: Map<string, string[]>; // production fragment id → its refs (att_fragments): what an unmatched bench id is traced by
  summary: AttributionSummary;
  window: { since: string; until: string; days: number; now: string };
}

/**
 * The production layer over a private copy of a dataset (store + tenant), as of `until` 18:00Z, with item mode on for the
 * whole window. Read-only for the dataset: the copy is written and removed again.
 */
export function buildProd(dir: string, meta: Pick<DatasetMeta, 'since' | 'until' | 'tz' | 'subject'>): ProdBuild {
  const tmp = mkdtempSync(join(tmpdir(), 'lab-prodlearn-'));
  try {
    const src = realpathSync(join(dir, 'store.sqlite'));
    const storePath = join(tmp, 'store.sqlite');
    copyFileSync(src, storePath);
    // A store left in WAL mode may hold committed pages in its -wal: they belong to the copy (the -shm is rebuilt).
    if (existsSync(`${src}-wal`) && statSync(`${src}-wal`).size > 0) copyFileSync(`${src}-wal`, `${storePath}-wal`);

    const from = join(dir, 'tenant');
    const root = join(tmp, 'tenant');
    const ann = join(root, 'annotations');
    mkdirSync(ann, { recursive: true });
    for (const f of ['initiatives.json', 'annotations/rules.json', 'annotations/people.json']) {
      if (existsSync(join(from, f))) copyFileSync(join(from, f), join(root, f));
    }
    const cfgPath = join(from, 'annotations', 'attribution.json');
    const cfg = (existsSync(cfgPath) ? JSON.parse(readFileSync(cfgPath, 'utf8')) : { subject: meta.subject || NO_SUBJECT }) as Record<string, unknown>;
    const days = Math.min(90, Math.max(1, daysBetween(meta.since, meta.until)));
    delete cfg.learn;
    cfg.items = { days };
    writeFileSync(join(ann, 'attribution.json'), `${JSON.stringify(cfg, null, 2)}\n`);

    const read = readAttributionInputs({ tenantRoot: root, annotationsDir: ann, timezone: meta.tz });
    if (!read) throw new Error('prodlearn: the tenant copy has no attribution.json');
    const people = existsSync(join(ann, 'people.json')) ? loadPeople(join(ann, 'people.json')) : [];
    const now = new Date(`${meta.until}T18:00:00.000Z`);
    const db = openStore(storePath); // the production schema on the copy (att_items, att_learn: CREATE IF NOT EXISTS)
    try {
      const summary = recomputeAttribution(db, read.inputs, people, [], now);
      if (summary.items && 'error' in summary.items) throw new Error(`prodlearn: the item floor failed: ${summary.items.error}`);
      const li = loadLearnInputs(db, read.inputs, people, [], now);
      const refs = new Map(
        (db.prepare('SELECT id, refs FROM att_fragments').all() as { id: string; refs: string }[]).map((r) => {
          let list: string[] = [];
          try {
            list = JSON.parse(r.refs) as string[];
          } catch {
            /* a malformed row traces nothing */
          }
          return [r.id, list];
        }),
      );
      return { units: li.units, initiatives: li.opts.initiatives, refs, summary, window: { since: summary.since, until: summary.until, days, now: now.toISOString() } };
    } finally {
      db.close();
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/**
 * The run's memory as the learner's Evidence — a person's rows only (answers and audits, with their answer ids and what
 * the pipeline said before), the task's own. A machine row is never evidence (learn.ts would drop it anyway).
 */
export function evidenceOf(memory: readonly MemoryRow[], task: TaskId): Evidence[] {
  return memory
    .filter((r) => r.task === task && r.source === 'human')
    .map((r) => ({
      id: r.id,
      day: r.day,
      label: r.label,
      source: 'human' as const,
      answer: r.answer || `${r.day}:unit:${r.id}`,
      ...(r.audit ? { audit: true } : {}),
      ...(r.predicted !== undefined ? { guess: r.predicted } : {}),
    }));
}

/** The production units the learner gets on `day`: the kinds asked for, nothing after that day. */
export function poolOf(units: readonly LearnUnit[], kinds: ReadonlySet<Kind>, day: string): LearnUnit[] {
  return units.filter((u) => kinds.has(u.unit) && u.day <= day);
}

const r3 = (x: number): string => x.toFixed(3);

/** One Learned row as the bench's Prediction; no row → an abstention with rung `missing`. */
export function predictionOf(id: string, l: Learned | undefined, missing = 'unmatched'): Prediction {
  if (!l) return { id, label: null, conf: 0, rung: missing };
  const why = [l.why, l.umbrella ? `umbrella=${l.umbrella}@${r3(l.umbrellaConf ?? 0)}` : ''].filter(Boolean).join(' · ');
  return {
    id,
    label: l.label,
    conf: l.label === null ? 0 : l.conf,
    rung: l.rung,
    ...(why ? { why } : {}),
    ...(l.ask ? { ask: { group: l.ask.group, value: l.ask.value, guess: l.ask.guess, form: l.ask.form } } : {}),
  };
}

/**
 * Ablation prodRank=queue: the runner ranks a day's groups by the summed `ask.value` of their BENCH members, while the
 * production routine asks the top of the learner's own queue (every unit of the stream, kinds taking turns). Rewrites the
 * values so that sum follows the queue: the group at queue position i of n carries n − i, shared by its bench members.
 */
export function queueOrder(preds: Prediction[], queue: readonly string[]): void {
  const pos = new Map(queue.map((g, i) => [g, queue.length - i]));
  const members = new Map<string, number>();
  for (const p of preds) if (p.ask?.group) members.set(p.ask.group, (members.get(p.ask.group) ?? 0) + 1);
  for (const p of preds) if (p.ask?.group) p.ask = { ...p.ask, value: (pos.get(p.ask.group) ?? 0) / members.get(p.ask.group)! };
}

export interface IdReport {
  kind: Kind;
  bench: number;
  matched: number;
  byKind: Record<string, { bench: number; matched: number }>; // fragments: call/thread/work
  sharedRef: number; // unmatched bench fragments that share a ref with a production fragment (the fragmenter re-cut them)
  dayMismatch: number; // matched ids whose production day differs from the bench day
}

/** How many bench units production holds by id — and, for fragments, how the rest relate to production's by refs. */
export function idReport(kind: Kind, bench: readonly Unit[], prod: Pick<ProdBuild, 'units' | 'refs'>): IdReport {
  const byId = new Map(prod.units.filter((u) => u.unit === kind).map((u) => [u.id, u]));
  const owner = new Set<string>();
  if (kind === 'fragment') for (const refs of prod.refs.values()) for (const r of refs) owner.add(r);
  const out: IdReport = { kind, bench: 0, matched: 0, byKind: {}, sharedRef: 0, dayMismatch: 0 };
  for (const u of bench) {
    const k = kind === 'fragment' ? String((u as { kind?: string }).kind ?? '?') : String((u as { type?: string }).type ?? '?');
    const slot = (out.byKind[k] ??= { bench: 0, matched: 0 });
    out.bench++;
    slot.bench++;
    const p = byId.get(u.id);
    if (p) {
      out.matched++;
      slot.matched++;
      if (p.day !== (u as { day: string }).day) out.dayMismatch++;
    } else if (kind === 'fragment' && ((u as { refs?: string[] }).refs ?? []).some((r) => owner.has(r))) out.sharedRef++;
  }
  return out;
}

const fmtReport = (r: IdReport): string =>
  `${r.matched}/${r.bench} bench ${r.kind} ids are production ids (${Object.entries(r.byKind)
    .map(([k, s]) => `${k} ${s.matched}/${s.bench}`)
    .join(', ')})${r.kind === 'fragment' ? `; ${r.sharedRef} of the unmatched share a ref with a production fragment` : ''}${r.dayMismatch ? `; ${r.dayMismatch} matched on another day` : ''}`;

interface State {
  build: ProdBuild;
  ms: number;
  reported: Set<TaskId>;
  seen: Set<string>; // bench ids handed to decide so far (the prodPool=population ablation)
}

export interface ProdlearnOptions {
  name?: string;
  build?: (ctx: DayCtx) => ProdBuild; // tests inject their own
}

export function makeProdlearn(o: ProdlearnOptions = {}): Variant {
  const name = o.name ?? 'prodlearn';
  const stateOf = (ctx: DayCtx): State => {
    let st = ctx.state.get('prodlearn') as State | undefined;
    if (!st) {
      const t0 = Date.now();
      const build = o.build ? o.build(ctx) : buildProd(ctx.dir, ctx.dataset);
      st = { build, ms: Date.now() - t0, reported: new Set(), seen: new Set() };
      ctx.state.set('prodlearn', st);
      const s = build.summary;
      const count = (k: Kind) => build.units.filter((u) => u.unit === k).length;
      const floor = (k: Kind) => build.units.filter((u) => u.unit === k && u.label !== null && u.conf >= TAU).length;
      ctx.log(
        `${name}: production build ${build.window.since}..${build.window.until} (now ${build.window.now}, items ${build.window.days} days) in ${st.ms} ms — fragments ${s.fragments} (${Object.entries(s.states)
          .filter(([, n]) => n)
          .map(([k, n]) => `${k} ${n}`)
          .join(', ')}), items ${s.items && !('error' in s.items) ? s.items.items : 0}; learner units: fragment ${count('fragment')} (floor at τ ${floor('fragment')}), item ${count('item')} (floor at τ ${floor('item')}); initiatives ${build.initiatives.length}`,
      );
    }
    return st;
  };

  return {
    name,
    description: 'the PRODUCTION code replayed: the stage-0 item floor and the fragment ladder of a build over a copy of the store, then learn.ts on the person’s answers each day (parity check of the port; no model)',
    tasks: ['t1-item', 't1-fragment'],

    async decide(task: TaskId, units: Unit[], ctx: DayCtx): Promise<Prediction[]> {
      const kind = KIND[task];
      if (!kind) throw new Error(`${name}: no ${task}`);
      const st = stateOf(ctx);
      if (!st.reported.has(task)) {
        st.reported.add(task);
        ctx.log(`${name} ${task}: ${fmtReport(idReport(kind, readJsonl<Unit>(join(ctx.dir, 'units', `${kind}.jsonl`)), st.build))}`);
      }
      for (const u of units) st.seen.add(u.id);
      const kinds = new Set<Kind>(opt('prodKinds', 'task') === 'both' ? ['fragment', 'item'] : [kind]);
      const all = poolOf(st.build.units, kinds, ctx.day);
      const pool = opt('prodPool', 'all') === 'population' ? all.filter((u) => st.seen.has(u.id)) : all;
      const evidence = evidenceOf(ctx.memory, task);
      const res = learn(pool, evidence, {
        tau: opt('tau', TAU),
        today: ctx.day,
        questionsPerDay: 3,
        auditShare: 0.15,
        seed: 'bench',
        initiatives: st.build.initiatives,
        siblingAware: opt('siblingAware', 'on') !== 'off',
      });
      const byId = new Map(res.units.map((l) => [l.id, l]));
      const preds = units.map((u) => predictionOf(u.id, byId.get(u.id)));
      if (opt('prodRank', 'value') === 'queue') queueOrder(preds, res.questions.map((q) => q.group));
      const matched = preds.filter((p) => p.rung !== 'unmatched').length;
      const demoted = res.calibration.filter((c) => c.demoted).map((c) => c.instance);
      const s = res.stats;
      ctx.log(
        `${name} ${task} ${ctx.day}: learner over ${pool.length} units (${matched}/${units.length} bench ids held) · evidence ${s ? `${s.used} used of ${s.evidence}, ${s.answers} answers, ${s.unknown} unknown ids, trials ${s.trials.success}/${s.trials.success + s.trials.failure} right` : evidence.length} · demoted ${demoted.length ? demoted.join(' ') : '—'} · deciding key types ${res.keyTypes.filter((k) => k.deciding).map((k) => k.type).join(' ') || '—'}`,
      );
      return preds;
    },
  };
}

export const prodlearn: Variant = makeProdlearn();
