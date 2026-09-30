// Retry for TRANSIENT git failures against GitHub inside a sandbox (fetch/clone at turn start).
//
// Why: 2026-09-30 08:34 UTC a chat turn in the HSX channel died on `git fetch --all --prune`
// with "remote: Repository not found." — the installation token had been minted ONE second
// earlier (every turn mints a fresh, repo-scoped token; there is no cache) and the very same
// token opened all three repos of the project minutes later. GitHub answers 404 for a private
// repo whenever the credential is not (yet) honoured, so a freshly issued token that has not
// propagated looks exactly like a missing repo. First such failure in 30 days of journal, but
// it cost a user's turn, so one or two more tries after a short pause absorb it.
//
// Only output that reads as transient qualifies: a token propagation 404, a dropped connection,
// a DNS hiccup, a GitHub 5xx. A genuine "not found" (repo renamed, App not installed on it) will
// simply fail again after the retries and propagate with the same message — the cost is a few
// seconds. Pure module (no sandbox import) so it is testable on the error text alone.

const TRANSIENT_OUTPUT =
  /Repository not found|Could not resolve host|Could not read from remote repository|remote end hung up unexpectedly|early EOF|RPC failed|The requested URL returned error: 5\d\d|Connection (?:timed out|reset by peer|refused)|TLS connection|unexpected disconnect|Failed to connect to github\.com|GnuTLS recv error|Error in the pull function|transfer closed with outstanding read data/i;

// True when a failed git command's message/output looks like something one more try can fix.
export function isTransientGitFailure(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : typeof err === 'string' ? err : '';
  return TRANSIENT_OUTPUT.test(msg);
}

export type GitRetryOpts = {
  delaysMs?: number[]; // one entry per retry; default: 2 retries after 2 s and 5 s
  sleep?: (ms: number) => Promise<void>; // injectable for tests
  onRetry?: (err: unknown, attempt: number, delayMs: number) => void;
};

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Run `fn`; on a transient git failure retry after each delay in turn. Any other error, or the
// last transient one, is rethrown as-is (the chat path shows its message to the user).
export async function withGitRetry<T>(fn: () => Promise<T>, opts: GitRetryOpts = {}): Promise<T> {
  const delays = opts.delaysMs ?? [2000, 5000];
  const sleep = opts.sleep ?? realSleep;
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= delays.length || !isTransientGitFailure(err)) throw err;
      opts.onRetry?.(err, attempt + 1, delays[attempt]);
      await sleep(delays[attempt]);
    }
  }
}
