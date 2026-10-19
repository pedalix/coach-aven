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
