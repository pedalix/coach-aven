// One project, one pass: pull every configured source into data/<slug>/raw, then rebuild the
// store and publish the replica. Shared by the operator CLI (`orch sources pull`) and the
// poller (pollers.ts → sync.ts): the two must do exactly the same thing, so the logic lives
// once, here, and both callers only differ in how they log and what they do with the result.
import { dirname, resolve } from 'node:path';
import { loadConfig } from '../config.js';
import type { ProjectConfig } from '../projects.js';
import { log } from '../log.js';
import { runGoogleAuth } from './google/auth.js';
import { pullGoogle } from './google/pull.js';
import { runMsgraphAuth } from './msgraph/auth.js';
import { pullMsgraph } from './msgraph/pull.js';
import { dataDir, ensureDir, rawDir, replicaDir, storePath } from './paths.js';
import { runSlackAuth } from './slack/auth.js';
import { pullSlack } from './slack/pull.js';
import { buildStore, type BuildSummary } from './store.js';
import { tokenPath, vaultPathsFor } from './tokens.js';
import type { AuthContext } from './types.js';
import { SOURCE_KINDS, type GoogleKind, type MsgraphKind, type PullContext, type PullSummary, type SourceKind } from './types.js';

export interface PullProjectOptions {
  /** Restrict to these kinds (default: every configured kind). */
  only?: SourceKind[];
  /** YYYY-MM-DD lower bound for FIRST backfills; overrides the config's `since`. */
  since?: string;
  /** Ignore cursors and resync everything (CLI backfills only — never from the poller). */
  full?: boolean;
  /** Extra Google calendar ids on top of the config's list. */
  calendars?: string[];
  /** msgraph: open every chat (the daily edit/delete sweep). */
  chatsFull?: boolean;
  /** Rebuild store.sqlite + replica after the pull (default true). */
  build?: boolean;
  /** Per-conversation / per-folder log lines. */
  verbose?: boolean;
  /** Where lines go; default the bot log. The poller keeps the default, the CLI too. */
  log?: (line: string) => void;
}

export interface PullProjectResult {
  summaries: PullSummary[];
  build?: BuildSummary;
  /** Every puller succeeded. */
  ok: boolean;
  /** At least one puller needs a human to re-run `orch sources auth …`. */
  reauth: boolean;
}

/** People file: `sources.people` relative to projects.config.json, else projects.d/<slug>.people.json beside it. */
export function peoplePath(p: ProjectConfig, projectsConfigPath = loadConfig().projectsConfigPath): string {
  const base = dirname(projectsConfigPath);
  return resolve(base, p.sources?.people ?? `projects.d/${p.slug}.people.json`);
}

export function pullContext(slug: string, kind: SourceKind, verbose: boolean, sink: (line: string) => void): PullContext {
  const out = ensureDir(rawDir(slug));
  ensureDir(dataDir(slug));
  const prefix = `[sources:${slug}/${kind}]`;
  return {
    slug,
    outDir: out,
    tokenPath: tokenPath(slug, kind),
    vault: vaultPathsFor(slug),
    log: (line) => (verbose || !line.startsWith('  ') ? sink(`${prefix} ${line}`) : undefined),
  };
}

export function runBuild(p: ProjectConfig, verbose: boolean, sink: (line: string) => void = log.info.bind(log), projectsConfigPath?: string): BuildSummary {
  const prefix = `[sources:${p.slug}/store]`;
  const s = buildStore({
    slug: p.slug,
    rawDir: rawDir(p.slug),
    storePath: storePath(p.slug),
    replicaDir: replicaDir(p.slug),
    peoplePath: peoplePath(p, projectsConfigPath),
    log: (line) => (verbose || !line.startsWith('  ') ? sink(`${prefix} ${line}`) : undefined),
  });
  sink(
    `${prefix} ${s.lines} new lines from ${s.files} files → messages ${s.messages}, events ${s.events}, files ${s.fileRecords}, tombstones ${s.tombstones}` +
      `${s.replayed ? `, replayed ${s.replayed}` : ''}${s.malformed ? `, malformed ${s.malformed}` : ''}; people ${s.people}; replica ${s.replica ?? '(none)'}`,
  );
  for (const f of s.truncatedFiles) log.warn(`${prefix} ${f} shrank below its consumed offset — re-read from 0`);
  for (const f of s.skippedFiles) log.warn(`${prefix} ${f}: unknown raw file name, skipped`);
  return s;
}

export function summaryLine(s: PullSummary): string {
  const total = Object.values(s.counts).reduce((a, b) => a + b, 0);
  return `[sources:${s.kind}] ${s.ok ? 'ok' : 'FAILED'}${s.reauth ? ' (RE-AUTH REQUIRED)' : ''}: ${total} records; ${Object.entries(s.counts).map(([k, v]) => `${k}=${v}`).join(' ') || 'nothing new'}`;
}

/** The kinds a project has configured, in canonical order. */
export function configuredKinds(p: ProjectConfig): SourceKind[] {
  return SOURCE_KINDS.filter((k) => Boolean(p.sources?.[k]));
}

export async function pullProject(p: ProjectConfig, o: PullProjectOptions = {}, projectsConfigPath?: string): Promise<PullProjectResult> {
  if (!p.sources) throw new Error(`project "${p.slug}" has no "sources" block`);
  const sink = o.log ?? log.info.bind(log);
  const verbose = o.verbose ?? false;
  const wanted = configuredKinds(p).filter((k) => !o.only || o.only.includes(k));
  const summaries: PullSummary[] = [];
  for (const kind of wanted) {
    const ctx = pullContext(p.slug, kind, verbose, sink);
    let s: PullSummary;
    if (kind === 'google') {
      const g = p.sources.google!;
      s = await pullGoogle(ctx, {
        accounts: g.accounts,
        ...(g.kinds ? { kinds: g.kinds as GoogleKind[] } : {}),
        ...(o.since ?? g.since ? { since: o.since ?? g.since } : {}),
        full: o.full ?? false,
        calendars: [...(g.calendars ?? []), ...(o.calendars ?? [])],
      });
    } else if (kind === 'slack') {
      const sl = p.sources.slack!;
      s = await pullSlack(ctx, {
        workspaces: sl.workspaces,
        ...(o.since ?? sl.since ? { since: o.since ?? sl.since } : {}),
        ...(sl.threadWindowDays !== undefined ? { threadWindowDays: sl.threadWindowDays } : {}),
        ...(sl.editWindowHours !== undefined ? { editWindowHours: sl.editWindowHours } : {}),
      });
    } else {
      const m = p.sources.msgraph!;
      s = await pullMsgraph(ctx, {
        accounts: m.accounts.map((a) => (a.includes(':') ? a : `${m.tenant}:${a}`)),
        ...(m.only ? { only: m.only as MsgraphKind[] } : {}),
        ...(o.since ?? m.since ? { since: o.since ?? m.since } : {}),
        chatsFull: o.chatsFull ?? false,
        verbose,
      });
    }
    sink(summaryLine(s));
    for (const e of s.errors) log.warn(`[sources:${s.kind}] ${e}`);
    summaries.push(s);
  }
  // Build even after a partial failure: whatever landed in raw/ should reach the replica.
  const build = (o.build ?? true) ? runBuild(p, verbose, sink, projectsConfigPath) : undefined;
  return {
    summaries,
    ...(build ? { build } : {}),
    ok: summaries.every((s) => s.ok),
    reauth: summaries.some((s) => s.reauth),
  };
}

/**
 * The daily credential health check for one kind: the same `check` action the operator runs
 * by hand (`orch sources auth <slug> <kind> check`), driven headless. Returns the auth
 * module's exit code (0 ok, 3 = a human must act) and the lines it printed.
 */
export async function authCheck(slug: string, kind: SourceKind): Promise<{ code: number; lines: string[] }> {
  const lines: string[] = [];
  const ctx: AuthContext = { slug, tokenPath: tokenPath(slug, kind), log: (line) => lines.push(line) };
  const code = kind === 'google' ? await runGoogleAuth(ctx, ['check']) : kind === 'slack' ? await runSlackAuth(ctx, ['check']) : await runMsgraphAuth(ctx, ['check']);
  return { code, lines };
}
