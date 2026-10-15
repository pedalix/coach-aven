#!/usr/bin/env -S npx tsx
// The bench CLI — `npm run lab -- <cmd>`. BENCH ONLY: it may call a model on the host (llm.ts), which
// production never does; nothing outside src/lab imports it (imports.test.ts).
//
//   run     --dataset <name|dir> [--variant baseline[,other]] [--task <t>|all] [--mode static|replay]
//           [--memory none|oracle|loop] [--q 10] [--threshold 0] [--population gold|all]
//           [--tiers human,opus] [--level initiative|umbrella] [--floor 0.95] [--no-llm] [--run <name>]
//           → runs every variant × task, scores it, saves runs/<run>/…, prints the summary table
//   report  --run <name> [--out file] [--tiers …] [--level umbrella] [--floor 0.95]
//   list    → the datasets under LAB_DIR/datasets with unit and gold counts
//   export | label | synth …  → main(argv) of ./export.js, ./label.js, ./synth/index.js
//
// Environment: LAB_DIR (default data/lab, gitignored — never the live daemon's data dir); the model token
// from LAB_CLAUDE_TOKEN, else CLAUDE_CODE_OAUTH_TOKEN in LAB_ENV_FILE (default ./.env); LAB_CONCURRENCY (4).
// The model runner is built on the first call, so a run whose variants never call one needs no token.

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { goldFor, loadDataset, readJsonl, unitsFor, type Dataset } from './dataset.js';
import { benchToken, LlmRunner } from './llm.js';
import { renderReport, renderSummary, type ReportEntry } from './report.js';
import { labDir, loadRun, noteVariants, resultDir, runDir, runTask, type MemoryPolicy, type Mode, type Population } from './run.js';
import { scoreTask, type Level } from './score.js';
import { TASKS, type GoldRow, type GoldTier, type LlmLike, type TaskId } from './types.js';
import { VARIANTS } from './variants/index.js';

class UsageError extends Error {}

const TIERS: GoldTier[] = ['human', 'synthetic', 'opus', 'model', 'rule'];
const DELEGATES: Record<string, string> = { export: './export.js', label: './label.js', synth: './synth/index.js' };

function oneOf<T extends string>(name: string, v: string, allowed: readonly T[]): T {
  if (!(allowed as readonly string[]).includes(v)) throw new UsageError(`--${name} must be one of ${allowed.join(', ')} (got "${v}")`);
  return v as T;
}

function number(name: string, v: string): number {
  const n = Number(v);
  if (!Number.isFinite(n)) throw new UsageError(`--${name} must be a number (got "${v}")`);
  return n;
}

const tiersOf = (v: string | undefined): GoldTier[] | undefined => (v ? v.split(',').map((t) => oneOf('tiers', t.trim(), TIERS)) : undefined);

export function datasetDir(arg: string): string {
  const dir = existsSync(join(arg, 'meta.json')) ? arg : join(labDir(), 'datasets', arg);
  if (!existsSync(join(dir, 'meta.json'))) throw new UsageError(`no dataset "${arg}" (neither a dataset directory nor ${join(labDir(), 'datasets', arg)})`);
  return dir;
}

// The bench's model runner, built on first use: token, isolated config dir and a shared call cache under LAB_DIR.
function lazyLlm(): { llm: LlmLike; spent: () => number } {
  let runner: LlmRunner | undefined;
  return {
    llm: {
      call: (c) => {
        runner ??= new LlmRunner({
          token: benchToken(process.env.LAB_ENV_FILE || '.env'),
          configDir: join(labDir(), '.claude-cfg'),
          cacheFile: join(labDir(), 'cache', 'variants.jsonl'),
          concurrency: Number(process.env.LAB_CONCURRENCY) || 4,
        });
        return runner.call(c);
      },
    },
    spent: () => runner?.spentUsd ?? 0,
  };
}

const stamp = (): string => new Date().toISOString().slice(0, 19).replace(/:/g, '-');
const log = (m: string): void => void process.stderr.write(`${m}\n`);

async function cmdRun(argv: string[]): Promise<void> {
  const { values: v } = parseArgs({
    args: argv,
    options: {
      dataset: { type: 'string' },
      variant: { type: 'string', default: 'baseline' },
      task: { type: 'string', default: 'all' },
      mode: { type: 'string', default: 'static' },
      memory: { type: 'string', default: 'none' },
      q: { type: 'string', default: '10' },
      threshold: { type: 'string', default: '0' },
      population: { type: 'string', default: 'gold' },
      tiers: { type: 'string' },
      level: { type: 'string', default: 'initiative' },
      floor: { type: 'string', default: '0.95' },
      'no-llm': { type: 'boolean', default: false },
      run: { type: 'string' },
    },
  });
  if (!v.dataset) throw new UsageError('run: --dataset <name|dir> is required');
  const mode = oneOf<Mode>('mode', v.mode!, ['static', 'replay']);
  const memory = oneOf<MemoryPolicy>('memory', v.memory!, ['none', 'oracle', 'loop']);
  const population = oneOf<Population>('population', v.population!, ['gold', 'all']);
  const level = oneOf<Level>('level', v.level!, ['initiative', 'umbrella']);
  const tiers = tiersOf(v.tiers);
  const questionsPerDay = number('q', v.q!);
  const threshold = number('threshold', v.threshold!);
  const floor = number('floor', v.floor!);
  const taskArg = v.task === 'all' ? 'all' : oneOf<TaskId>('task', v.task!, TASKS);
  const names = v.variant!.split(',').map((s) => s.trim()).filter(Boolean);
  for (const n of names) if (!VARIANTS[n]) throw new UsageError(`unknown variant "${n}" (have: ${Object.keys(VARIANTS).join(', ')})`);
  const runName = v.run ?? stamp();

  const ds = loadDataset(datasetDir(v.dataset));
  const model = v['no-llm'] ? null : lazyLlm();
  noteVariants(runName, names);
  const entries: ReportEntry[] = [];
  for (const name of names) {
    const variant = await VARIANTS[name]!();
    const why = (t: TaskId): string | null => {
      if (!variant.tasks.includes(t)) return `${variant.name} does not do ${t}`;
      if (!unitsFor(ds, t).length) return `${ds.meta.name} has no units for ${t}`;
      // Without gold the 'gold' population is empty — except dedup, which always runs on every item.
      if (t !== 't2-dedup' && population === 'gold' && !goldFor(ds, t, tiers).size) return `${ds.meta.name} has no gold for ${t}${tiers ? ` in ${tiers.join('+')}` : ''}`;
      return null;
    };
    // `all` quietly takes what applies; a task named explicitly says why it was skipped.
    const tasks = (taskArg === 'all' ? TASKS : [taskArg]).filter((t) => {
      const skip = why(t);
      if (skip && taskArg !== 'all') log(`skip: ${skip}`);
      return !skip;
    });
    for (const task of tasks) {
      const result = await runTask(ds, variant, task, { mode, memory, questionsPerDay, threshold, population, tiers, llm: model?.llm ?? null, runName, log });
      const score = scoreTask(ds, result, { tiers, level, floor });
      writeFileSync(join(resultDir(result), `${task}.score.json`), `${JSON.stringify(score)}\n`);
      entries.push({ result, score });
    }
  }
  if (!entries.length) throw new UsageError(`nothing to run: no task of ${names.join(', ')} has units${population === 'gold' ? ' and gold' : ''} in ${ds.meta.name}`);
  process.stdout.write(`${renderSummary(entries)}\n\n`);
  const total = entries.reduce((a, e) => a + e.result.costUsd, 0);
  log(`run ${runName}: ${entries.length} result(s) in ${runDir(runName)} · cost $${total.toFixed(4)} (fresh spend $${(model?.spent() ?? 0).toFixed(4)})`);
}

async function cmdReport(argv: string[]): Promise<void> {
  const { values: v } = parseArgs({
    args: argv,
    options: { run: { type: 'string' }, out: { type: 'string' }, tiers: { type: 'string' }, level: { type: 'string', default: 'initiative' }, floor: { type: 'string', default: '0.95' } },
  });
  if (!v.run) throw new UsageError('report: --run <name> is required');
  const tiers = tiersOf(v.tiers);
  const level = oneOf<Level>('level', v.level!, ['initiative', 'umbrella']);
  const floor = number('floor', v.floor!);
  const datasets = new Map<string, Dataset>();
  const entries: ReportEntry[] = [];
  for (const result of loadRun(v.run)) {
    // The run recorded where it loaded the dataset from; a moved dataset is looked up by name.
    const dir = existsSync(join(result.datasetDir ?? '', 'meta.json')) ? result.datasetDir : datasetDir(result.dataset);
    let ds = datasets.get(dir);
    if (!ds) datasets.set(dir, (ds = loadDataset(dir)));
    entries.push({ result, score: scoreTask(ds, result, { tiers, level, floor }) });
  }
  const md = renderReport(entries, { title: `Lab report — run ${v.run}` });
  if (v.out) {
    writeFileSync(v.out, md);
    log(`report: ${v.out}`);
  } else process.stdout.write(md);
}

function cmdList(): void {
  const root = join(labDir(), 'datasets');
  const names = existsSync(root) ? readdirSync(root).filter((d) => existsSync(join(root, d, 'meta.json'))).sort() : [];
  if (!names.length) {
    process.stdout.write(`no datasets under ${root}\n`);
    return;
  }
  const lines = (p: string): number => (existsSync(p) ? readFileSync(p, 'utf8').split('\n').filter((l) => l.trim()).length : 0);
  for (const name of names) {
    const dir = join(root, name);
    const meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8')) as { kind?: string; tenant?: string; since?: string; until?: string };
    const units = (['fragment', 'item', 'mention'] as const).map((k) => [k, lines(join(dir, 'units', `${k}.jsonl`))] as const).filter(([, n]) => n);
    const gold = TASKS.map((t) => {
      const rows = readJsonl<GoldRow>(join(dir, 'gold', `${t}.jsonl`));
      if (!rows.length) return '';
      const by = new Map<string, number>();
      for (const r of rows) by.set(r.tier, (by.get(r.tier) ?? 0) + 1);
      return `${t} ${rows.length} (${[...by].map(([k, n]) => `${k} ${n}`).join(', ')})`;
    }).filter(Boolean);
    const pairs = lines(join(dir, 'gold', 't2-pairs.jsonl'));
    process.stdout.write(
      `${name}  [${meta.kind ?? '?'} · ${meta.tenant ?? '?'} · ${meta.since ?? '?'}..${meta.until ?? '?'}]\n` +
        `  units: ${units.map(([k, n]) => `${k} ${n}`).join(', ') || 'none'}\n` +
        `  gold:  ${[...gold, ...(pairs ? [`t2-pairs ${pairs}`] : [])].join('; ') || 'none'}\n`,
    );
  }
}

const USAGE = `usage: npm run lab -- <run|report|list|export|label|synth> [options]
  run     --dataset <name|dir> [--variant a,b] [--task <t>|all] [--mode static|replay] [--memory none|oracle|loop]
          [--q 10] [--threshold 0] [--population gold|all] [--tiers human,opus] [--level initiative|umbrella]
          [--floor 0.95] [--no-llm] [--run <name>]
  report  --run <name> [--out file] [--tiers ...] [--level umbrella] [--floor 0.95]
  list
variants: ${Object.keys(VARIANTS).join(', ')}
tasks: ${TASKS.join(', ')}`;

export async function main(argv: string[]): Promise<void> {
  const [cmd, ...rest] = argv;
  if (cmd === 'run') return cmdRun(rest);
  if (cmd === 'report') return cmdReport(rest);
  if (cmd === 'list') return cmdList();
  const spec = cmd ? DELEGATES[cmd] : undefined;
  if (spec) {
    // Written by other parts of the bench; imported by name so this file never depends on them statically.
    const mod = (await import(spec)) as { main?: (argv: string[]) => unknown };
    if (typeof mod.main !== 'function') throw new Error(`${spec} exports no main(argv)`);
    await mod.main(rest);
    return;
  }
  if (cmd === 'help' || cmd === '--help' || cmd === '-h') {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  throw new UsageError(cmd ? `unknown command "${cmd}"\n${USAGE}` : USAGE);
}

// Run only as the entry point (`tsx src/lab/cli.ts …`), so a test may import main() without side effects.
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((err: unknown) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(err instanceof UsageError ? 2 : 1);
  });
}
