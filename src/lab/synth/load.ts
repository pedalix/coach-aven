// The bench-agency loader: rendered plan → raw/ → the REAL store build (store.ts buildStore, exactly as the daemon
// runs it: people, ledger, Slack directory, the GIVEN tenant's attribution layer with a pins file, a fixed clock) →
// acceptance → the real-store exporter (export.ts, kind 'synthetic') → gold written from the plan's truth.
//
// Why through the production build and exporter instead of writing units directly: the bench must see exactly what
// production would — the store's own refs, thread ids, person resolution, call clustering, fragment ids and ladder —
// so a variant that wins here wins on the same inputs it would get live. The truth only decides the LABELS.
//
// Gold (tier 'synthetic', exact by construction), keyed by the exporter's unit ids:
//   t1-fragment  the majority truth initiative over the fragment's refs (equal weight per ref, split by share); a
//                call topic (#n) takes its planned topic; 'none' refs count only when nothing else does (a greeting
//                in a work run does not make the run private); other initiatives holding ≥ 25 % are alts
//   t1-item, t4  the population the silver labeller uses (label.ts selectUnits): items not from the subject — human
//                ones plus the 10 % bot sample — so synthetic and real numbers are measured on the same kind of stream
//   t2-dedup     every item: its planned cluster (a singleton is its own family)
//   t3-identity  every mention, by the occurrence the exporter kept (the truth of THAT raw string on THAT record);
//                people outside the GIVEN roster are 'unknown' (a new person), machines 'system'
//   t4-addressee setKey of the roster people who must act, else 'none'
// 'unregistered:<topic>' truth is the bench label 'unregistered' (the slug stays in the note).

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { buildStore, openReadOnly, type BuildSummary } from '../../sources/store.js';
import { readJsonl, saveMeta, writeJsonl } from '../dataset.js';
import { exportDataset } from '../export.js';
import { botSampled } from '../label.js';
import { setKey } from '../metrics.js';
import { NONE, SYSTEM, UNKNOWN, UNREGISTERED, type DatasetMeta, type FragmentUnit, type GoldRow, type ItemUnit, type MentionUnit, type TaskId } from '../types.js';
import { benchKind, buildPlan } from './plan.js';
import { writeRaw, writeTenant } from './raw.js';
import type { RenderedItem } from './render.js';
import type { Plan, PlannedItem, Share, TruthItemRow, World } from './types.js';

/** The committed fixture: the rendered plan (gzip) + world.json — enough to rebuild the dataset without a model. */
export const FIXTURE_DIR = fileURLToPath(new URL('../fixtures/bench-agency/', import.meta.url));

export function readFixture(dir = FIXTURE_DIR): { items: RenderedItem[]; world: World } {
  const text = gunzipSync(readFileSync(join(dir, 'plan.rendered.jsonl.gz'))).toString('utf8');
  const items = text.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l) as RenderedItem);
  return { items, world: JSON.parse(readFileSync(join(dir, 'world.json'), 'utf8')) as World };
}

// --- consistency with the planner ---------------------------------------------------------------------------

/** A rendered item as the planner wrote it (texts not yet filled) — what must match buildPlan(seed). */
export function skeleton(it: RenderedItem): string {
  const { call: _call, ...rest } = it;
  void _call;
  const planned = it.render.mode === 'template';
  return JSON.stringify({ ...rest, text: planned ? it.text : null, rendered: planned });
}

/** Rendered items that differ from the plan they claim to render (first few), or [] when they match. */
export function planMismatches(items: readonly RenderedItem[], plan: Plan, max = 5): string[] {
  const out: string[] = [];
  if (items.length !== plan.items.length) out.push(`${items.length} rendered items, the plan has ${plan.items.length}`);
  const byId = new Map(plan.items.map((i) => [i.id, i]));
  for (const it of items) {
    const p = byId.get(it.id);
    if (!p) out.push(`${it.id} is not in the plan`);
    else if (skeleton(it) !== JSON.stringify(p)) out.push(`${it.id} differs from the plan`);
    if (out.length >= max) break;
  }
  return out;
}

// --- gold from truth (pure) ------------------------------------------------------------------------------------

export const benchInitiative = (id: string): string => (id.startsWith(`${UNREGISTERED}:`) ? UNREGISTERED : id);

/** Shares (any number of sources, each summing to 1) → label, ≥ 25 % alts and normalised shares; null for nothing. */
export function t1FromShares(parts: readonly Share[][]): { label: string; alts: string[]; shares: { label: string; share: number }[]; notes: string[] } | null {
  const work = parts.filter((p) => p.length);
  const use = work.length ? work : parts.length ? [[{ id: NONE, share: 1 }]] : [];
  if (!use.length) return null;
  const acc = new Map<string, number>();
  const notes = new Set<string>();
  for (const p of use) {
    const total = p.reduce((a, s) => a + s.share, 0) || 1;
    for (const s of p) {
      const id = benchInitiative(s.id);
      if (id !== s.id) notes.add(s.id);
      acc.set(id, (acc.get(id) ?? 0) + s.share / total / use.length);
    }
  }
  const ranked = [...acc].sort((a, b) => b[1] - a[1]);
  return {
    label: ranked[0]![0],
    alts: ranked.slice(1).filter(([id, s]) => s >= 0.25 && id !== NONE).map(([id]) => id),
    shares: ranked.map(([label, share]) => ({ label, share: Math.round(share * 1000) / 1000 })),
    notes: [...notes],
  };
}

/** A person truth ('a', 'a+b', 'system') in the bench's identity vocabulary against the GIVEN roster. */
export function identityGold(truth: string, roster: ReadonlySet<string>): string {
  if (truth === 'system') return SYSTEM;
  const ids = truth.split('+').map((p) => (roster.has(p) ? p : UNKNOWN));
  return [...new Set(ids)].sort().join('+');
}

/** The silver labeller's t1-item / t4 population (label.ts selectUnits): not the subject's; humans + the bot sample. */
export const inItemPopulation = (u: ItemUnit): boolean => u.fromSubject !== true && (!u.isBot || botSampled(u.id));

export interface GoldStats {
  rows: Record<string, number>;
  skipped: Record<string, number>;
}

export function goldFromTruth(
  units: { fragment: readonly FragmentUnit[]; item: readonly ItemUnit[]; mention: readonly MentionUnit[] },
  items: readonly PlannedItem[],
  truthRows: readonly TruthItemRow[],
  roster: ReadonlySet<string>,
): { gold: Record<TaskId, GoldRow[]>; stats: GoldStats } {
  const byRef = new Map<string, PlannedItem>();
  for (const it of items) {
    byRef.set(it.ref, it);
    if (it.altRef) byRef.set(it.altRef, it);
  }
  const topicRow = new Map(truthRows.filter((r) => r.unit === 'meeting_topic').map((r) => [r.ref, r]));
  const gold: Record<TaskId, GoldRow[]> = { 't1-fragment': [], 't1-item': [], 't2-dedup': [], 't3-identity': [], 't4-kind': [], 't4-addressee': [] };
  const stats: GoldStats = { rows: {}, skipped: {} };
  const skip = (k: string) => (stats.skipped[k] = (stats.skipped[k] ?? 0) + 1);
  const row = (task: TaskId, r: Omit<GoldRow, 'task' | 'tier'>) => gold[task].push({ ...r, task, tier: 'synthetic' });
  const t1Row = (task: TaskId, id: string, l: NonNullable<ReturnType<typeof t1FromShares>>, note: string) =>
    row(task, { id, label: l.label, ...(l.alts.length ? { alts: l.alts } : {}), ...(l.shares.length > 1 ? { shares: l.shares } : {}), note: [note, ...l.notes].filter(Boolean).join('; ') });
  const sharesOf = (it: PlannedItem): Share[] => (it.truth.label === NONE ? [] : it.truth.shares);

  for (const u of units.fragment) {
    const n = /#(\d+)$/.exec(u.id)?.[1];
    const meetingRefs = u.refs.filter((r) => r.startsWith('meeting:'));
    const topic = u.kind === 'call' && n ? meetingRefs.map((r) => topicRow.get(`${r}#${n}`)).find(Boolean) : undefined;
    if (topic) {
      t1Row('t1-fragment', u.id, t1FromShares([topic.initiatives])!, `call topic ${n}: ${topic.plan}`);
      continue;
    }
    // A call is its recording; refs of a greeting run attached to it do not vote.
    const refs = u.kind === 'call' && meetingRefs.length ? meetingRefs : u.refs;
    const its = refs.map((r) => byRef.get(r)).filter((x): x is PlannedItem => !!x);
    if (!its.length) {
      skip('t1-fragment: no planned ref');
      continue;
    }
    t1Row('t1-fragment', u.id, t1FromShares(its.map(sharesOf))!, `${its.length}/${u.refs.length} refs`);
  }

  for (const u of units.item) {
    const it = byRef.get(u.id);
    if (!it) {
      skip('item: not in the plan');
      continue;
    }
    const t = it.truth;
    row('t2-dedup', { id: u.id, label: t.cluster, ...(t.dedupType ? { note: `${t.dedupType}${t.canonical ? ' (canonical)' : ''}` } : {}) });
    if (!inItemPopulation(u)) continue;
    t1Row('t1-item', u.id, t1FromShares([sharesOf(it)])!, `decidable by ${t.decidableBy}`);
    if (!t.kind) continue;
    row('t4-kind', { id: u.id, label: benchKind(t.kind), ...(t.kind === 'answer' || t.noiseType ? { note: t.kind === 'answer' ? 'answer' : t.noiseType } : {}) });
    const to = (t.addressee?.to ?? []).filter((p) => roster.has(p));
    const outside = (t.addressee?.to ?? []).filter((p) => !roster.has(p));
    if (outside.length && !to.length) {
      skip('t4-addressee: only people outside the roster');
      continue;
    }
    const how = t.addressee ? [t.addressee.addressing, t.addressee.agent ? 'to the agent' : '', t.addressee.broadcast ? 'broadcast' : '', t.addressee.side ? `side ${t.addressee.side}` : '', outside.length ? `also ${outside.join(', ')} (not in the roster)` : ''].filter(Boolean).join(', ') : '';
    row('t4-addressee', { id: u.id, label: to.length ? setKey(to) : NONE, ...(how ? { note: how } : {}) });
  }

  for (const u of units.mention) {
    const it = byRef.get(u.ref);
    const occ = it?.truth.identities.find((o) => o.raw === u.raw && o.field === u.field) ?? it?.truth.identities.find((o) => o.raw === u.raw);
    if (!occ) {
      skip('t3: no truth for the occurrence');
      continue;
    }
    row('t3-identity', { id: u.id, label: identityGold(occ.truth, roster), note: `${occ.form}, expected ${occ.expected}${occ.ambiguous ? `, ambiguous ${occ.ambiguous.join('/')}` : ''}${occ.truth.split('+').some((p) => p !== 'system' && !roster.has(p)) ? `, truth ${occ.truth}` : ''}` });
  }
  for (const [task, rows] of Object.entries(gold)) stats.rows[task] = rows.length;
  return { gold, stats };
}

/** Write synthetic rows into gold/<task>.jsonl, keeping every other tier (the exporter's rule rows, silver labels). */
export function mergeGold(dir: string, task: TaskId, rows: readonly GoldRow[]): number {
  const path = join(dir, 'gold', `${task}.jsonl`);
  const keep = readJsonl<GoldRow>(path).filter((r) => r.tier !== 'synthetic');
  const all = [...keep, ...rows].sort((a, b) => a.id.localeCompare(b.id) || a.tier.localeCompare(b.tier));
  writeJsonl(path, all);
  return all.length;
}

// --- acceptance -------------------------------------------------------------------------------------------------

export interface Acceptance {
  ok: boolean;
  failures: string[];
  counts: Record<string, number>;
}

/** The built store against the plan: nothing malformed, every truth ref where it should be, calls as planned. */
export function accept(storePath: string, sum: BuildSummary, plan: Plan): Acceptance {
  const failures: string[] = [];
  const fail = (m: string) => failures.length < 40 && failures.push(m);
  const counts: Record<string, number> = {};
  if (sum.malformed) fail(`${sum.malformed} malformed raw lines`);
  if (sum.skippedFiles.length) fail(`skipped raw files: ${sum.skippedFiles.join(', ')}`);
  if (sum.attribution && typeof sum.attribution === 'object' && 'error' in sum.attribution) fail(`attribution layer: ${sum.attribution.error}`);
  const of = (type: PlannedItem['type']) => plan.items.filter((i) => i.type === type);
  const db = openReadOnly(storePath);
  try {
    const rows = <T>(sql: string) => db.prepare(sql).all() as T[];
    const msgs = new Map(rows<{ ref: string; deleted: number; thread_id: string; author_person: string | null }>('SELECT ref, deleted, thread_id, author_person FROM messages').map((r) => [r.ref, r]));
    const tasks = new Map(rows<{ ref: string; comments: string; deleted: number }>('SELECT ref, comments, deleted FROM tasks').map((r) => [r.ref, r]));
    const meetings = new Map(rows<{ ref: string; call_id: string | null; deleted: number }>('SELECT ref, call_id, deleted FROM meetings').map((r) => [r.ref, r]));
    const events = new Map(rows<{ ref: string; deleted: number }>('SELECT ref, deleted FROM events').map((r) => [r.ref, r]));
    const activity = new Map(rows<{ ref: string; deleted: number }>('SELECT ref, deleted FROM activity').map((r) => [r.ref, r]));
    const live = new Set<string>();
    let missing = 0;
    for (const it of plan.items) {
      let found: { deleted: number } | undefined;
      if (it.type === 'message') found = msgs.get(it.ref);
      else if (it.type === 'task') found = tasks.get(it.ref);
      else if (it.type === 'meeting') found = meetings.get(it.ref);
      else if (it.type === 'event') found = events.get(it.ref);
      else if (it.type === 'activity') found = activity.get(it.ref);
      else {
        const [task, cid] = it.ref.split('#c');
        const t = tasks.get(task!);
        const ids = t ? (JSON.parse(t.comments || '[]') as { id?: unknown }[]).map((c) => String(c.id)) : [];
        found = t && ids.includes(cid!) ? { deleted: t.deleted } : undefined;
      }
      if (!found) {
        missing++;
        fail(`${it.id}: ${it.ref} is not in the store`);
        continue;
      }
      if (Boolean(found.deleted) !== it.truth.deleted) fail(`${it.id}: deleted=${found.deleted}, truth says ${it.truth.deleted}`);
      if (!found.deleted) live.add(it.ref);
      if (it.type === 'message' && !it.truth.deleted && msgs.get(it.ref)!.thread_id !== it.threadId) fail(`${it.id}: thread ${msgs.get(it.ref)!.thread_id}, planned ${it.threadId}`);
    }
    counts.planned_refs = plan.items.length;
    counts.missing_refs = missing;
    // Truth files point only at refs that exist.
    const refs = new Set(plan.items.map((i) => i.ref));
    const ids = new Set(plan.items.map((i) => i.id));
    let dangling = 0;
    let keptByIds = 0;
    for (const d of plan.truth.dedup) for (const m of d.members) if (!refs.has(m)) dangling++;
    for (const r of plan.truth.items) {
      if (r.answered_by && !refs.has(r.answered_by)) dangling++;
      // truth/items.jsonl carries a commitment's keptBy as a plan id (truth/commitments.jsonl as a ref): both resolve.
      for (const c of r.commitments ?? []) {
        if (!c.keptBy || refs.has(c.keptBy)) continue;
        if (ids.has(c.keptBy)) keptByIds++;
        else dangling++;
      }
    }
    for (const c of plan.truth.commitments) if (!refs.has(c.ref) || (c.keptBy && !refs.has(c.keptBy))) dangling++;
    counts.dangling_truth_refs = dangling;
    counts.kept_by_plan_ids = keptByIds;
    if (dangling) fail(`${dangling} truth rows point at refs the plan does not have`);
    // Calls: copies of one planned call share one call id — two for a designed split trap — and never another call's.
    const callOf = new Map<string, Set<string>>();
    const owner = new Map<string, string>();
    for (const it of of('meeting')) {
      const cid = meetings.get(it.ref)?.call_id ?? `none:${it.ref}`;
      const set = callOf.get(it.meeting!.call) ?? new Set<string>();
      set.add(cid);
      callOf.set(it.meeting!.call, set);
      const prev = owner.get(cid);
      if (prev && prev !== it.meeting!.call) fail(`call ${cid} holds copies of ${prev} and ${it.meeting!.call}`);
      owner.set(cid, it.meeting!.call);
    }
    for (const [call, ids] of callOf) {
      const trap = plan.items.some((i) => i.meeting?.call === call && i.truth.noise.includes('call_split_trap'));
      if (ids.size !== (trap ? 2 : 1)) fail(`${call}: ${ids.size} store calls, planned ${trap ? '2 (split trap)' : 1}`);
    }
    counts.planned_calls = callOf.size;
    counts.store_calls = Number((db.prepare('SELECT count(*) AS n FROM calls').get() as { n: number }).n);
    // Thread sizes (live messages).
    const threadN = new Map(rows<{ thread_id: string; n: number }>('SELECT thread_id, n FROM threads').map((r) => [r.thread_id, r.n]));
    const planned = new Map<string, number>();
    for (const it of of('message')) if (!it.truth.deleted) planned.set(it.threadId, (planned.get(it.threadId) ?? 0) + 1);
    let badThreads = 0;
    for (const [tid, n] of planned) if ((threadN.get(tid) ?? 0) !== n) badThreads++;
    counts.threads = planned.size;
    if (badThreads) fail(`${badThreads} threads with a size other than planned`);
    // People: every author the truth calls "mapped" resolves to that person; nothing else resolves to its truth.
    let wrongAuthor = 0;
    for (const it of of('message')) {
      if (it.truth.deleted) continue;
      const o = it.truth.identities.find((x) => x.field === 'author');
      const got = msgs.get(it.ref)?.author_person ?? null;
      if (o?.expected === 'mapped' ? got !== o.truth : o && got === o.truth) wrongAuthor++;
    }
    counts.author_resolution_mismatches = wrongAuthor;
    if (wrongAuthor) fail(`${wrongAuthor} message authors resolve against the identity truth`);
    counts.messages = msgs.size;
    counts.tasks = tasks.size;
    counts.meetings = meetings.size;
    counts.events = events.size;
    counts.activity = activity.size;
    counts.live_refs = live.size;
  } finally {
    db.close();
  }
  return { ok: failures.length === 0, failures, counts };
}

// --- the build ------------------------------------------------------------------------------------------------

export interface LoadOpts {
  rendered: string | null; // plan.rendered.jsonl; null = the committed fixture
  world: string | null; // world.json beside it; null = the fixture's
  dataset: string; // output dataset dir ($LAB_DIR/datasets/bench-agency)
  seed?: number; // the plan seed the rendered plan was made from (1)
  log?: (msg: string) => void;
}

export interface LoadResult {
  ok: boolean;
  failures: string[];
  summary: Record<string, unknown>;
}

export async function buildBenchAgency(o: LoadOpts): Promise<LoadResult> {
  const log = o.log ?? (() => {});
  const src = o.rendered ? { items: readJsonl<RenderedItem>(o.rendered), world: JSON.parse(readFileSync(o.world ?? join(resolve(o.rendered, '..'), 'world.json'), 'utf8')) as World } : readFixture();
  const { items, world } = src;
  const plan = buildPlan(o.seed ?? 1);
  const failures: string[] = [];
  const mism = planMismatches(items, plan);
  if (mism.length) return { ok: false, failures: [`the rendered plan does not match plan.ts (seed ${o.seed ?? 1}) — re-render: ${mism.join('; ')}`], summary: {} };
  const unrendered = items.filter((i) => !i.rendered || i.text === null).map((i) => i.id);
  if (unrendered.length) return { ok: false, failures: [`${unrendered.length} items have no text (${unrendered.slice(0, 5).join(', ')}…) — finish \`lab synth render\``], summary: {} };

  const out = resolve(o.dataset);
  const build = join(out, 'build');
  rmSync(build, { recursive: true, force: true }); // a clean build: the store ingests from byte offsets
  const rawDir = join(build, 'raw');
  const tenantDir = join(build, 'tenant');
  const storePath = join(build, 'store.sqlite');
  const pinsPath = join(build, 'pins.jsonl');
  const raw = writeRaw(rawDir, items, world);
  writeTenant(tenantDir, world);
  const ann = join(tenantDir, 'annotations');
  const now = new Date(world.now);
  const sum = buildStore({
    slug: world.slug, rawDir, storePath, peoplePath: join(ann, 'people.json'), fragmentsPath: join(ann, 'fragments.jsonl'),
    attribution: { tenantRoot: tenantDir, annotationsDir: ann, timezone: world.tz, pinsPath }, timezone: world.tz, now: () => now, log,
  });
  log(`store ${storePath}: ${sum.lines} lines, ${sum.messages} messages, ${sum.tasks} task states, ${sum.meetings} meetings, ${sum.calls} calls, ${sum.events} events, ${sum.activity} activity; malformed ${sum.malformed}`);
  const acc = accept(storePath, sum, plan);
  failures.push(...acc.failures);
  log(`acceptance: ${acc.ok ? 'ok' : `${acc.failures.length} failures`} ${JSON.stringify(acc.counts)}`);

  // The truth beside the build (diagnostics: decidable_by, noise tags, dedup types) — never a variant input.
  writeJsonl(join(build, 'truth', 'items.jsonl'), plan.truth.items);
  writeJsonl(join(build, 'truth', 'dedup.jsonl'), plan.truth.dedup);
  writeJsonl(join(build, 'truth', 'identities.jsonl'), plan.truth.identities);
  writeJsonl(join(build, 'truth', 'commitments.jsonl'), plan.truth.commitments);
  writeJsonl(join(build, 'truth', 'patterns.jsonl'), plan.truth.patterns);

  let meta: DatasetMeta | null = null;
  let exportError: string | null = null;
  try {
    meta = await exportDataset({
      name: 'bench-agency', kind: 'synthetic', source: { store: storePath, tenantDir, pinsPath }, outDir: out,
      until: world.until, since: world.since, itemsWindowDays: 28, tz: world.tz, now, tenant: world.slug, log,
    });
  } catch (e) {
    exportError = e instanceof Error ? e.message : String(e);
    failures.push(`export: ${exportError}`);
  }
  const roster = new Set<string>(meta?.labelSpace.people ?? world.people.filter((p) => p.given).map((p) => p.id));
  const units = exportError
    ? { fragment: [], mention: [], item: plan.items.filter((i) => ['message', 'task', 'comment', 'meeting'].includes(i.type) && !i.truth.deleted).map((i) => ({ id: i.ref, isBot: !i.truth.human, fromSubject: i.truth.fromSubject }) as ItemUnit) }
    : { fragment: readJsonl<FragmentUnit>(join(out, 'units', 'fragment.jsonl')), item: readJsonl<ItemUnit>(join(out, 'units', 'item.jsonl')), mention: readJsonl<MentionUnit>(join(out, 'units', 'mention.jsonl')) };
  const { gold, stats } = goldFromTruth(units, plan.items, plan.truth.items, roster);
  const files: Record<string, number> = {};
  for (const [task, rows] of Object.entries(gold) as [TaskId, GoldRow[]][]) files[task] = mergeGold(out, task, rows);
  if (meta) {
    meta.notes = `${meta.notes ?? ''}; synthetic gold from the plan's truth (tier synthetic): t1-fragment by the majority truth initiative over refs (call topics: the planned topic), t1-item/t4 on the silver labeller's population (not the subject's; humans + the 10 % bot sample), t2 every item (planned clusters), t3 every mention (truth of the kept occurrence; outside the GIVEN roster = unknown); 'unregistered:<topic>' truth = unregistered. Raw, tenant, store and truth in build/.`;
    saveMeta(out, meta);
  }
  const summary = {
    dataset: out,
    source: o.rendered ? resolve(o.rendered) : `${FIXTURE_DIR}plan.rendered.jsonl.gz`,
    raw,
    store: { lines: sum.lines, malformed: sum.malformed, messages: sum.messages, tasks: sum.tasks, meetings: sum.meetings, calls: sum.calls, events: sum.events, activity: sum.activity, tombstones: sum.tombstones, people: sum.people, attribution: sum.attribution },
    acceptance: acc,
    export: exportError ? { error: exportError } : meta?.counts,
    gold: { synthetic: stats.rows, skipped: stats.skipped, files },
  };
  mkdirSync(build, { recursive: true });
  writeFileSync(join(build, 'build.json'), `${JSON.stringify(summary, null, 2)}\n`);
  if (!existsSync(join(out, 'meta.json'))) failures.push('no meta.json written');
  return { ok: failures.length === 0, failures, summary };
}
