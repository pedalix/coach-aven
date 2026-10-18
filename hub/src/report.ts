// Where the hub's lines go (design D16, task 7.4): every line to Workers logs as one JSON object; from
// warning up also to Sentry, when the Worker has a SENTRY_DSN secret. Without it the SDK stays disabled
// and nothing leaves the Worker but its logs. The lines carry routing metadata only — installations,
// addresses, methods, task ids, reasons — never key material, signatures or envelope contents.
import { captureMessage, type CloudflareOptions } from '@sentry/cloudflare';

export type Level = 'info' | 'warn' | 'error';

export interface SentryEnv {
  /** Secret: the DSN the bots use too; unset or empty → no SDK. */
  SENTRY_DSN?: string;
  /** Tells the hub's events apart in a project the bots share (default `hub`). */
  SENTRY_ENVIRONMENT?: string;
  /** Optional version tag, e.g. `wrangler deploy --var SENTRY_RELEASE:<git sha>`. */
  SENTRY_RELEASE?: string;
}

/** The SDK options of one request or object, from the Worker's own configuration. */
export function sentryOptions(env: SentryEnv): CloudflareOptions {
  return {
    dsn: env.SENTRY_DSN || undefined,
    environment: env.SENTRY_ENVIRONMENT || 'hub',
    ...(env.SENTRY_RELEASE ? { release: env.SENTRY_RELEASE } : {}),
    sendDefaultPii: false,
  };
}

/** One Sentry event per key per hour: a bot with a wrong key redials every minute, and its every refusal is in the logs anyway. */
export const SENTRY_REPEAT_MS = 3_600_000;
const lastSent = new Map<string, number>();

export interface SentryLine {
  message: string;
  level: 'warning' | 'error';
  tags: Record<string, string>;
  /** Repeats of the same key within SENTRY_REPEAT_MS are not sent. */
  key: string;
}

const fmt = (v: unknown): string => {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return /[\s"=]/.test(s) ? JSON.stringify(s) : s;
};

/** Pure: what a line becomes in Sentry — nothing for info; `<event> k=v …` tagged with the event, the reason and the installation. */
export function toSentry(level: Level, event: string, fields: Record<string, unknown>): SentryLine | undefined {
  if (level === 'info') return undefined;
  const pairs = Object.entries(fields).filter(([, v]) => v !== undefined);
  const tags: Record<string, string> = { area: 'hub', event };
  for (const k of ['reason', 'installation'] as const) if (typeof fields[k] === 'string') tags[k] = fields[k] as string;
  return {
    message: [event, ...pairs.map(([k, v]) => `${k}=${fmt(v)}`)].join(' '),
    level: level === 'warn' ? 'warning' : 'error',
    tags,
    key: [event, tags.reason ?? '', tags.installation ?? ''].join('|'),
  };
}

export function log(level: Level, event: string, fields: Record<string, unknown> = {}, now = Date.now()): void {
  const line = JSON.stringify({ event, ...fields });
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
  const s = toSentry(level, event, fields);
  if (!s) return;
  const last = lastSent.get(s.key);
  if (last !== undefined && now - last < SENTRY_REPEAT_MS) return;
  lastSent.set(s.key, now);
  captureMessage(s.message, { level: s.level, tags: s.tags });
}
