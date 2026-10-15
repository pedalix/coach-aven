// The per-session routes of the in-process MCP servers the bot serves (hosttools.ts is the pure
// part, claudeSession.ts the framing). Built once in the composition root (chat/slack/app.ts) and
// handed to the turn engine (TurnDeps.hostRoutes); `routesFor` runs when a session opens and returns
// what that session registers with the CLI:
//   • `host`    — while DISPATCH=1: propose + registry (the dispatch primitive's own server; it
//                 replaced a stdio server in the sandbox and its outbox mount).
//   • `sources` — a project with a `sources` block: the sources tool table over the replica on this
//                 disk, answered on a worker thread (sources/worker.mjs). Bucket 2: only sources
//                 projects are affected, and no prod project has one.
// A project that declares its own MCP server under either name keeps it; the bot registers nothing
// under that name, so the two never compete.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import type { ProjectConfig, RegistryRef } from './projects.js';
import { teamProjects } from './projects.js';
import { dispatch, type ProposalRecord, type ProposeOutcome } from './dispatch.js';
import { hostToolTable, mcpServer, type HostCaller, type HostServerRoute, type JsonRpc } from './hosttools.js';
import { sourcesTimezone, SOURCES_SERVER_NAME } from './sources/mcp.js';
import { replicaDir } from './sources/paths.js';
import { REPLICA_FILE } from './sources/store.js';
import { log } from './log.js';

export const HOST_SERVER_NAME = 'host';
/** tools/call limits the CLI enforces per server: host tools are small; a sources call can be a second or more. */
export const HOST_TIMEOUT_MS = 30_000;
export const SOURCES_TIMEOUT_MS = 90_000;
/** The bot gives up on a sources call a little before the CLI does, so the agent reads our error, not a bare timeout. */
export const SOURCES_CALL_MS = 85_000;

export interface HostRouter {
  routesFor(caller: HostCaller, project: ProjectConfig): HostServerRoute[];
}

/** Answers one sources JSON-RPC message against one replica (the worker in production, in-process in tests). */
export type SourcesCall = (message: JsonRpc, dbPath: string) => Promise<JsonRpc | undefined>;

export interface HostRouterDeps {
  reg: RegistryRef;
  home: () => string | undefined;
  /** The dispatcher's `propose` (late-bound in the composition root: the dispatcher is built after the engine). */
  propose: (slug: string, record: ProposalRecord) => Promise<ProposeOutcome>;
  dispatchEnabled?: boolean; // default: the DISPATCH flag
  replicaPath?: (slug: string) => string;
  sources?: SourcesCall; // default: the worker thread
  tz?: string; // default: AVEN_TZ (the zone bare dates are read in)
}

/** Pure: does the project declare its own server under this name? Then the bot registers none (it keeps its own). */
export function declares(project: ProjectConfig, name: string): boolean {
  return (project.mcp ?? []).some((s) => s.name === name);
}

export function createHostRouter(d: HostRouterDeps): HostRouter {
  const dispatchOn = d.dispatchEnabled ?? dispatch.enabled;
  const replicaPath = d.replicaPath ?? ((slug: string) => join(replicaDir(slug), REPLICA_FILE));
  const sources = d.sources ?? sourcesWorker(d.tz ?? sourcesTimezone());
  return {
    routesFor(caller, project) {
      const routes: HostServerRoute[] = [];
      if (dispatchOn && !declares(project, HOST_SERVER_NAME)) {
        const tools = hostToolTable(caller, {
          projects: (c) =>
            teamProjects(d.reg.current, c.teamId ?? d.home(), d.home()).map((p) => ({
              slug: p.slug,
              ...(p.slackChannel ? { channel: p.slackChannel } : {}),
              ...(p.slug === c.slug ? { self: true } : {}),
            })),
          propose: (c, record) => d.propose(c.slug, record),
        });
        routes.push({ name: HOST_SERVER_NAME, timeoutMs: HOST_TIMEOUT_MS, handle: mcpServer(HOST_SERVER_NAME, tools) });
      }
      if (project.sources !== undefined && !declares(project, SOURCES_SERVER_NAME)) {
        const db = replicaPath(project.slug);
        routes.push({ name: SOURCES_SERVER_NAME, timeoutMs: SOURCES_TIMEOUT_MS, handle: (m) => sourcesRoute(m, db, project.slug, sources) });
      }
      return routes;
    },
  };
}

/** A missing replica answers a tools/call as a tool error the agent reads (the prompt says what to do); everything else goes to the table. */
export async function sourcesRoute(m: JsonRpc, dbPath: string, slug: string, call: SourcesCall): Promise<JsonRpc | undefined> {
  const isRequest = m.id !== undefined && m.id !== null && typeof m.method === 'string';
  if (isRequest && m.method === 'tools/call' && !existsSync(dbPath)) {
    return { jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: `sources: the replica for ${slug} is not available yet` }], isError: true } };
  }
  try {
    return await call(m, dbPath);
  } catch (e) {
    if (!isRequest) return undefined;
    return { jsonrpc: '2.0', id: m.id, error: { code: -32603, message: `sources: ${e instanceof Error ? e.message : String(e)}` } };
  }
}

/**
 * The production SourcesCall: one worker thread for the whole bot, started on first use and
 * restarted after it dies or a call outlives SOURCES_CALL_MS (a wedged query must not block every
 * later call). Pending calls of a dead worker reject; the route turns that into a JSON-RPC error.
 */
export function sourcesWorker(tz: string, callMs = SOURCES_CALL_MS): SourcesCall {
  type Pending = { resolve: (r: JsonRpc | undefined) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> };
  let worker: { w: Worker; pending: Map<number, Pending> } | undefined;
  let seq = 0;
  const start = () => {
    // execArgv []: the worker runs plain .mjs only — no tsx loader, no test-runner flags inherited.
    const w = new Worker(new URL('./sources/worker.mjs', import.meta.url), { workerData: { tz }, execArgv: [] });
    const pending = new Map<number, Pending>(); // per worker: a restart never fails the new worker's calls
    w.on('message', (msg: { seq: number; reply?: JsonRpc | null; error?: string }) => {
      const p = pending.get(msg.seq);
      if (!p) return;
      pending.delete(msg.seq);
      clearTimeout(p.timer);
      if (msg.error !== undefined) p.reject(new Error(msg.error));
      else p.resolve(msg.reply ?? undefined);
    });
    w.on('error', (e) => log.error(`sources worker: ${e.message}`));
    w.on('exit', (code) => {
      if (worker?.w === w) worker = undefined;
      for (const p of pending.values()) {
        clearTimeout(p.timer);
        p.reject(new Error(`the sources worker exited (${code})`));
      }
      pending.clear();
    });
    // After the listeners: attaching a 'message' listener re-refs the worker's port, which would
    // undo an earlier unref and keep a finished CLI or test process alive.
    w.unref();
    return { w, pending };
  };
  return (message, dbPath) =>
    new Promise<JsonRpc | undefined>((resolve, reject) => {
      worker ??= start();
      const cur = worker;
      const id = ++seq;
      const timer = setTimeout(() => {
        cur.pending.delete(id);
        reject(new Error(`no answer within ${Math.round(callMs / 1000)} s — the worker is restarted`));
        if (worker === cur) worker = undefined;
        void cur.w.terminate(); // its other pending calls fail with the exit; the next call starts a fresh worker
      }, callMs);
      cur.pending.set(id, { resolve, reject, timer });
      cur.w.postMessage({ seq: id, message, dbPath });
    });
}
