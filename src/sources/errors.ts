// Operator-facing error classes shared by the source CLIs. A UsageError is a wrong invocation
// (missing flag, unknown action): printed plainly, exit 2, no stack. Everything else propagates
// as a real failure.
export class UsageError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'UsageError';
  }
}
