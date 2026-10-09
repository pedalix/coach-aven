// One scheduled-routine turn (report or task kind). Kept apart from pollers.ts so the
// "fresh session per fire" contract is testable with a fake engine.
//
// Why fresh: a routine's conversation key is stable (`cron:<id>:<slug>`), and liveTurn reuses
// whatever Claude session that key last had (in memory, or re-attached from state.json's chat
// record). Reused forever, a routine never sees an edited project system prompt
// (projects.d/<slug>.md — the prompt is fixed when a session opens) and its context grows by one
// day every day. So each fire first throws the previous conversation away (restartSession kills
// the sandbox-side process and clears the persisted session fields) and only then starts the
// turn, which opens a new session with the current prompt. The chat record itself stays — one
// record per routine, never one per run — so nothing accumulates in state.json.
import type { ProjectConfig } from './projects.js';
import type { TurnEngine } from './turn.js';

export type RoutineEngine = Pick<TurnEngine, 'restartSession'> & {
  liveTurn(key: string, project: ProjectConfig, prompt: string): Promise<void>;
};

export async function startRoutineTurn(engine: RoutineEngine, key: string, project: ProjectConfig, prompt: string): Promise<void> {
  // A failed cleanup must not cost the run: the worst case is one more reuse of the old session.
  await engine.restartSession(key, project).catch(() => {});
  await engine.liveTurn(key, project, prompt);
}
