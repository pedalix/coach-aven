// One small HTTP client for the tracker connectors. Two rules learned the hard way on the
// Gmail backfill (google/client.ts, c9f8e01 + 582625f):
//   1. read a response body EXACTLY ONCE — into a string — and branch on status afterwards;
//      a retry path that re-reads or cancels a Response ends in "Body is unusable";
//   2. pace proactively (min interval between requests) AND honour 429 / Retry-After with a
//      backoff long enough to clear the server's window, instead of burning every attempt in
//      a few seconds.
// 401/403 surface as `TrackerHttpError` with `reauth` set so the poller parks the source and
// alerts once instead of retrying a dead token.

export class TrackerHttpError extends Error {
  constructor(
    readonly status: number,
    readonly url: string,
    readonly body: string,
  ) {
    super(`HTTP ${status} ${url.replace(/[?#].*$/, '')}: ${body.slice(0, 300)}`);
    this.name = 'TrackerHttpError';
  }
  /** Credentials are wrong/revoked/insufficient — a human must act. */
  get reauth(): boolean {
    return this.status === 401 || this.status === 403;
  }
}

export interface HttpResult {
  status: number;
  text: string;
  json: unknown;
}

export interface HttpOptions {
  headers: Record<string, string>;
  /** Minimum ms between request starts (client-side pacing). */
  minIntervalMs?: number;
  maxAttempts?: number;
  /** First backoff when the server gives no Retry-After (doubles, capped at maxBackoffMs). */
  baseBackoffMs?: number;
  maxBackoffMs?: number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  log?: (line: string) => void;
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function retryAfterMs(h: string | null, now: number): number | undefined {
  if (!h) return undefined;
  const secs = Number(h);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const at = Date.parse(h);
  return Number.isNaN(at) ? undefined : Math.max(0, at - now);
}

export function createHttp(o: HttpOptions) {
  const f = o.fetchImpl ?? fetch;
  const sleep = o.sleep ?? realSleep;
  const now = o.now ?? Date.now;
  const minInterval = o.minIntervalMs ?? 0;
  const maxAttempts = o.maxAttempts ?? 6;
  const base = o.baseBackoffMs ?? 2000;
  const cap = o.maxBackoffMs ?? 60_000;
  let nextSlot = 0;

  async function pace(): Promise<void> {
    const t = now();
    const wait = nextSlot - t;
    nextSlot = Math.max(t, nextSlot) + minInterval;
    if (wait > 0) await sleep(wait);
  }

  async function request(method: string, url: string, body?: unknown): Promise<HttpResult> {
    for (let attempt = 0; ; attempt++) {
      await pace();
      const res = await f(url, {
        method,
        headers: { Accept: 'application/json', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...o.headers },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      const text = await res.text(); // the ONE read
      const retryable = res.status === 429 || res.status >= 500;
      if (retryable && attempt + 1 < maxAttempts) {
        const wait = retryAfterMs(res.headers.get('retry-after'), now()) ?? Math.min(cap, base * 2 ** attempt) + Math.floor(Math.random() * 500);
        o.log?.(`  HTTP ${res.status} — retry ${attempt + 1}/${maxAttempts - 1} in ${Math.round(wait / 1000)}s`);
        await sleep(wait);
        continue;
      }
      if (res.status < 200 || res.status >= 300) throw new TrackerHttpError(res.status, url, text);
      let json: unknown = undefined;
      if (text) {
        try {
          json = JSON.parse(text);
        } catch {
          throw new TrackerHttpError(res.status, url, `non-JSON body: ${text.slice(0, 120)}`);
        }
      }
      return { status: res.status, text, json };
    }
  }

  return { request, get: (url: string) => request('GET', url), post: (url: string, body: unknown) => request('POST', url, body) };
}

export type Http = ReturnType<typeof createHttp>;
