// The poller's brain for per-project sources, kept pure so it can be tested with a fake
// clock and fake pullers (pollers.ts only supplies timers, the real pullProject and alertOps).
//
// State lives as ONE facts predicate per project — `sources_sync` in facts/<slug>.json — not
// in state.json: it is derived (re-derivable by pulling again), machine-written, machine-read,
// and must never travel with a state export (docs/project-facts.md). It records when we last
// pulled, what each puller reported, how many passes failed in a row (→ backoff) and which
// kinds need a human to re-run `orch sources auth` (→ no blind retries).
import { nowParts } from '../schedule.js';
import { FactStore, projectSubject, type Fact } from '../facts.js';
import type { ProjectConfig } from '../projects.js';
import { configuredKinds } from './run.js';
import type { PullSummary, SourceKind } from './types.js';

export const SOURCES_SYNC = 'sources_sync';
export const DEFAULT_INTERVAL_MIN = 15;
/** Backoff ceiling: a broken source is retried every two hours, never more rarely. */
export const BACKOFF_CAP_MS = 2 * 3_600_000;
/** How often a kind flagged `needsReauth` is probed again — the operator may have fixed it. */
export const REAUTH_PROBE_MS = BACKOFF_CAP_MS;
/** Local wall-clock hour of the daily credential health check (in AVEN_TZ). */
export const AUTH_CHECK_HOUR = 6;

export interface SourceRunSummary {
  ok: boolean;
  reauth: boolean;
  /** Records written across every account/file of this kind. */
  records: number;
  finishedAt: string;
  /** First few error lines — enough for the status line and the alert, not a log dump. */
  errors: string[];
}

export interface SourcesSyncState {
  /** ISO start of the last pass (attempted, successful or not). */
  lastRunAt?: string;
  /** ISO of the last pass in which every puller reported ok. */
  lastOkAt?: string;
  lastSummary: Partial<Record<SourceKind, SourceRunSummary>>;
  /** Passes in a row with at least one failure; drives the backoff factor 2^n (capped). */
  consecutiveFailures: number;
  /** Kinds whose credentials a human must renew; excluded from pulls except for a 2-hourly probe. */
  needsReauth: SourceKind[];
  /** ISO of the last time a `needsReauth` kind was probed. */
  reauthProbeAt?: string;
  /** Message of an exception that escaped a whole pass (not a puller's own error list). */
  lastError?: string;
}

export const emptySyncState = (): SourcesSyncState => ({ lastSummary: {}, consecutiveFailures: 0, needsReauth: [] });

// ── scheduling ─────────────────────────────────────────────────────────────

export function backoffMs(intervalMin: number, consecutiveFailures: number): number {
  return Math.min(intervalMin * 60_000 * 2 ** Math.max(0, consecutiveFailures), BACKOFF_CAP_MS);
}

/** Epoch ms when the next pass is due; 0 = never ran, due now. */
export function nextDueAt(state: SourcesSyncState, intervalMin: number): number {
  if (!state.lastRunAt) return 0;
  return Date.parse(state.lastRunAt) + backoffMs(intervalMin, state.consecutiveFailures);
}

/**
 * Which kinds to pull right now: none when the pass is not due; otherwise every configured
 * kind except those awaiting re-auth — which join only when their 2-hourly probe is due, so a
 * dead grant costs one failing request per two hours instead of one per pass.
 */
export function planPull(state: SourcesSyncState, configured: SourceKind[], intervalMin: number, now: Date): SourceKind[] {
  if (now.getTime() < nextDueAt(state, intervalMin)) return [];
  const probeDue = !state.reauthProbeAt || now.getTime() - Date.parse(state.reauthProbeAt) >= REAUTH_PROBE_MS;
  return configured.filter((k) => !state.needsReauth.includes(k) || probeDue);
}

const total = (s: PullSummary): number => Object.values(s.counts).reduce((a, b) => a + b, 0);

/** Fold one pass's results into the state. `error` = the pass itself threw (no summaries). */
export function applyRun(state: SourcesSyncState, kindsPlanned: SourceKind[], summaries: PullSummary[], now: Date, error?: string): SourcesSyncState {
  const next: SourcesSyncState = {
    ...state,
    lastRunAt: now.toISOString(),
    lastSummary: { ...state.lastSummary },
    needsReauth: [...state.needsReauth],
  };
  delete next.lastError;
  for (const s of summaries) {
    next.lastSummary[s.kind] = { ok: s.ok, reauth: s.reauth, records: total(s), finishedAt: s.finishedAt, errors: s.errors.slice(0, 3) };
    if (s.reauth) {
      if (!next.needsReauth.includes(s.kind)) next.needsReauth.push(s.kind);
    } else if (s.ok) {
      next.needsReauth = next.needsReauth.filter((k) => k !== s.kind);
    }
  }
  // The detection itself counts as a probe: a kind that just turned dead must wait the full
  // REAUTH_PROBE_MS before it is tried again, same as one re-probed and still dead.
  if (summaries.some((s) => s.reauth) || kindsPlanned.some((k) => state.needsReauth.includes(k))) next.reauthProbeAt = now.toISOString();
  const allOk = !error && summaries.length > 0 && summaries.every((s) => s.ok);
  if (error) next.lastError = error;
  // A pass that only re-probed dead grants and found them still dead is not a NEW failure:
  // backoff is for transient trouble; re-auth has its own 2-hour cadence.
  const onlyReauthFailures = !error && summaries.every((s) => s.ok || s.reauth);
  next.consecutiveFailures = allOk ? 0 : onlyReauthFailures && summaries.length ? state.consecutiveFailures : state.consecutiveFailures + 1;
  if (allOk) next.lastOkAt = now.toISOString();
  return next;
}

// ── facts round-trip ───────────────────────────────────────────────────────

export function toFact(slug: string, state: SourcesSyncState, now: Date): Fact {
  return {
    subject: projectSubject(slug),
    predicate: SOURCES_SYNC,
    value: state,
    // Provenance: the archive the pass wrote and the config that asked for it.
    sources: [`data/${slug}/raw`, 'projects.config.json#sources'],
    observedAt: now.toISOString(),
  };
}

export function fromFact(fact: Fact | undefined): SourcesSyncState {
  const v = fact?.value as Partial<SourcesSyncState> | undefined;
  if (!v || typeof v !== 'object') return emptySyncState();
  return {
    ...emptySyncState(),
    ...v,
    lastSummary: v.lastSummary ?? {},
    consecutiveFailures: typeof v.consecutiveFailures === 'number' ? v.consecutiveFailures : 0,
    needsReauth: Array.isArray(v.needsReauth) ? v.needsReauth : [],
  };
}

export const readSyncState = (facts: FactStore, slug: string): SourcesSyncState => fromFact(facts.get(slug, projectSubject(slug), SOURCES_SYNC));
export const writeSyncState = (facts: FactStore, slug: string, state: SourcesSyncState, now: Date): void => facts.put(slug, toFact(slug, state, now));

// ── status line ────────────────────────────────────────────────────────────

const hhmm = (iso: string, tz: string): string => {
  const p = nowParts(tz, new Date(iso));
  return `${String(p.ho).padStart(2, '0')}:${String(p.mi).padStart(2, '0')}`;
};

/** `sources: last pull 13:45, 327 records, next in 7m | reauth needed: google` */
export function statusLine(state: SourcesSyncState, intervalMin: number, now: Date, tz: string): string {
  const parts: string[] = [];
  if (!state.lastRunAt) parts.push('never pulled, due now');
  else {
    const records = Object.values(state.lastSummary).reduce((a, s) => a + (s?.records ?? 0), 0);
    const dueIn = Math.max(0, Math.round((nextDueAt(state, intervalMin) - now.getTime()) / 60_000));
    parts.push(`last pull ${hhmm(state.lastRunAt, tz)}, ${records} records, ${dueIn ? `next in ${dueIn}m` : 'due now'}`);
    if (state.consecutiveFailures) parts.push(`${state.consecutiveFailures} failing`);
  }
  const line = `sources: ${parts.join(', ')}`;
  return state.needsReauth.length ? `${line} | reauth needed: ${state.needsReauth.join(', ')}` : line;
}

// ── daily auth check ───────────────────────────────────────────────────────

/**
 * Returns the day key ("mon-dom") when the 06:00 (tz) health check is due and has not run
 * today, else undefined. The window is the whole 06:xx hour: a 60-second tick must not miss
 * it because the process started at 06:00:30.
 */
export function authCheckDue(now: Date, tz: string, lastDayKey: string | undefined): string | undefined {
  const p = nowParts(tz, now);
  if (p.ho !== AUTH_CHECK_HOUR) return undefined;
  const key = `${p.mon}-${p.dom}`;
  return key === lastDayKey ? undefined : key;
}

// ── the ticker ─────────────────────────────────────────────────────────────

export interface TickerDeps {
  projects: () => ProjectConfig[];
  facts: FactStore;
  /** Pull the given kinds of one project and return the pullers' summaries. */
  pull: (project: ProjectConfig, kinds: SourceKind[]) => Promise<PullSummary[]>;
  alert: (text: string) => void;
  now: () => Date;
  log?: (line: string) => void;
}

export interface SourcesTicker {
  tick(): Promise<void>;
  /** Slugs with a pass in flight (single-flight guard; exposed for tests and status). */
  readonly pulling: ReadonlySet<string>;
}

export function createSourcesTicker(d: TickerDeps): SourcesTicker {
  const pulling = new Set<string>();
  // One alert per distinct (slug, kinds) re-auth situation — cleared when it recovers, so the
  // same dead grant does not nag every two hours but a NEW dead kind still alerts.
  const reauthAlerted = new Map<string, string>();
  const info = d.log ?? (() => undefined);

  async function runProject(p: ProjectConfig): Promise<void> {
    const intervalMin = p.sources?.intervalMinutes ?? DEFAULT_INTERVAL_MIN;
    const state = readSyncState(d.facts, p.slug);
    const kinds = planPull(state, configuredKinds(p), intervalMin, d.now());
    if (!kinds.length) return;
    pulling.add(p.slug);
    const startedAt = d.now();
    let next: SourcesSyncState;
    try {
      const summaries = await d.pull(p, kinds);
      next = applyRun(state, kinds, summaries, startedAt);
    } catch (e) {
      next = applyRun(state, kinds, [], startedAt, e instanceof Error ? e.message : String(e));
      info(`[sources:${p.slug}] pass failed: ${next.lastError}`);
    } finally {
      pulling.delete(p.slug);
    }
    writeSyncState(d.facts, p.slug, next, d.now());
    const key = next.needsReauth.join(',');
    if (key && reauthAlerted.get(p.slug) !== key) {
      reauthAlerted.set(p.slug, key);
      d.alert(`sources *${p.slug}*: re-auth needed for ${key} — run \`orch sources auth ${p.slug} <kind> …\` on the bot host; pulls of the other kinds continue.`);
    } else if (!key) reauthAlerted.delete(p.slug);
  }

  return {
    pulling,
    async tick(): Promise<void> {
      // Projects run sequentially: one process, one disk, and the pullers already parallelise
      // inside (accounts, conversations). Parallel projects would only compete for the API caps.
      for (const p of d.projects()) {
        if (!p.sources || pulling.has(p.slug)) continue;
        await runProject(p);
      }
    },
  };
}
