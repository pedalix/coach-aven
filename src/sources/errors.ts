// Operator-facing error classes shared by the `orch` CLIs (the source commands first). A UsageError is a
// wrong invocation (missing flag, unknown action): printed plainly, exit 2, no stack. A ConfigError is a
// configuration the bot refuses to run on (a setting that would move a project to another sandbox,
// OpenSpec retire-daytona-driver D3/D4): one line, exit 1, no stack and nothing to Sentry — a stack can
// push the message out of the last journal lines the deploy's health check prints, and a refused unit
// restarts every few seconds, repeating it. Everything else propagates as a real failure.
export class UsageError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'UsageError';
  }
}

export class ConfigError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'ConfigError';
  }
}

/**
 * How `orch` ends on an error that reached its top level (src/cli.ts), as data so the contract is tested
 * rather than read: a UsageError prints its message, exit 2; a ConfigError prints its message, exit 1 —
 * neither with a stack, neither reported; anything else is an incident: its stack, logged and reported to
 * Sentry, exit 1.
 */
export function cliExit(err: unknown): { text: string; code: 1 | 2; incident: boolean } {
  if (err instanceof UsageError) return { text: err.message, code: 2, incident: false };
  if (err instanceof ConfigError) return { text: err.message, code: 1, incident: false };
  return { text: err instanceof Error ? err.stack || err.message : String(err), code: 1, incident: true };
}
