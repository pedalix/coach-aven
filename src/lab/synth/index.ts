// `lab synth plan|render|build|all` — the bench-agency pipeline (BENCH ONLY: `render` calls a model through
// ../llm.ts on the owner's machine; nothing here is imported outside src/lab).
//
//   plan    plan.ts writePlan → <dir>/{plan.jsonl, world.json, tenant/, truth/} (deterministic for a seed)
//   render  the plan's human beats → <dir>/plan.rendered.jsonl (+ render.json): Opus, cached per prompt, so a
//           re-run costs nothing and a resumed one asks only what is missing
//   build   plan.rendered.jsonl → raw/ → the real buildStore → acceptance → exportDataset → gold from truth, in
//           <dataset>; without a rendered plan under <dir> it falls back to the committed fixture
//           (src/lab/fixtures/bench-agency), so the dataset rebuilds without a single model call
//   all     plan, render, build
//   fixture <dir>/plan.rendered.jsonl + world.json → src/lab/fixtures/bench-agency (gzip; the committed copy `build`
//           falls back to — fictional data only, so it may live in the public repo)
//
// <dir> defaults to $LAB_DIR/synth/bench-agency and <dataset> to $LAB_DIR/datasets/bench-agency (LAB_DIR defaults to
// data/lab, gitignored). The model token comes from LAB_CLAUDE_TOKEN, else CLAUDE_CODE_OAUTH_TOKEN in LAB_ENV_FILE
// (default ./.env); LAB_CONCURRENCY (default 6) caps parallel calls.

import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { readJsonl, writeJsonl } from '../dataset.js';
import { benchToken, LlmRunner } from '../llm.js';
import { buildBenchAgency, FIXTURE_DIR, planMismatches } from './load.js';
import { buildPlan, writePlan } from './plan.js';
import { BATCH_LIMITS, batchPrompt, meetingPrompt, planBatches, renderPlan, SYSTEM_CHAT, SYSTEM_MEETING, type RenderedItem } from './render.js';
import type { PlannedItem, World } from './types.js';

const USAGE = `usage: lab synth plan|render|build|all|fixture [--dir <synth dir>] [--dataset <dir>] [--seed 1]
  render: [--only <batch or item id,…>] [--limit <n batches>] [--dry] [--model opus]
  build:  [--fixture] (use the committed fixture even when <dir> has a rendered plan)`;

const labDir = (): string => process.env.LAB_DIR || join('data', 'lab');

function readPlan(dir: string): { items: PlannedItem[]; world: World } {
  const planPath = join(dir, 'plan.jsonl');
  if (!existsSync(planPath)) throw new Error(`no plan at ${planPath} — run \`lab synth plan\` first`);
  return { items: readJsonl<PlannedItem>(planPath), world: JSON.parse(readFileSync(join(dir, 'world.json'), 'utf8')) as World };
}

async function render(dir: string, v: { only?: string; limit?: string; dry?: boolean; model?: string }, log: (m: string) => void): Promise<void> {
  const { items, world } = readPlan(dir);
  const dayOf = (iso: string) => new Intl.DateTimeFormat('en-CA', { timeZone: world.tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));
  const batches = planBatches(items, BATCH_LIMITS, dayOf);
  const only = v.only ? new Set(v.only.split(',').map((s) => s.trim()).filter(Boolean)) : null;
  const limit = v.limit !== undefined ? Number(v.limit) : undefined;
  const chosen = new Set(batches.filter((b, i) => (!only || only.has(b.id) || b.convs.some((c) => c.items.some((id) => only.has(id)))) && (limit === undefined || i < limit)).map((b) => b.id));
  if (v.dry) {
    const byId = new Map(items.map((i) => [i.id, i]));
    const ctx = { world, byId, textOf: (id: string) => (byId.get(id)?.render.mode === 'template' ? (byId.get(id)!.text ?? undefined) : undefined) };
    for (const b of batches.filter((x) => chosen.has(x.id))) {
      const meeting = b.kind === 'meeting';
      process.stdout.write(`===== ${b.id} (${b.convs.length} conversations)\n--- system ---\n${meeting ? SYSTEM_MEETING : SYSTEM_CHAT}\n--- prompt ---\n${meeting ? meetingPrompt(byId.get(b.convs[0]!.items[0]!)!, ctx) : batchPrompt(b, ctx)}\n`);
    }
    log(`${chosen.size}/${batches.length} batches (dry run, no calls)`);
    return;
  }
  // Texts of an earlier run stay when their beat is unchanged — the cache would replay them anyway, this also
  // survives a lost cache file.
  const outPath = join(dir, 'plan.rendered.jsonl');
  const planSpec = new Map(items.map((i) => [i.id, JSON.stringify(i.render)]));
  const prior = new Map<string, RenderedItem>();
  for (const r of readJsonl<RenderedItem>(outPath)) if (r.rendered && planSpec.get(r.id) === JSON.stringify(r.render)) prior.set(r.id, r);
  const runner = new LlmRunner({
    token: benchToken(process.env.LAB_ENV_FILE || '.env'),
    configDir: join(labDir(), '.claude-cfg'),
    cacheFile: join(labDir(), 'cache', 'synth-render.jsonl'),
    concurrency: Number(process.env.LAB_CONCURRENCY) || 6,
  });
  const { items: out, stats } = await renderPlan(items, world, { llm: runner, model: v.model ?? 'opus', only: (b) => chosen.has(b.id), prior, log });
  writeJsonl(outPath, out);
  const { reports, ...summary } = stats;
  writeFileSync(join(dir, 'render.json'), `${JSON.stringify({ ...summary, freshUsd: runner.spentUsd, reports }, null, 2)}\n`);
  log(`rendered ${stats.rendered}/${stats.batches} batches (${chosen.size} selected), ${stats.calls} calls (${stats.cachedCalls} cached), ${stats.retried} retried, ${stats.patchedBeats} beats patched, $${stats.costUsd.toFixed(2)} recorded ($${runner.spentUsd.toFixed(2)} fresh); ${stats.missing} human items still without text${stats.failed.length ? `; failed: ${stats.failed.join(', ')}` : ''}`);
  log(`wrote ${resolve(outPath)}`);
}

export async function main(argv: string[]): Promise<void> {
  const args = argv[0] === 'synth' ? argv.slice(1) : argv;
  const [cmd, ...rest] = args;
  const s = { type: 'string' } as const;
  const { values: v } = parseArgs({ args: rest, options: { dir: s, dataset: s, seed: s, only: s, limit: s, model: s, dry: { type: 'boolean' }, fixture: { type: 'boolean' } }, strict: true, allowPositionals: false });
  const dir = v.dir ?? join(labDir(), 'synth', 'bench-agency');
  const dataset = v.dataset ?? join(labDir(), 'datasets', 'bench-agency');
  const seed = Number(v.seed ?? 1);
  const log = (m: string) => void process.stderr.write(`${m}\n`);
  if (!Number.isInteger(seed)) throw new Error(USAGE);
  const plan = () => {
    const c = writePlan(dir, seed);
    log(`plan ${resolve(dir)}: ${c.volumes ? JSON.stringify(c.volumes) : ''} · ${c.toRender.total} to render · ${c.lines} raw lines · hash ${c.hash}`);
  };
  const build = async () => {
    const rendered = join(dir, 'plan.rendered.jsonl');
    const useFixture = v.fixture || !existsSync(rendered);
    const r = await buildBenchAgency({ rendered: useFixture ? null : rendered, world: useFixture ? null : join(dir, 'world.json'), dataset, log });
    log(JSON.stringify(r.summary, null, 2));
    if (!r.ok) throw new Error(`acceptance failed: ${r.failures.join('; ')}`);
  };
  if (cmd === 'fixture') {
    const rendered = readJsonl<RenderedItem>(join(dir, 'plan.rendered.jsonl'));
    const missing = rendered.filter((i) => !i.rendered).length;
    if (!rendered.length || missing) throw new Error(`${join(dir, 'plan.rendered.jsonl')}: ${rendered.length ? `${missing} items without text` : 'missing'} — render first`);
    // Only a render of THIS plan and world may become the public fixture: a stale render would bring back whatever
    // the planner has since changed — a name made fictional, for one.
    const current = buildPlan(seed);
    const world = JSON.stringify(JSON.parse(readFileSync(join(dir, 'world.json'), 'utf8')));
    const stale = [...planMismatches(rendered, current), ...(world === JSON.stringify(current.world) ? [] : ['world.json differs from world.ts'])];
    if (stale.length) throw new Error(`${dir} does not render the current plan (seed ${seed}) — run \`lab synth plan\` and render again: ${stale.join('; ')}`);
    mkdirSync(FIXTURE_DIR, { recursive: true });
    const gz = join(FIXTURE_DIR, 'plan.rendered.jsonl.gz');
    writeFileSync(gz, gzipSync(readFileSync(join(dir, 'plan.rendered.jsonl')), { level: 9 }));
    copyFileSync(join(dir, 'world.json'), join(FIXTURE_DIR, 'world.json'));
    const bytes = statSync(gz).size + statSync(join(FIXTURE_DIR, 'world.json')).size;
    log(`fixture ${FIXTURE_DIR}: ${rendered.length} items, ${(bytes / 1e6).toFixed(2)} MB`);
    if (bytes > 3e6) throw new Error('the fixture is over 3 MB');
    return;
  }
  if (cmd === 'plan') return plan();
  if (cmd === 'render') return render(dir, v, log);
  if (cmd === 'build') return build();
  if (cmd === 'all') {
    plan();
    await render(dir, v, log);
    return build();
  }
  throw new Error(`${cmd ? `unknown synth command "${cmd}"\n` : ''}${USAGE}\n(fixture: ${FIXTURE_DIR})`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((e: unknown) => {
    process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
    process.exitCode = 1;
  });
}
