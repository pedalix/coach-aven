// Tiny structured-ish logger. Stdout for normal flow, stderr for streamed agent
// output so the two can be redirected independently. info/warn/error also forward to Sentry
// structured logs when SENTRY_LOGS is enabled (sentryLog is a no-op otherwise).
import { sentryLog } from './sentry.js';

const ts = () => new Date().toISOString().replace('T', ' ').slice(0, 19);

export const log = {
  info: (msg: string) => {
    console.log(`[${ts()}] ${msg}`);
    sentryLog('info', msg);
  },
  warn: (msg: string) => {
    console.log(`[${ts()}] WARN  ${msg}`);
    sentryLog('warn', msg);
  },
  error: (msg: string) => {
    console.error(`[${ts()}] ERROR ${msg}`);
    sentryLog('error', msg);
  },
  step: (msg: string) => console.log(`[${ts()}] → ${msg}`),
  // Raw passthrough for streamed sandbox/agent output (no timestamp framing).
  raw: (chunk: string) => process.stderr.write(chunk),
};
