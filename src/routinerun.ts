// One scheduled-routine turn (report or task kind). Kept apart from pollers.ts so its contract
// is testable with fakes.
//
// The run posts ONE short top-level parent message ("🛠 Review session · running…") and runs the
// turn INSIDE that parent's thread, under the thread's own conversation key (`thread:<ts>`):
//   • the channel stays readable — one line per run, the long answer and its live status live in
//     the thread;
//   • a reply in that thread is an ordinary thread reply (events.ts keys it `thread:<ts>` too), so
//     it continues the SAME Claude session that produced the answer — the agent still knows the
//     escalations it just numbered, and "E1 a, R2 нет" can be applied;
//   • every run gets a new parent → a new key → a fresh Claude session with the current project
//     prompt (the #127 contract), without having to throw a reused session away.
// When the answer lands, the parent is rewritten to the answer's headline (its first line), so
// the channel reads as a log of results ("🛠 Review session — 96 decided, 1 question").
//
// The legacy stable key `cron:<id>:<slug>` is still restarted once per fire: it clears the one
// binding older builds kept per routine (and its sandbox process) so nothing lingers.
//
// The optional settle hook (routine delivery guard, routineguard.ts) is the only way a caller
// learns how the run ENDED: the engine renders a turn error inside the thread and resolves, so
// without it a failed run leaves the parent at "running…" forever (2026-10-12). With it, a failed
// run's parent is rewritten to "⚠️ <label> — failed: <reason>", a canceled one says so, and the
// caller gets the outcome to record. Not wired → the engine call is exactly the historical one.
import type { ProjectConfig } from './projects.js';
import type { TurnEngine, TurnOutcome } from './turn.js';

export type RoutineOutcome = TurnOutcome;

export type RoutineEngine = Pick<TurnEngine, 'restartSession'> & {
  /** Run the turn in `threadTs` under `key`; `onAnswer` gets the final answer text, `onSettle` (if given) the outcome once, after it. */
  liveTurn(
    key: string,
    threadTs: string,
    project: ProjectConfig,
    prompt: string,
    onAnswer: (text: string) => Promise<void>,
    onSettle?: (outcome: RoutineOutcome, reason?: string) => Promise<void>,
  ): Promise<void>;
};

export interface RoutineSlack {
  /** Post the top-level parent; returns its ts. */
  postParent(text: string): Promise<string>;
  updateParent(ts: string, text: string): Promise<void>;
}

export interface RoutineRun {
  legacyKey: string; // cron:<id>:<slug> (team-prefixed) — cleared once per fire
  threadKey: (parentTs: string) => string; // thread:<ts> (team-prefixed) — the run's own key
  label: string; // "🛠 Review session"
}

/** Pure: the routine's human label — kind icon + the prompt's leading phrase. */
export function routineLabel(kind: string | undefined, prompt: string): string {
  const icon = kind === 'task' ? '🛠' : '📋';
  const lead = prompt.trim().split(/[:|\n.—]/)[0]!.trim().replace(/\s+/g, ' ');
  const short = lead.length > 48 ? `${lead.slice(0, 47)}…` : lead;
  return `${icon} ${short || 'Scheduled run'}`;
}

/** Pure: the answer's headline — first non-empty line, markdown/emphasis stripped, ≤ 160 chars. */
export function headline(answer: string): string {
  const line =
    answer
      .split('\n')
      .map((l) => l.replace(/^[#>*\-•\s]+/, '').replace(/[*_`]/g, '').trim())
      .find((l) => l.length > 0) ?? '';
  return line.length > 160 ? `${line.slice(0, 159)}…` : line;
}

export interface RoutineSettle {
  headline?: string; // ok: the delivered answer's headline
  reason?: string; // error: the failure, one line
}
export interface RoutineRunOpts {
  onSettle?: (outcome: RoutineOutcome, info: RoutineSettle) => Promise<void>;
}

/** Pure: a turn error's message → one line for the parent (first non-empty line, separators
 * dropped; a bare "…failed (exit 1):" head borrows the next line so it says what broke). */
export function failureReason(message: string | undefined, max = 140): string {
  const lines = (message ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !/^---.*---$/.test(l));
  let head = lines[0] ?? 'unknown error';
  if (/:\s*$/.test(head) && lines[1]) head = `${head} ${lines[1]}`;
  return head.length > max ? `${head.slice(0, max - 1)}…` : head;
}

export async function startRoutineTurn(
  engine: RoutineEngine,
  slack: RoutineSlack,
  run: RoutineRun,
  project: ProjectConfig,
  prompt: string,
  opts?: RoutineRunOpts,
): Promise<string> {
  // A failed cleanup must not cost the run.
  await engine.restartSession(run.legacyKey, project).catch(() => {});
  const parentTs = await slack.postParent(`${run.label} · running…`);
  let head = '';
  const onAnswer = async (text: string): Promise<void> => {
    head = headline(text);
    await slack.updateParent(parentTs, head ? `${run.label} — ${head}` : `${run.label} — done`).catch(() => {});
  };
  const settle = opts?.onSettle;
  const onSettle = settle
    ? async (outcome: RoutineOutcome, reason?: string): Promise<void> => {
        if (outcome === 'error') await slack.updateParent(parentTs, `⚠️ ${run.label} — failed: ${failureReason(reason)}`).catch(() => {});
        else if (outcome === 'canceled') await slack.updateParent(parentTs, `${run.label} — canceled`).catch(() => {});
        await settle(outcome, { headline: head || undefined, reason: outcome === 'error' ? failureReason(reason, 200) : undefined });
      }
    : undefined;
  await engine.liveTurn(run.threadKey(parentTs), parentTs, project, prompt, onAnswer, onSettle);
  return parentTs;
}
