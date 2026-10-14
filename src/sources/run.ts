// One project, one pass: pull every configured source into data/<slug>/raw, then rebuild the
// store and publish the replica. Shared by the operator CLI (`orch sources pull`) and the
// poller (pollers.ts → sync.ts): the two must do exactly the same thing, so the logic lives
// once, here, and both callers only differ in how they log and what they do with the result.
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { getGitHubToken } from '../github.js';
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
import { runAsanaAuth } from './asana/auth.js';
import { pullAsana } from './asana/pull.js';
import { runJiraAuth } from './jira/auth.js';
import { pullJira } from './jira/pull.js';
import { runYoutrackAuth } from './youtrack/auth.js';
import { pullYoutrack } from './youtrack/pull.js';
import { UsageError } from './errors.js';
import { runMeetingsAuth } from './meetings/auth.js';
import { pullMeetings } from './meetings/pull.js';
import { pullLocal } from './local/pull.js';
import { annotationsDir, syncTenant, type TenantSync } from './tenant.js';
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

/**
 * People file, in order: the tenant's annotations/people.json (when sources.tenant is set and the
 * checkout has one), else `sources.people` relative to projects.config.json, else
 * projects.d/<slug>.people.json beside it — the pre-tenant layout, kept as the fallback.
 */
export function peoplePath(p: ProjectConfig, projectsConfigPath = loadConfig().projectsConfigPath): string {
  if (p.sources?.tenant) {
    const t = join(annotationsDir(p.slug, p.sources.tenant), 'people.json');
    if (existsSync(t)) return t;
  }
  const base = dirname(projectsConfigPath);
  return resolve(base, p.sources?.people ?? `projects.d/${p.slug}.people.json`);
}

/** The tenant's fragments.jsonl, when the project has a tenant repo. */
export function fragmentsPath(p: ProjectConfig): string | undefined {
  return p.sources?.tenant ? join(annotationsDir(p.slug, p.sources.tenant), 'fragments.jsonl') : undefined;
}

/** Fetch the tenant checkout (if configured) so the build reads the latest decisions. Never throws. */
export async function refreshTenant(p: ProjectConfig, sink: (line: string) => void = log.info.bind(log)): Promise<TenantSync | undefined> {
  const t = p.sources?.tenant;
  if (!t) return undefined;
  const r = await syncTenant(p.slug, t, async () => getGitHubToken(loadConfig(), [t.repo]));
  sink(`[sources:${p.slug}/tenant] ${t.repo}${r.head ? `@${r.head.slice(0, 7)}` : ''}${r.changed ? ' (updated)' : ''}${r.error ? ` — FAILED: ${r.error}` : ''}`);
  return r;
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

/**
 * `pulled` = the kinds that completed ok in the pass this build closes (their finishedAt lands in
 * sync_state as `pulled:<kind>`, the per-source data age `stats.meta` shows); the CLI `build` passes none.
 */
export function runBuild(p: ProjectConfig, verbose: boolean, sink: (line: string) => void = log.info.bind(log), projectsConfigPath?: string, pulled?: ReadonlyArray<{ kind: SourceKind; finishedAt: string }>): BuildSummary {
  const prefix = `[sources:${p.slug}/store]`;
  const s = buildStore({
    slug: p.slug,
    rawDir: rawDir(p.slug),
    storePath: storePath(p.slug),
    replicaDir: replicaDir(p.slug),
    peoplePath: peoplePath(p, projectsConfigPath),
    ...(fragmentsPath(p) ? { fragmentsPath: fragmentsPath(p)! } : {}),
    ...(pulled ? { pulled } : {}),
    log: (line) => (verbose || !line.startsWith('  ') ? sink(`${prefix} ${line}`) : undefined),
  });
  sink(
    `${prefix} ${s.lines} new lines from ${s.files} files → messages ${s.messages}, events ${s.events}, files ${s.fileRecords}, tasks ${s.tasks}, meetings ${s.meetings} → ${s.calls} calls, activity ${s.activity}, tombstones ${s.tombstones}` +
      `${s.replayed ? `, replayed ${s.replayed}` : ''}${s.malformed ? `, malformed ${s.malformed}` : ''}${s.legacyEvents ? `, ${s.legacyEvents} untagged Outlook event lines skipped` : ''}; people ${s.people}; fragments ${s.fragments}, attributions ${s.attributions}` +
      `${s.recomputed ? ' (recomputed)' : ''}${s.malformedFragments ? `, ${s.malformedFragments} bad fragment lines` : ''}; replica ${s.replica ?? '(none)'}`,
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
        ...(sl.channels ? { channels: sl.channels } : {}),
        ...(sl.kinds ? { kinds: sl.kinds } : {}),
      });
    } else if (kind === 'local') {
      s = await pullLocal(ctx, p.sources.local!, { full: o.full ?? false, ...(o.since ? { since: o.since } : {}) });
    } else if (kind === 'meetings') {
      s = await pullMeetings(ctx, p.sources.meetings!, { full: o.full ?? false, ...(o.since ? { since: o.since } : {}) });
    } else if (kind === 'youtrack' || kind === 'jira' || kind === 'asana') {
      const o2 = { full: o.full ?? false, ...(o.since ? { since: o.since } : {}) };
      s = kind === 'youtrack' ? await pullYoutrack(ctx, p.sources.youtrack!, o2) : kind === 'jira' ? await pullJira(ctx, p.sources.jira!, o2) : await pullAsana(ctx, p.sources.asana!, o2);
    } else {
      const m = p.sources.msgraph!;
      s = await pullMsgraph(ctx, {
        accounts: m.accounts.map((a) => (a.includes(':') ? a : `${m.tenant}:${a}`)),
        ...(m.only ? { only: m.only as MsgraphKind[] } : {}),
        ...(o.since ?? m.since ? { since: o.since ?? m.since } : {}),
        ...(m.calendars ? { calendars: m.calendars } : {}),
        chatsFull: o.chatsFull ?? false,
        verbose,
      });
    }
    sink(summaryLine(s));
    for (const e of s.errors) log.warn(`[sources:${s.kind}] ${e}`);
    summaries.push(s);
  }
  // Build even after a partial failure: whatever landed in raw/ should reach the replica.
  if (o.build ?? true) await refreshTenant(p, sink);
  const pulled = summaries.filter((s) => s.ok).map((s) => ({ kind: s.kind, finishedAt: s.finishedAt }));
  const build = (o.build ?? true) ? runBuild(p, verbose, sink, projectsConfigPath, pulled) : undefined;
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
export async function authCheck(slug: string, kind: SourceKind, p?: ProjectConfig): Promise<{ code: number; lines: string[] }> {
  const lines: string[] = [];
  const ctx: AuthContext = { slug, tokenPath: tokenPath(slug, kind), log: (line) => lines.push(line) };
  const code = await runAuth(ctx, kind, ['check'], p);
  return { code, lines };
}

/** Dispatch `auth <kind> <args>`; trackers read their URL/site/workspace from the project's sources block. */
export async function runAuth(ctx: AuthContext, kind: SourceKind, args: string[], p?: ProjectConfig): Promise<number> {
  switch (kind) {
    case 'google':
      return runGoogleAuth(ctx, args);
    case 'slack':
      return runSlackAuth(ctx, args);
    case 'msgraph':
      return runMsgraphAuth(ctx, args);
    case 'meetings':
      return runMeetingsAuth(ctx, args, p?.sources?.meetings);
    case 'local':
      // Nothing to authorise: the source reads the bot's own filesystem.
      ctx.log('local: no credentials needed (reads git repos and Claude transcripts on this machine)');
      return 0;
    case 'youtrack':
    case 'jira':
    case 'asana': {
      const cfg = p?.sources?.[kind];
      if (!cfg) throw new UsageError(`project "${ctx.slug}" has no sources.${kind} block — configure it first (url/site/workspace live there)`);
      if (kind === 'youtrack') return runYoutrackAuth(ctx, args, p!.sources!.youtrack!);
      if (kind === 'jira') return runJiraAuth(ctx, args, p!.sources!.jira!);
      return runAsanaAuth(ctx, args, p!.sources!.asana!);
    }
  }
}
