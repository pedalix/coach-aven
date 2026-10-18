// The CLI probe's vocabulary (OpenSpec `cli-probe`): a scenario states one hypothesis about the headless
// Claude Code CLI, drives it through scripted steps, and each run is judged from the CLI's own frames.

/** One stdout or stdin line of the stream-json protocol, parsed. */
export type Frame = Record<string, unknown>;

/**
 * One line of a recording. `t` is milliseconds since the run started. `echo`: a line on the CLI's
 * output that is, byte for byte, a line the probe wrote — the transport's copy of stdin (a Daytona
 * session's output carries it, ~200 ms after the write), not the CLI's: never a CLI frame, never checked.
 */
export type RecordLine =
  | { t: number; dir: 'out' | 'in' | 'echo'; frame: Frame }
  | { t: number; proc: 'start'; argv: string[] }
  | { t: number; proc: 'exit'; code: number | null; signal: string | null };

/** A run's verdict. `inconclusive`: a precondition (the model's part of the script) did not happen. */
export type RunVerdict = 'holds' | 'fails' | 'inconclusive';
/** A scenario's verdict for one CLI version. `flaky`: conclusive runs disagree. Only `holds` holds. */
export type Verdict = RunVerdict | 'flaky';

export interface RunOutcome {
  verdict: RunVerdict;
  /** What was missing: the precondition or prediction that timed out or did not hold. */
  reason?: string;
  /** Set when the run ended as an error (no verdict) — it counts as inconclusive. */
  error?: string;
  observations: Record<string, unknown>;
  costUsd: number;
  durationMs: number;
}

export interface ScenarioMeta {
  id: string;
  /** One sentence: what the CLI does, as the bot (or a design) relies on it. */
  hypothesis: string;
  /** True when the bot relies on the hypothesis: the probed set requires it to hold. */
  contract: boolean;
  /** Conclusive runs that settle the scenario: 1 for a structural fact, 3 for timing. */
  runs: number;
  /** `haiku` (default, cheap) or `fleet` (the fleet's model) where the model may matter. */
  model?: 'haiku' | 'fleet';
  /** Merged into the bot's command line: flags appended, settings into the one --settings. */
  extras?: { args?: string[]; settings?: Record<string, unknown> };
  /** Parameter values; each is its own report row (`<id>[<variant>]`). */
  variants?: readonly string[];
  /** Keep token-level `stream_event` deltas in the recording (normally collapsed per block). */
  keepPartials?: boolean;
  /** Upper bound for one run, ms (default 4 minutes). */
  timeoutMs?: number;
  /** Files written into the CLI's working directory before it starts (e.g. a project skill), paths relative to it. */
  files?: Readonly<Record<string, string>>;
}

export interface Scenario<Ctx = unknown> {
  meta: ScenarioMeta;
  /** Returns observations for the report; a missed precondition / prediction throws (see ctx.ts). */
  run(ctx: Ctx, variant?: string): Promise<Record<string, unknown> | void>;
}

/** A scenario's row id: `id` or `id[variant]`. */
export const rowId = (id: string, variant?: string): string => (variant ? `${id}[${variant}]` : id);

/** A recording's file name: `<id>.jsonl` or `<id>.<variant>.jsonl`. */
export const recordingFile = (id: string, variant?: string): string => (variant ? `${id}.${variant}.jsonl` : `${id}.jsonl`);

/** The fleet's model and the cheap default (CLAUDE_MODEL in production is the fleet's). */
export const MODELS = { haiku: 'claude-haiku-5-5', fleet: 'claude-opus-5-5' } as const;
