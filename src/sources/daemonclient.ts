// The bot's side of a sources daemon (OpenSpec sources-daemon). A project with `sources.daemon` has its
// data where the daemon runs, not on the bot host: the bot forwards the agent's `tools/call`s to
// `<url>/mcp/<slug>` (initialize and tools/list stay local — the table is static, so a session opens
// even while the daemon is away) and reads `<url>/status/<slug>` instead of local files for
// `/aven status`, the empty-slot skip and the ops alerts. `SourcesViews` hides the difference: callers
// ask it for a project's view and get the same shape from facts + files or from the daemon's last status.
import { FactStore } from '../facts.js';
import type { ProjectConfig } from '../projects.js';
import { replicaDir } from './paths.js';
import { REPLICA_FILE, rawRecordCount } from './store.js';
import { emptySyncState, readSyncState, type SourcesSyncState } from './sync.js';
import { readDueNow, type DueNow } from './tenant.js';
import type { DaemonAlert, DaemonStatus } from './daemon.js';
import type { DaemonConfig } from './types.js';
import type { JsonRpc } from '../hosttools.js';
import { join } from 'node:path';

export type FetchFn = (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{ status: number; text(): Promise<string> }>;

/** A forwarded tools/call gives up a little before the CLI's 90 s, so the agent reads our message. */
export const DAEMON_CALL_MS = 85_000;
export const DAEMON_STATUS_MS = 5_000;
/** A status older than this is not trusted: the project reads as unreachable (the empty-slot skip then fires). */
export const STATUS_FRESH_MS = 3 * 60_000;
/** Unreachable this long → one ops alert (and one when it is back). */
export const UNREACHABLE_ALERT_MS = 10 * 60_000;

export interface DaemonClientOptions {
  env?: NodeJS.ProcessEnv;
  fetchFn?: FetchFn;
}

function bearer(cfg: DaemonConfig, env: NodeJS.ProcessEnv): string {
  const t = env[cfg.tokenEnv];
  if (!t) throw new Error(`${cfg.tokenEnv} is not set on the bot`);
  return t;
}

const defaultFetch: FetchFn = (url, init) => fetch(url, init);

/** POST one JSON-RPC message to the daemon; a JSON-RPC answer (even with HTTP 503) is returned as-is, anything else throws. */
export async function forwardToDaemon(cfg: DaemonConfig, slug: string, message: JsonRpc, o: DaemonClientOptions & { timeoutMs?: number } = {}): Promise<JsonRpc | undefined> {
  const res = await (o.fetchFn ?? defaultFetch)(`${cfg.url}/mcp/${slug}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json', authorization: `Bearer ${bearer(cfg, o.env ?? process.env)}` },
    body: JSON.stringify(message),
    signal: AbortSignal.timeout(o.timeoutMs ?? DAEMON_CALL_MS),
  });
  if (res.status === 202) return undefined;
  const text = await res.text();
  try {
    const j = JSON.parse(text) as JsonRpc;
    if (j && j.jsonrpc === '2.0') return j;
  } catch {
    /* not JSON — the status line below says what happened */
  }
  throw new Error(`the sources daemon answered HTTP ${res.status}`);
}

export async function fetchDaemonStatus(cfg: DaemonConfig, slug: string, o: DaemonClientOptions & { timeoutMs?: number } = {}): Promise<DaemonStatus> {
  const res = await (o.fetchFn ?? defaultFetch)(`${cfg.url}/status/${slug}`, {
    method: 'GET',
    headers: { accept: 'application/json', authorization: `Bearer ${bearer(cfg, o.env ?? process.env)}` },
    signal: AbortSignal.timeout(o.timeoutMs ?? DAEMON_STATUS_MS),
  });
  if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
  const s = JSON.parse(await res.text()) as DaemonStatus;
  if (!s || s.slug !== slug || typeof s.sync !== 'object') throw new Error('not a daemon status');
  return s;
}

/** What the bot knows about a project's sources, wherever they live. */
export interface SourcesView {
  sync: SourcesSyncState;
  /** Absent = unreadable (no replica, or a daemon without a fresh status) — the empty-slot skip fires. */
  rawRecords?: number;
  /** Absent = unreadable (no tenant checkout, or no fresh status). */
  due?: DueNow;
  /** Always true for local data; false while a daemon has no fresh status. */
  reachable: boolean;
  /** ISO since when the daemon fails to answer. */
  unreachableSince?: string;
  error?: string;
}

interface CacheEntry {
  status?: DaemonStatus;
  at?: number;
  failingSince?: number;
  error?: string;
}

export interface Notice {
  text: string;
  level: 'warning' | 'info';
}

export class SourcesViews {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly lastAlertAt = new Map<string, string>();
  private readonly unreachableAlerted = new Set<string>();

  constructor(
    private readonly facts: FactStore = new FactStore(),
    private readonly o: DaemonClientOptions & { now?: () => Date; startedAt?: string } = {},
  ) {}

  private now(): Date {
    return this.o.now?.() ?? new Date();
  }

  /** Synchronous: local files, or the daemon's last status (refreshed by `refresh`, the bot's minute poller). */
  view(p: ProjectConfig, today: string): SourcesView {
    const d = p.sources?.daemon;
    if (!d) {
      const raw = rawRecordCount(join(replicaDir(p.slug), REPLICA_FILE));
      const due = p.sources?.tenant ? readDueNow(p.slug, p.sources.tenant, today) : { escalationsOpen: 0, commitmentsDue: 0 };
      return { sync: readSyncState(this.facts, p.slug), ...(raw !== undefined ? { rawRecords: raw } : {}), ...(due ? { due } : {}), reachable: true };
    }
    const c = this.cache.get(p.slug);
    const fresh = !!c?.status && c.at !== undefined && this.now().getTime() - c.at <= STATUS_FRESH_MS;
    if (!fresh) {
      return {
        sync: c?.status?.sync ?? emptySyncState(),
        reachable: false,
        ...(c?.failingSince !== undefined ? { unreachableSince: new Date(c.failingSince).toISOString() } : {}),
        ...(c?.error ? { error: c.error } : {}),
      };
    }
    const s = c!.status!;
    return { sync: s.sync, ...(s.rawRecords !== undefined ? { rawRecords: s.rawRecords } : {}), ...(s.due ? { due: s.due } : {}), reachable: true };
  }

  /**
   * Ask the daemon for its status, cache it, and say what the operator should hear: the daemon's own
   * alerts raised since the bot started (re-auth, failed auth checks — the daemon has no chat), one alert
   * after UNREACHABLE_ALERT_MS of silence and one when it answers again.
   */
  async refresh(p: ProjectConfig): Promise<Notice[]> {
    const d = p.sources?.daemon;
    if (!d) return [];
    const nowMs = this.now().getTime();
    const cur = this.cache.get(p.slug) ?? {};
    const out: Notice[] = [];
    try {
      const status = await fetchDaemonStatus(d, p.slug, this.o);
      if (this.unreachableAlerted.delete(p.slug)) out.push({ text: `sources *${p.slug}*: the daemon at ${d.url} answers again`, level: 'info' });
      this.cache.set(p.slug, { status, at: nowMs });
      const since = this.lastAlertAt.get(p.slug) ?? this.o.startedAt ?? new Date(nowMs).toISOString();
      const fresh: DaemonAlert[] = status.alerts.filter((a) => a.at > since);
      for (const a of fresh) out.push({ text: a.text, level: 'warning' });
      const last = status.alerts.at(-1)?.at;
      if (last && last > since) this.lastAlertAt.set(p.slug, last);
    } catch (e) {
      const failingSince = cur.failingSince ?? nowMs;
      const error = e instanceof Error ? e.message : String(e);
      this.cache.set(p.slug, { ...cur, failingSince, error });
      if (nowMs - failingSince >= UNREACHABLE_ALERT_MS && !this.unreachableAlerted.has(p.slug)) {
        this.unreachableAlerted.add(p.slug);
        out.push({ text: `sources *${p.slug}*: the daemon at ${d.url} has not answered since ${new Date(failingSince).toISOString()} (${error}) — the agent's sources calls fail and routines fire without the empty-slot check`, level: 'warning' });
      }
    }
    return out;
  }
}

/** The bot's one instance (pollers refresh it, `/aven status` and the routines read it). */
export const sourcesViews = new SourcesViews(new FactStore(), { startedAt: new Date().toISOString() });
