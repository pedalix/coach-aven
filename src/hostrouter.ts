// The per-session routes of the in-process MCP servers the bot serves (hosttools.ts is the pure
// part, claudeSession.ts the framing). Built once in the composition root (chat/slack/app.ts) and
// handed to the turn engine (TurnDeps.hostRoutes); `routesFor` runs when a session opens and returns
// what that session registers with the CLI:
//   • `host`    — while DISPATCH=1: propose + registry (the dispatch primitive's own server; it
//                 replaced a stdio server in the sandbox and its outbox mount). For a project with a
//                 `messaging` block, also the messaging tools (agent-messaging D9): send_message,
//                 get_task, cancel_task, agents with `send`, request_input in a shadow conversation —
//                 which never gets propose/registry (nobody can click there). Nothing without either.
//                 Registered when the session opens: an open session gets new tools after a restart.
//   • `sources` — a project with a `sources` block: the sources tool table over the replica on this
//                 disk, answered on a worker thread (sources/worker.mjs). Bucket 2: only sources
//                 projects are affected, and no prod project has one. With `sources.daemon` the
//                 tools/calls go to the daemon that holds the data (sources/daemonclient.ts); the
//                 static answers (initialize, tools/list) stay on the worker, so a session opens
//                 even while the daemon is away.
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
import { forwardToDaemon } from './sources/daemonclient.js';
import type { DaemonConfig } from './sources/types.js';
import { REPLICA_FILE } from './sources/store.js';
import { log } from './log.js';
import type { Messaging } from './messaging/service.js';
import { messagingTools } from './messaging/tools.js';
import { parseShadowKey } from './chat/shadow/driver.js';

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
  /** Forwards a tools/call to a project's daemon (default: forwardToDaemon over HTTP). */
  forward?: (cfg: DaemonConfig, slug: string, message: JsonRpc) => Promise<JsonRpc | undefined>;
  tz?: string; // default: AVEN_TZ (the zone bare dates are read in)
  /** Agent messaging (late-bound: the service is built after the engine); absent → no messaging tools. */
  messaging?: () => Messaging | undefined;
}

/** Pure: does the project declare its own server under this name? Then the bot registers none (it keeps its own). */
export function declares(project: ProjectConfig, name: string): boolean {
  return (project.mcp ?? []).some((s) => s.name === name);
}

export function createHostRouter(d: HostRouterDeps): HostRouter {
  const dispatchOn = d.dispatchEnabled ?? dispatch.enabled;
  const replicaPath = d.replicaPath ?? ((slug: string) => join(replicaDir(slug), REPLICA_FILE));
  const sources = d.sources ?? sourcesWorker(d.tz ?? sourcesTimezone());
  const forward = d.forward ?? ((cfg: DaemonConfig, slug: string, m: JsonRpc) => forwardToDaemon(cfg, slug, m));
  return {
    routesFor(caller, project) {
      const routes: HostServerRoute[] = [];
      const shadow = parseShadowKey(caller.conversationKey) !== undefined;
      const m = project.messaging !== undefined ? d.messaging?.() : undefined;
      if ((dispatchOn || m) && !declares(project, HOST_SERVER_NAME)) {
        const tools = [
          ...(dispatchOn && !shadow
            ? hostToolTable(caller, {
                projects: (c) =>
                  teamProjects(d.reg.current, c.teamId ?? d.home(), d.home()).map((p) => ({
                    slug: p.slug,
                    ...(p.slackChannel ? { channel: p.slackChannel } : {}),
                    ...(p.slug === c.slug ? { self: true } : {}),
                  })),
                propose: (c, record) => d.propose(c.slug, record),
              })
            : []),
          ...(m ? messagingTools(caller, m, { send: project.messaging!.send === true, shadow }) : []),
        ];
        if (tools.length) routes.push({ name: HOST_SERVER_NAME, timeoutMs: HOST_TIMEOUT_MS, handle: mcpServer(HOST_SERVER_NAME, tools) });
      }
      if (project.sources !== undefined && !declares(project, SOURCES_SERVER_NAME)) {
        const db = replicaPath(project.slug);
        const daemon = project.sources.daemon;
        routes.push({
          name: SOURCES_SERVER_NAME,
          timeoutMs: SOURCES_TIMEOUT_MS,
          handle: daemon ? (m) => daemonRoute(m, daemon, project.slug, sources, forward) : (m) => sourcesRoute(m, db, project.slug, sources),
        });
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
 * A daemon project's route: tools/call goes to the daemon; everything else (initialize, tools/list, ping,
 * notifications) is answered by the local table, which needs no data. A daemon that does not answer is a
 * tool error the agent reads — the prompt tells it to say so in one line — never a dead server.
 */
export async function daemonRoute(m: JsonRpc, cfg: DaemonConfig, slug: string, local: SourcesCall, forward: (cfg: DaemonConfig, slug: string, m: JsonRpc) => Promise<JsonRpc | undefined>): Promise<JsonRpc | undefined> {
  if (m.method !== 'tools/call') return sourcesRoute(m, '', slug, local);
  const isRequest = m.id !== undefined && m.id !== null;
  const started = Date.now();
  try {
    const r = await forward(cfg, slug, m);
    log.info(`[sources:${slug}] daemon ${String((m.params as { name?: unknown } | undefined)?.name ?? '?')} ${Date.now() - started} ms`);
    return r;
  } catch (e) {
    if (!isRequest) return undefined;
    const why = e instanceof Error ? (e.name === 'TimeoutError' ? 'no answer in time' : e.message) : String(e);
    return { jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: `sources: the daemon for ${slug} is unavailable (${why})` }], isError: true } };
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
