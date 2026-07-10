import type { Config } from './config.js';
import { DaytonaDriver } from './daytona.js';

// Provider-agnostic sandbox driver: the ONLY surface the orchestrator needs from a
// sandbox provider. Extracted 2026-07 when Daytona's open-source codebase was frozen —
// everything outside this file and its implementations must stay provider-ignorant, so
// that switching providers (Daytona Cloud, a self-hosted Docker/sysbox box over SSH, …)
// means writing one new driver, not touching the bot. The surface is deliberately the
// EXACT set of operations the bot uses today — don't grow it speculatively:
//   • a warm named sandbox per project: persistent disk, auto-stop on idle, wake on use
//   • exec + file upload
//   • persistent process sessions with stdin, log snapshot AND live tail — the claude
//     process lives in one and must survive bot restarts (reattach = snapshot + tail)

export interface ExecOpts {
  cwd?: string;
  env?: Record<string, string>;
  timeout?: number; // seconds; 0 = no timeout
  check?: boolean; // throw on non-zero exit
}

export interface ExecResult {
  exitCode: number;
  result: string;
}

// A live (or at least existing) sandbox. `started` is the state at fetch time — a
// snapshot, not a subscription.
export interface SandboxHandle {
  readonly name: string;
  readonly started: boolean;

  exec(command: string, opts?: ExecOpts): Promise<ExecResult>;
  // Write bytes to a path WITHOUT them transiting a command line (tokens must never
  // show up in exec logs).
  uploadFile(data: Buffer, path: string): Promise<void>;

  // ── persistent process sessions ─────────────────────────────────────────
  // A session hosts long-running commands that outlive the bot process (claude runs
  // here). Commands are addressed by (sessionKey, cmdId) — both persisted in state.json
  // so a restarted bot can reattach.
  createSession(sessionKey: string): Promise<void>;
  // Start a command in the session, detached; resolves as soon as it's running.
  startSessionCommand(sessionKey: string, command: string): Promise<{ cmdId: string }>;
  // Is the command still running? false when it exited or the session/command is gone.
  sessionCommandRunning(sessionKey: string, cmdId: string): Promise<boolean>;
  // The command's full stdout so far (the reattach snapshot).
  sessionCommandLogs(sessionKey: string, cmdId: string): Promise<string>;
  // Tail the command's stdout — the returned promise settles when the process exits or
  // the stream drops (the caller treats both as "process gone"). NOTE: Daytona replays
  // the WHOLE log from the start on (re)subscribe; callers that already consumed a
  // snapshot must skip that prefix themselves (see ClaudeSession.open).
  streamSessionCommandLogs(
    sessionKey: string,
    cmdId: string,
    onStdout: (chunk: string) => void,
  ): Promise<void>;
  sendSessionInput(sessionKey: string, cmdId: string, data: string): Promise<void>;
  deleteSession(sessionKey: string): Promise<void>;
}

export interface SandboxDriver {
  // Make sure the base image/snapshot the sandboxes boot from exists (idempotent).
  ensureImage(): Promise<void>;
  // Warm named sandbox: create it from the base image, or wake it if stopped.
  ensureSandbox(name: string, projectSlug: string): Promise<SandboxHandle>;
  // Peek at a sandbox WITHOUT creating or waking it — undefined if it doesn't exist.
  // Used by paths that must not defeat auto-stop (housekeeping, /aven memory).
  getSandbox(name: string): Promise<SandboxHandle | undefined>;
  // name → provider state string (e.g. 'started'/'stopped'), for /aven status.
  listStates(): Promise<Map<string, string>>;
}

// The provider switch. Daytona is the only implementation today; a second provider adds
// a case here (config-selected), and nothing else in the bot changes.
export function createDriver(cfg: Config): SandboxDriver {
  return new DaytonaDriver(cfg);
}
