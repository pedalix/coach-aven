// Fail loudly (OpenSpec `agent-messaging`, design D16): the catalogue of messaging events, and the one
// helper that emits them. Every event is logged; every warning and error ALSO goes to Sentry explicitly
// (captureMessage, tag area=messaging) — log.warn reaches Sentry only with SENTRY_LOGS, so the helper
// does not rely on it.
import { log } from '../log.js';
import { captureMessage } from '../sentry.js';

type Level = 'info' | 'warn' | 'error';
const ev = (level: Level, ...fields: string[]) => ({ level, fields });

/** name → level and fields, in the order they are logged. */
export const EVENTS = {
  'hub.connect.failed': ev('error', 'installation', 'reason'),
  'hub.replaced': ev('warn', 'installation'),
  'hub.clock.skew': ev('warn', 'skew_ms'),
  'hub.disconnected.long': ev('warn', 'minutes', 'outbox'),
  'hub.peer.removed': ev('warn', 'peer', 'ended'),
  'hub.envelope.bad_signature': ev('error', 'from', 'method', 'task', 'env_id', 'key'),
  'hub.envelope.decrypt_failed': ev('error', 'from', 'method', 'task', 'env_id', 'key'),
  'hub.envelope.duplicate': ev('info', 'from', 'task', 'env_id'),
  'hub.rejected': ev('warn', 'from', 'to', 'method', 'reason'),
  'hub.outbox.backlog': ev('warn', 'installation', 'size', 'oldest_age'),
  'hub.schema.migrated': ev('info', 'from', 'to'),
  'ask.rejected': ev('warn', 'from', 'to', 'task', 'reason', 'versions'),
  'ask.unexpected': ev('warn', 'task', 'from', 'expected'),
  'ask.after_end': ev('info', 'task', 'state', 'method'),
  'ask.inject.slow': ev('warn', 'key', 'task', 'cli', 'waited_ms'),
  'ask.inject.lost': ev('error', 'key', 'task', 'cli'),
  'ask.inject.stuck': ev('error', 'key', 'task', 'waited_ms'),
  'ask.inject.result_mismatch': ev('error', 'key', 'expected', 'actual'),
  'ask.inject.skipped': ev('info', 'key', 'task', 'reason'),
  'ask.inject.disabled': ev('warn', 'key', 'task', 'reason'),
  'ask.deliver.no_conversation': ev('error', 'task', 'key', 'slug', 'driver'),
  'ask.shadow.late_result': ev('warn', 'task', 'length'),
  'ask.shadow.askuserquestion': ev('warn', 'task', 'slug'),
  'ask.shadow.nudge': ev('info', 'task', 'slug'),
  'ask.shadow.no_answer': ev('warn', 'task', 'slug'),
  'ask.rounds.exceeded': ev('warn', 'task', 'from', 'to', 'rounds'),
  'ask.expired': ev('info', 'task', 'from', 'to', 'age'),
  'ask.canceled': ev('info', 'task', 'from', 'to'),
  'ask.marks.held': ev('info', 'task', 'marks', 'target'),
  'ask.marks.refused': ev('warn', 'task', 'marks', 'target'),
  'ask.cost.high': ev('warn', 'task', 'slug', 'cost'),
} as const;
export type EventName = keyof typeof EVENTS;

export interface EventSink {
  log: (level: Level, line: string) => void;
  capture: (line: string, level: 'warning' | 'error', tags: Record<string, string>) => void;
  now: () => number;
}
const defaultSink: EventSink = {
  log: (level, line) => log[level](line),
  capture: (line, level, tags) => captureMessage(line, level, tags),
  now: () => Date.now(),
};

const fmt = (v: unknown): string => {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return /[\s"=]/.test(s) ? JSON.stringify(s) : s;
};

/** `messaging <name> k=v …`, fields in catalogue order; fields the catalogue does not name are refused. */
export function formatEvent(name: EventName, fields: Record<string, unknown>): string {
  const known: readonly string[] = EVENTS[name].fields;
  const extra = Object.keys(fields).filter((k) => !known.includes(k));
  if (extra.length) throw new Error(`event ${name} has no field ${extra.join(', ')}`);
  return [`messaging ${name}`, ...known.filter((k) => fields[k] !== undefined).map((k) => `${k}=${fmt(fields[k])}`)].join(' ');
}

const lastEmitted = new Map<string, number>();

/**
 * Emit an event: log it at its level and, for a warning or an error, send it to Sentry. `onceEvery`
 * drops repeats of the same key within the window (e.g. `hub.connect.failed` once per reason per hour).
 */
export function emit(name: EventName, fields: Record<string, unknown>, o: { onceEvery?: { key: string; ms: number }; sink?: EventSink } = {}): void {
  const sink = o.sink ?? defaultSink;
  if (o.onceEvery) {
    const k = `${name}|${o.onceEvery.key}`;
    const last = lastEmitted.get(k);
    const now = sink.now();
    if (last !== undefined && now - last < o.onceEvery.ms) return;
    lastEmitted.set(k, now);
  }
  const line = formatEvent(name, fields);
  const level = EVENTS[name].level;
  sink.log(level, line);
  if (level !== 'info') sink.capture(line, level === 'warn' ? 'warning' : 'error', { area: 'messaging', event: name });
}
