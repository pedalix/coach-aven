import * as Sentry from '@sentry/node';
import type { Config } from './config.js';

// Optional error/performance/log reporting to Sentry. Off unless SENTRY_DSN is set (so dev and
// CI run clean). coach-aven handles PRIVATE repos + Slack text and Sentry is SaaS, so: PII off,
// secrets scrubbed from every outbound event, and structured logs are opt-in (SENTRY_LOGS) to
// keep log *content* off-cloud by default — errors + traces (low content) flow when enabled.

let on = false;
let logsOn = false;

// Redact obvious credentials (GitHub/Slack tokens, JWTs, OpenAI-style keys) from outbound text.
const SECRET =
  /\b(gh[pousr]_[A-Za-z0-9]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}|sk-[A-Za-z0-9-]{20,})\b/g;
export function scrubText(s: string): string {
  return s.replace(SECRET, '[redacted]');
}

// Scrub an outbound event's message + exception values in place (the beforeSend hook).
export function scrubEvent<T extends { message?: unknown; exception?: { values?: { value?: string }[] } }>(event: T): T {
  if (typeof event.message === 'string') event.message = scrubText(event.message);
  for (const v of event.exception?.values ?? []) if (v.value) v.value = scrubText(v.value);
  return event;
}

export function initSentry(cfg: Config): boolean {
  if (!cfg.sentry) return false;
  Sentry.init({
    dsn: cfg.sentry.dsn,
    environment: cfg.sentry.environment,
    release: cfg.sentry.release,
    tracesSampleRate: cfg.sentry.tracesSampleRate,
    enableLogs: cfg.sentry.logs,
    sendDefaultPii: false,
    beforeSend: (event) => scrubEvent(event),
  });
  on = true;
  logsOn = cfg.sentry.logs;
  return true;
}

export const sentryOn = (): boolean => on;

// Report a real Error (with stack) as a Sentry issue. No-op when Sentry is off.
export function captureError(err: unknown, tags?: Record<string, string>): void {
  if (on) Sentry.captureException(err, tags ? { tags } : undefined);
}

// Forward a log line to Sentry structured logs — only when logs are explicitly enabled. Scrubbed.
export function sentryLog(level: 'info' | 'warn' | 'error', msg: string): void {
  if (logsOn) Sentry.logger[level](scrubText(msg));
}

// Flush buffered events before the process exits (e.g. a fatal crash).
export async function flushSentry(ms = 2000): Promise<void> {
  if (on) await Sentry.flush(ms).catch(() => {});
}

export { Sentry };
