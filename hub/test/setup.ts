// Sentry's requests in the tests: the Worker has a DSN on the `sentry.example` host (vitest.config.ts);
// they are answered here and kept, every other request goes out unchanged. The object runs in the
// tests' isolate, so this one stub sees what it sends.
export interface SentryRequest {
  url: string;
  /** The envelope: one parsed JSON value per line (header, item header, item). */
  lines: unknown[];
}

const g = globalThis as typeof globalThis & { __sentryRequests?: SentryRequest[] };
if (!g.__sentryRequests) {
  const requests: SentryRequest[] = (g.__sentryRequests = []);
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const req = new Request(input, init);
    if (new URL(req.url).hostname !== 'sentry.example') return realFetch(input, init);
    const text = await req.text();
    requests.push({ url: req.url, lines: text.split('\n').filter(Boolean).map((l) => JSON.parse(l) as unknown) });
    return new Response('{}', { status: 200 });
  };
}

/** What the Worker has sent to Sentry so far. */
export const sentryRequests = (): SentryRequest[] => g.__sentryRequests ?? [];
