import type { SandboxOptions } from './sandboxopts.js';
import type { Config, SandboxDriverKind } from './config.js';
import type { StopOutcome, StopRequest } from './idlestop.js';
import { SshDockerDriver } from './sshdocker.js';

// Provider-agnostic sandbox driver: the ONLY surface the orchestrator needs from a
// sandbox provider. It has one implementation, ssh-docker (sshdocker.ts: containers on a
// Docker host the installation runs), and stays the seam for another: everything outside
// this file and its implementations is provider-ignorant, so a new provider means one new
// driver file (its SDK, if any, imported there alone), not touching the bot — see
// docs/sandbox-drivers.md "Adding a driver". The surface is deliberately the EXACT set of
// operations the bot uses today — don't grow it speculatively:
//   • a warm named sandbox per project: persistent disk, stopped when idle (by the provider,
//     or — where it has no idle lifecycle — by the bot: idlestop.ts), woken on use
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
  // the stream drops (the caller treats both as "process gone"). Contract: every
  // (re)subscribe replays the WHOLE log from the start, then follows; callers that already
  // consumed a snapshot skip that prefix themselves (see ClaudeSession.open).
  streamSessionCommandLogs(
    sessionKey: string,
    cmdId: string,
    onStdout: (chunk: string) => void,
  ): Promise<void>;
  sendSessionInput(sessionKey: string, cmdId: string, data: string): Promise<void>;
  deleteSession(sessionKey: string): Promise<void>;
}

export interface SandboxDriver {
  // Make sure the base image the sandboxes boot from exists (idempotent).
  ensureImage(projectImage?: string): Promise<void>; // the project's `sandbox.image`, else the installation's
  // Warm named sandbox: create it from the base image, or wake it if stopped. `opts` are the
  // project's sandbox options (privileged/dind/mounts); they shape CREATION only — a sandbox
  // that already exists keeps the flags it was created with.
  ensureSandbox(name: string, projectSlug: string, opts?: SandboxOptions): Promise<SandboxHandle>;
  // Peek at a sandbox WITHOUT creating or waking it — undefined if it doesn't exist.
  // Used by paths that must not wake an idle sandbox (/aven memory, the dream journal; and
  // housekeeping on a provider that stops its sandboxes itself).
  getSandbox(name: string): Promise<SandboxHandle | undefined>;
  // name → provider state string (e.g. 'started'/'stopped'), for /aven status. A listing
  // that cannot answer (host unreachable, daemon down) THROWS — never an empty map, which
  // would read as "every sandbox not created" behind a green flag.
  listStates(): Promise<Map<string, string>>;
  // Stop a project's sandbox the idle sweep found idle (OpenSpec sandbox-idle-stop, idlestop.ts):
  // re-decide under the sandbox's lock, stop it only if it is still idle and this installation's,
  // and end its sessions (req.onStopped) before anything can wake it again. Only a driver whose
  // provider has NO idle stop of its own implements it (ssh-docker); a driver whose provider
  // stops idle sandboxes itself needs none, and is never asked.
  stopSandbox?(req: StopRequest): Promise<StopOutcome>;
  // Delete a THROWAWAY sandbox (the CLI probe's `cli-probe-<run>`); a missing one is not an error.
  // Every implementation refuses any other name first (sandboxopts.ts assertDeletable): code never
  // deletes a project's sandbox. The bot itself never calls this.
  deleteSandbox(name: string): Promise<void>;
}

// The provider switch. `kind` is the per-project override (projects.config.json's
// `driver` field), else the deployment-wide SANDBOX_DRIVER — both optional, and today
// both can only say ssh-docker: loadConfig and loadProjects refuse any other value before
// it reaches here (OpenSpec retire-daytona-driver D3), so a project never lands on a
// driver nobody chose. The parameter stays, unread, as the seam: a second driver brings
// its kind and the switch back. A driver whose env config is missing throws at first use
// — not at boot — so one misconfigured project can't keep the whole bot down.
export function createDriver(cfg: Config, _kind?: SandboxDriverKind): SandboxDriver {
  return new SshDockerDriver(cfg);
}
