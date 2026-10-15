// `orch sources daemon` (OpenSpec sources-daemon): ingest and serve in ONE process where a project's
// data lives. The bot used to do both inside its own process (pollers.ts ticker + the replica on its
// disk); a tenant whose data belongs elsewhere — Bluefin's VM for bluefin-ops, a laptop for `local`
// sources, any customer of a public bot — runs this instead, and the bot keeps nothing but a URL and
// a bearer (`sources.daemon` in the project config).
//
//   • ingest: the same ticker as the bot (sync.ts: per-project interval, backoff, re-auth parking),
//     pull → tenant checkout → store build → replica, one project at a time; the daily 06:00 auth
//     check; one writer per project via data/<slug>/.lock (lock.ts) — a second daemon or a bot that
//     still ingests the project refuses to start / skips.
//   • serve: `POST /mcp/<slug>` answers the sources tool table over the project's replica (the bot
//     forwards the agent's calls verbatim — serve.ts's stateless JSON-RPC face, now routed by slug),
//     `GET /status/<slug>` returns what the bot used to read from local files: the sync state, the raw
//     record count, what the tenant ledgers say is due, the replica's age, recent alerts and the last
//     auth check — so `/aven status`, the empty-slot skip and the ops alerts work without the files.
//   • one bearer (SOURCES_DAEMON_TOKEN); the bot is the only client. `GET /health` is open and says
//     nothing but ok.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { existsSync, statSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { FactStore } from '../facts.js';
import { localDate } from '../routineguard.js';
import type { ProjectConfig } from '../projects.js';
import { acquireLock, describeLock, releaseLock } from './lock.js';
import { replicaDir } from './paths.js';
import { authCheck, configuredKinds, pullProject, tenantZone } from './run.js';
import { authorized, handleHttp, MAX_BODY, MCP_PATH, parseListen } from './serve.js';
import { REPLICA_FILE, rawRecordCount } from './store.js';
import { authCheckDue, createSourcesTicker, readSyncState, type SourcesSyncState, type SourcesTicker } from './sync.js';
import { readDueNow, type DueNow } from './tenant.js';
import type { PullSummary, SourceKind } from './types.js';

export const DAEMON_TOKEN_ENV = 'SOURCES_DAEMON_TOKEN';
export const DAEMON_LISTEN = '127.0.0.1:3416';
const TICK_MS = 60_000;
const ALERTS_KEPT = 20;

export interface DaemonAlert {
  at: string;
  text: string;
}

export interface AuthCheckReport {
  day: string;
  failed: { kind: string; code: number; tail: string }[];
}

/** What `GET /status/<slug>` returns — everything the bot needs instead of the project's files. */
export interface DaemonStatus {
  slug: string;
  sync: SourcesSyncState;
  /** Raw records in the replica (the empty-slot fingerprint); absent = no readable replica. */
  rawRecords?: number;
  /** Open escalations and commitments due today in the tenant's zone; absent = no tenant checkout. */
  due?: DueNow;
  replicaAt?: string;
  pulling: boolean;
  alerts: DaemonAlert[];
  authCheck?: AuthCheckReport;
  daemon: { pid: number; host: string; startedAt: string };
}

export interface DaemonHttpDeps {
  token: string;
  /** The served slugs (anything else is 404 without details). */
  served: () => ReadonlySet<string>;
  replicaPath: (slug: string) => string;
  status: (slug: string) => DaemonStatus;
}

const json = (status: number, body: unknown): { status: number; body: string; headers: Record<string, string> } => ({
  status,
  body: JSON.stringify(body),
  headers: { 'content-type': 'application/json' },
});

/**
 * Pure: one HTTP request → status + body (the test drives the whole surface without sockets).
 * `/mcp/<slug>` reuses serve.ts's JSON-RPC handling over that slug's replica; `/status/<slug>` is
 * bearer-protected like it; `/health` is open and carries nothing tenant-specific.
 */
export function handleDaemonHttp(
  method: string,
  url: string,
  headers: Record<string, string | undefined>,
  body: string,
  d: DaemonHttpDeps,
): { status: number; body: string; headers: Record<string, string> } {
  const path = url.split('?')[0] ?? url;
  if (path === '/health' && method === 'GET') return json(200, { ok: true });
  const m = /^\/(mcp|status)\/([a-z0-9][a-z0-9-]{0,62})$/.exec(path);
  if (!m) return { status: 404, body: '', headers: {} };
  if (!authorized(headers.authorization, d.token)) return { status: 401, body: '', headers: { 'www-authenticate': 'Bearer' } };
  const slug = m[2]!;
  if (!d.served().has(slug)) return { status: 404, body: '', headers: {} };
  if (m[1] === 'status') {
    if (method !== 'GET') return { status: 405, body: '', headers: { allow: 'GET' } };
    return json(200, d.status(slug));
  }
  return handleHttp(method, MCP_PATH, headers, body, { dbPath: d.replicaPath(slug), token: d.token, slug });
}

export function startDaemonServer(listen: string, d: DaemonHttpDeps, log: (line: string) => void): Promise<Server> {
  const { host, port } = parseListen(listen);
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let body = '';
    let over = false;
    req.on('data', (chunk: Buffer) => {
      if (over) return;
      body += chunk.toString('utf8');
      if (body.length > MAX_BODY) {
        over = true;
        res.writeHead(413).end();
        req.destroy();
      }
    });
    req.on('end', () => {
      if (over) return;
      const headers: Record<string, string | undefined> = {};
      for (const [k, v] of Object.entries(req.headers)) headers[k.toLowerCase()] = Array.isArray(v) ? v[0] : v;
      let r: ReturnType<typeof handleDaemonHttp>;
      try {
        r = handleDaemonHttp(req.method ?? 'GET', req.url ?? '/', headers, body, d);
      } catch (e) {
        log(`sources daemon: ${e instanceof Error ? e.message : String(e)}`);
        r = { status: 500, body: '', headers: {} };
      }
      res.writeHead(r.status, { ...r.headers, ...(r.body ? { 'content-length': String(Buffer.byteLength(r.body)) } : {}) });
      res.end(r.body);
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve(server));
  });
}

export interface DaemonOptions {
  projects: ProjectConfig[];
  listen: string;
  token: string;
  log: (line: string) => void;
  /** Injectable for tests; default pullProject(…, { only: kinds, build: true }). */
  pull?: (p: ProjectConfig, kinds: SourceKind[]) => Promise<PullSummary[]>;
  facts?: FactStore;
  now?: () => Date;
  tickMs?: number;
}

export interface RunningDaemon {
  server: Server;
  tickers: Map<string, SourcesTicker>;
  status: (slug: string) => DaemonStatus;
  tick: () => Promise<void>;
  stop: () => Promise<void>;
}

/**
 * Take every project's lock, start the per-project tickers (run one after another on a shared
 * minute tick, as in the bot) and the HTTP face. Throws — before touching any data — when another
 * live process ingests one of the projects.
 */
export async function runDaemon(o: DaemonOptions): Promise<RunningDaemon> {
  const facts = o.facts ?? new FactStore();
  const now = o.now ?? (() => new Date());
  const startedAt = now().toISOString();
  const projects = o.projects.filter((p) => p.sources);
  const taken: string[] = [];
  for (const p of projects) {
    const holder = acquireLock(p.slug, 'sources daemon');
    if (holder) {
      for (const s of taken) releaseLock(s);
      throw new Error(`${p.slug} is ingested by ${describeLock(holder)} — stop it (or set SOURCES_DAEMON=1 on the bot and restart it) first`);
    }
    taken.push(p.slug);
  }
  const alerts = new Map<string, DaemonAlert[]>();
  const pushAlert = (slug: string, text: string) => {
    const list = [...(alerts.get(slug) ?? []), { at: now().toISOString(), text }].slice(-ALERTS_KEPT);
    alerts.set(slug, list);
    o.log(`[sources:${slug}] ALERT ${text}`);
  };
  const pull = o.pull ?? (async (p, kinds) => (await pullProject(p, { only: kinds, build: true, log: o.log })).summaries);
  const tickers = new Map<string, SourcesTicker>();
  for (const p of projects) {
    tickers.set(p.slug, createSourcesTicker({ projects: () => [p], facts, now, pull, alert: (text) => pushAlert(p.slug, text), log: o.log }));
  }
  const authReports = new Map<string, AuthCheckReport>();
  let lastAuthDay: string | undefined;
  const authZone = process.env.AVEN_TZ ?? 'UTC';
  const tick = async (): Promise<void> => {
    // Projects one after another: one disk, and the pullers parallelise inside (sync.ts).
    for (const t of tickers.values()) await t.tick();
    const day = authCheckDue(now(), authZone, lastAuthDay);
    if (!day) return;
    lastAuthDay = day;
    for (const p of projects) {
      const failed: AuthCheckReport['failed'] = [];
      for (const kind of configuredKinds(p)) {
        const r = await authCheck(p.slug, kind, p);
        if (r.code === 0) continue;
        const tail = r.lines.filter((l) => !l.startsWith('  ')).slice(-4).join('\n');
        failed.push({ kind, code: r.code, tail });
        pushAlert(p.slug, `sources auth check *${p.slug}/${kind}* failed (exit ${r.code}):\n${tail}`);
      }
      authReports.set(p.slug, { day, failed });
    }
  };
  const status = (slug: string): DaemonStatus => {
    const p = projects.find((x) => x.slug === slug)!;
    const replica = join(replicaDir(slug), REPLICA_FILE);
    const rawRecords = rawRecordCount(replica);
    const due = p.sources?.tenant ? readDueNow(slug, p.sources.tenant, localDate(tenantZone(p), now())) : { escalationsOpen: 0, commitmentsDue: 0 };
    const auth = authReports.get(slug);
    return {
      slug,
      sync: readSyncState(facts, slug),
      ...(rawRecords !== undefined ? { rawRecords } : {}),
      ...(due ? { due } : {}),
      ...(existsSync(replica) ? { replicaAt: statSync(replica).mtime.toISOString() } : {}),
      pulling: tickers.get(slug)?.pulling.has(slug) ?? false,
      alerts: alerts.get(slug) ?? [],
      ...(auth ? { authCheck: auth } : {}),
      daemon: { pid: process.pid, host: hostname(), startedAt },
    };
  };
  const served = new Set(projects.map((p) => p.slug));
  let server: Server;
  try {
    server = await startDaemonServer(o.listen, { token: o.token, served: () => served, replicaPath: (slug) => join(replicaDir(slug), REPLICA_FILE), status }, o.log);
  } catch (e) {
    for (const s of taken) releaseLock(s);
    throw e;
  }
  o.log(`sources daemon: ${[...served].join(', ')} on http://${o.listen} (pid ${process.pid})${o.token ? '' : ' (NO TOKEN — refusing every request)'}`);
  let stopping = false;
  const timer = setInterval(() => {
    if (!stopping) void tick().catch((e: unknown) => o.log(`sources daemon tick: ${e instanceof Error ? e.message : String(e)}`));
  }, o.tickMs ?? TICK_MS);
  return {
    server,
    tickers,
    status,
    tick,
    async stop() {
      stopping = true;
      clearInterval(timer);
      await new Promise<void>((r) => server.close(() => r()));
      // A pass in flight finishes (its replica swap is atomic, its state write is the last step); then the locks go.
      for (let i = 0; i < 600 && [...tickers.values()].some((t) => t.pulling.size > 0); i++) await new Promise((r) => setTimeout(r, 100));
      for (const s of taken) releaseLock(s);
    },
  };
}
