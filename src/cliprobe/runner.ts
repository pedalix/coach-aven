// Runs one scenario (or one variant of it) until its verdict settles (design D1): each run gets a fresh
// run root (empty working directory, its own configuration directory), a transport, and a ProbeCtx with
// the bot's command line; the run ends with the CLI stopped and the transport disposed — a throwaway
// sandbox deleted — whatever happened. The run's recording and observations come out normalized
// (normalize.ts); nothing raw leaves this module.
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PreconditionMissed, PredictionMissed, ProbeCtx, VersionMismatch, type Transport } from './ctx.js';
import { makeScrubber } from './normalize.js';
import { MODELS, type RecordLine, type RunOutcome, type Scenario, type Verdict } from './types.js';
import { settle, wantsAnotherRun } from './verdict.js';

export interface RunDirs {
  runRoot: string;
  workDir: string;
  configDir: string;
  /** Lowercase hex, for a sandbox name. */
  runId: string;
}

export interface RunnerOptions {
  /** The CLI version the run names (checked against every system/init). */
  version: string;
  transport: (dirs: RunDirs) => Promise<Transport>;
  /** For normalization: the operator's home and the probe cache. */
  home: string;
  cache: string;
  modelOverride?: string;
  runsOverride?: number;
  log?: (line: string) => void;
}

export interface ScenarioResult {
  id: string;
  variant?: string;
  contract: boolean;
  hypothesis: string;
  model: string;
  verdict: Verdict;
  holds: number;
  fails: number;
  inconclusive: number;
  runs: RunOutcome[];
  costUsd: number;
  /** The first conclusive run's recording (the last run's when none was conclusive), normalized. */
  recording: RecordLine[];
}

const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`the run took longer than ${ms} ms`)), ms);
    p.then(
      (v) => (clearTimeout(timer), resolve(v)),
      (e) => (clearTimeout(timer), reject(e)),
    );
  });

export async function runScenario(s: Scenario<ProbeCtx>, variant: string | undefined, o: RunnerOptions): Promise<ScenarioResult> {
  const required = o.runsOverride ?? s.meta.runs;
  const model = o.modelOverride ?? MODELS[s.meta.model ?? 'haiku'];
  const runs: RunOutcome[] = [];
  let chosen: RecordLine[] | undefined;
  let last: RecordLine[] = [];
  while (wantsAnotherRun(runs, required)) {
    const n = runs.length + 1;
    o.log?.(`── ${s.meta.id}${variant ? `[${variant}]` : ''} run ${n} (${model})`);
    const runRoot = mkdtempSync(join(tmpdir(), 'cli-probe-'));
    const dirs: RunDirs = { runRoot, workDir: join(runRoot, 'work'), configDir: join(runRoot, 'config'), runId: randomBytes(4).toString('hex') };
    mkdirSync(dirs.workDir);
    mkdirSync(dirs.configDir);
    let transport: Transport | undefined;
    let ctx: ProbeCtx | undefined;
    let fatal: Error | undefined;
    const started = Date.now();
    let verdict: RunOutcome['verdict'] = 'inconclusive';
    let reason: string | undefined;
    let error: string | undefined;
    let observations: Record<string, unknown> = {};
    try {
      transport = await o.transport(dirs);
      ctx = new ProbeCtx({
        transport,
        launch: { model, settings: s.meta.extras?.settings, extraArgs: s.meta.extras?.args },
        expectedVersion: o.version,
        log: o.log,
      });
      await ctx.start();
      observations = (await withTimeout(s.run(ctx, variant), s.meta.timeoutMs ?? 240_000)) ?? {};
      verdict = 'holds';
    } catch (e) {
      if (e instanceof VersionMismatch) fatal = e;
      else if (e instanceof PreconditionMissed) reason = e.message;
      else if (e instanceof PredictionMissed) {
        verdict = 'fails';
        reason = e.message;
      } else error = e instanceof Error ? e.message : String(e);
      if (ctx?.fatalError instanceof VersionMismatch) fatal = ctx.fatalError;
    } finally {
      await ctx?.close().catch(() => {});
      await transport?.dispose().catch((e: unknown) => o.log?.(`dispose failed: ${e instanceof Error ? e.message : String(e)}`));
    }
    const rec = ctx?.recording ?? [];
    const scrub = makeScrubber(rec, { runRoot, home: o.home, cache: o.cache });
    const recording = scrub.recording(rec, { keepPartials: s.meta.keepPartials });
    rmSync(runRoot, { recursive: true, force: true });
    if (fatal) throw fatal; // the binary is not the version the probe names: no verdict means anything
    const outcome: RunOutcome = scrub.value({
      verdict,
      ...(reason ? { reason } : {}),
      ...(error ? { error } : {}),
      observations,
      costUsd: ctx?.costUsd() ?? 0,
      durationMs: Date.now() - started,
    });
    runs.push(outcome);
    o.log?.(`   → ${outcome.verdict}${outcome.reason ? `: ${outcome.reason}` : ''}${outcome.error ? ` (error: ${outcome.error})` : ''}`);
    last = recording;
    if (!chosen && verdict !== 'inconclusive') chosen = recording;
  }
  const settled = settle(runs, required);
  return {
    id: s.meta.id,
    ...(variant ? { variant } : {}),
    contract: s.meta.contract,
    hypothesis: s.meta.hypothesis,
    model,
    ...settled,
    runs,
    costUsd: runs.reduce((a, r) => a + r.costUsd, 0),
    recording: chosen ?? last,
  };
}
