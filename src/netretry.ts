// Retry for transient NETWORK failures on control-plane HTTP calls. Today's caller is the Teams
// connector (chat/teams/app.ts, around its own retry of throttled answers); Slack's error text uses
// stackHead below.
//
// Why: the first API call after the bot sat idle (a restart, or ~45 quiet minutes) has died with
// "Client network socket disconnected before secure TLS connection was established" — twice on
// 2026-09-28, against a sandbox provider's API since removed. The same call succeeded minutes
// later, but the turn — once an automatic YouTrack investigation of a Critical ticket — was lost.
// A dropped handshake on a fresh/stale connection is exactly the case a short retry absorbs.
//
// Only connection-level failures qualify: a 4xx/5xx HTTP answer, a not-found, a conflict or a
// validation error is a real answer and must propagate unchanged. Pure module, no SDK import:
// the error is recognised by code / message shape, whichever client threw it.

const TRANSIENT_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ECONNABORTED',
  'ETIMEDOUT',
  'EPIPE',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'EAI_AGAIN',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
]);

const TRANSIENT_MESSAGE =
  /socket disconnected before secure TLS|socket hang up|ECONNRESET|ETIMEDOUT|EAI_AGAIN|network socket|connect ETIMEDOUT|read ECONNRESET/i;

type ErrLike = { code?: unknown; message?: unknown; cause?: unknown; status?: unknown; statusCode?: unknown };

// True when `err` (or its cause chain) is a connection-level failure worth one more try.
export function isTransientNetworkError(err: unknown, depth = 0): boolean {
  if (!err || typeof err !== 'object' || depth > 4) return false;
  const e = err as ErrLike;
  // An HTTP status means the server answered — not a transport failure.
  if (typeof e.status === 'number' || typeof e.statusCode === 'number') return false;
  if (typeof e.code === 'string' && TRANSIENT_CODES.has(e.code)) return true;
  if (typeof e.message === 'string' && TRANSIENT_MESSAGE.test(e.message)) return true;
  return isTransientNetworkError(e.cause, depth + 1);
}

export type RetryOpts = {
  delaysMs?: number[]; // one entry per retry; default: 2 retries after 1 s and 3 s
  sleep?: (ms: number) => Promise<void>; // injectable for tests
  onRetry?: (err: unknown, attempt: number, delayMs: number) => void;
};

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Run `fn`; on a transient network error retry after each delay in turn. Any other error, or the
// last transient one, is rethrown as-is.
export async function withNetRetry<T>(fn: () => Promise<T>, opts: RetryOpts = {}): Promise<T> {
  const delays = opts.delaysMs ?? [1000, 3000];
  const sleep = opts.sleep ?? realSleep;
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= delays.length || !isTransientNetworkError(err)) throw err;
      opts.onRetry?.(err, attempt + 1, delays[attempt]);
      await sleep(delays[attempt]);
    }
  }
}

// First `n` stack frames of an error, for the local journal (Sentry keeps the full stack).
export function stackHead(err: unknown, n = 5): string | undefined {
  if (!(err instanceof Error) || !err.stack) return undefined;
  const frames = err.stack
    .split('\n')
    .slice(1)
    .map((l) => l.trim())
    .filter((l) => l.startsWith('at '));
  return frames.length ? frames.slice(0, n).join(' | ') : undefined;
}
