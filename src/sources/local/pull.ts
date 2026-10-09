// The `local` source: hands-on work on the bot's own machine (git commits under the configured
// roots, Claude Code transcripts) → `raw/local/activity.jsonl`. No credentials: it reads the
// filesystem the bot runs on, which is exactly the part of the world the sandbox cannot see.
//
// Incremental by DAY, not by item: a new commit can extend or merge yesterday's blocks, so a
// day is recomputed from all of its points whenever anything in it changed, and the cursor
// remembers which block ids each (source, container, day) produced. A block that no longer
// exists after the recompute is tombstoned, so a merge never leaves a stale duplicate behind.
//
// Cursor (raw/local/cursor.json):
//   git:    { <container>: { last: <ISO of newest seen commit> } }
//   claude: { <file>: { mtime, container, minutes[], prompt? } }   minute-resolution cache
//   blocks: { "<source>|<container>|<day>": [block ids] }
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import type { LocalSourcesConfig, PullContext, PullSummary } from '../types.js';
import { scanSession, sessionBlocks, decodeProjectDir, type CachedSession } from './claude.js';
import { localDate, MIN } from './cluster.js';
import { commitBlocks, discoverRepos, readCommits, type Commit, type RepoRef } from './git.js';
import { scrubActivity, type ActivityRecord, type ActivitySource, type ActivityTombstone } from './normalise.js';

export interface LocalCursor {
  git: Record<string, { last: string }>;
  claude: Record<string, { mtime: number; container: string; minutes: number[]; prompt?: string }>;
  blocks: Record<string, string[]>;
}

export function localDir(outDir: string): string {
  return join(outDir, 'local');
}

export function readLocalCursor(dir: string): LocalCursor {
  try {
    const c = JSON.parse(readFileSync(join(dir, 'cursor.json'), 'utf8')) as Partial<LocalCursor>;
    return { git: c.git ?? {}, claude: c.claude ?? {}, blocks: c.blocks ?? {} };
  } catch {
    return { git: {}, claude: {}, blocks: {} };
  }
}

function writeLocalCursor(dir: string, c: LocalCursor): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const p = join(dir, 'cursor.json');
  writeFileSync(`${p}.tmp`, `${JSON.stringify(c)}\n`, { mode: 0o600 });
  renameSync(`${p}.tmp`, p);
}

/** Pure: replace one (source, container, day)'s blocks, returning what to write and the new id list. */
export function diffDay(prevIds: string[] | undefined, next: ActivityRecord[], source: ActivitySource, container: string): { write: (ActivityRecord | ActivityTombstone)[]; ids: string[] } {
  const ids = next.map((r) => r.id);
  const gone = (prevIds ?? []).filter((id) => !ids.includes(id));
  return { write: [...next, ...gone.map((id) => ({ source, account: next[0]?.account ?? hostname(), id, container, deleted: true as const }))], ids };
}

/** The repo a working directory belongs to (longest path prefix), else the cwd itself. */
export function containerForCwd(cwd: string, repos: RepoRef[]): string {
  let best: RepoRef | undefined;
  for (const r of repos) if ((cwd === r.path || cwd.startsWith(r.path + '/')) && (!best || r.path.length > best.path.length)) best = r;
  return best?.container ?? cwd;
}

export interface PullLocalOptions {
  since?: string;
  full?: boolean;
  tz?: string;
  host?: string;
  now?: () => Date;
}

export async function pullLocal(ctx: PullContext, cfg: LocalSourcesConfig, o: PullLocalOptions = {}): Promise<PullSummary> {
  const startedAt = new Date().toISOString();
  const tz = o.tz ?? process.env.AVEN_TZ ?? process.env.TZ ?? 'UTC';
  const host = o.host ?? hostname();
  const now = (o.now ?? (() => new Date()))();
  const since = o.since ?? cfg.since ?? localDate(now.getTime() - 30 * 24 * 3600_000, tz);
  const sinceMs = Date.parse(`${since}T00:00:00Z`) - 24 * 3600_000; // a day of slack for timezones
  const dir = localDir(ctx.outDir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, 'activity.jsonl');
  const cur: LocalCursor = o.full ? { git: {}, claude: {}, blocks: {} } : readLocalCursor(dir);
  const counts: Record<string, number> = { git: 0, claude: 0, tombstones: 0 };
  const errors: string[] = [];
  const emit = (recs: (ActivityRecord | ActivityTombstone)[]) => {
    for (const r of recs) {
      const out = 'deleted' in r ? r : scrubActivity(r);
      appendFileSync(file, `${JSON.stringify(out)}\n`, { mode: 0o600 });
      if ('deleted' in r) counts.tombstones!++;
      else counts[r.source]!++;
    }
  };
  const inWindow = (day: string) => day >= since;

  // ── git ──────────────────────────────────────────────────────────────────────────────
  const repos: RepoRef[] = [];
  for (const root of cfg.roots) {
    try {
      repos.push(...discoverRepos(root));
    } catch (e) {
      errors.push(`git: ${root}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  const byContainer = new Map<string, RepoRef[]>();
  for (const r of repos) byContainer.set(r.container, [...(byContainer.get(r.container) ?? []), r]);
  for (const [container, paths] of byContainer) {
    const last = cur.git[container]?.last;
    // Re-read from the start of the newest day we already saw, so that day recomputes in full.
    const fromDay = last ? localDate(last, tz) : since;
    const fromIso = new Date(Date.parse(`${fromDay}T00:00:00Z`) - 24 * 3600_000).toISOString();
    const commits: Commit[] = [];
    for (const p of paths) commits.push(...readCommits(p.path, fromIso, cfg.authors));
    if (!commits.length) continue;
    const newest = commits.reduce((m, c) => (Date.parse(c.iso) > Date.parse(m) ? c.iso : m), last ?? commits[0]!.iso);
    const touched = new Set(commits.filter((c) => !last || Date.parse(c.iso) > Date.parse(last)).map((c) => localDate(c.iso, tz)));
    if (!touched.size) continue;
    const days = commitBlocks(container, commits, tz, host);
    for (const day of touched) {
      if (!inWindow(day)) continue;
      const key = `git|${container}|${day}`;
      const d = diffDay(cur.blocks[key], days.get(day) ?? [], 'git', container);
      emit(d.write);
      cur.blocks[key] = d.ids;
    }
    cur.git[container] = { last: newest };
  }

  // ── claude ───────────────────────────────────────────────────────────────────────────
  if (cfg.claudeProjectsDir && existsSync(cfg.claudeProjectsDir)) {
    const changed = new Map<string, Set<string>>(); // container → days to recompute
    const mark = (container: string, minutes: number[]) => {
      const s = changed.get(container) ?? new Set<string>();
      for (const m of minutes) s.add(localDate(m * MIN, tz));
      changed.set(container, s);
    };
    for (const sub of readdirSync(cfg.claudeProjectsDir)) {
      const full = join(cfg.claudeProjectsDir, sub);
      let files: string[];
      try {
        files = readdirSync(full).filter((f) => f.endsWith('.jsonl'));
      } catch {
        continue;
      }
      for (const f of files) {
        const path = join(full, f);
        let mtime: number;
        try {
          mtime = statSync(path).mtimeMs;
        } catch {
          continue;
        }
        if (mtime < sinceMs) continue;
        const prev = cur.claude[path];
        if (prev && prev.mtime === mtime) continue;
        try {
          const scan = await scanSession(path);
          const cwd = scan.cwd ?? decodeProjectDir(sub, (p) => existsSync(p)) ?? `?${sub}`;
          const container = containerForCwd(cwd, repos);
          const minutes = scan.minutes.filter((m) => m * MIN >= sinceMs);
          if (prev) mark(prev.container, prev.minutes);
          mark(container, minutes);
          cur.claude[path] = { mtime, container, minutes, ...(scan.prompt ? { prompt: scan.prompt } : {}) };
        } catch (e) {
          errors.push(`claude: ${f}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    }
    // drop cache entries that fell out of the window
    for (const [p, v] of Object.entries(cur.claude)) if (!v.minutes.some((m) => m * MIN >= sinceMs)) delete cur.claude[p];
    for (const [container, days] of changed) {
      const sessions: CachedSession[] = Object.entries(cur.claude)
        .filter(([, v]) => v.container === container)
        .map(([file, v]) => ({ file, minutes: v.minutes, ...(v.prompt ? { prompt: v.prompt } : {}) }));
      const blocks = sessionBlocks(container, sessions, tz, host);
      for (const day of days) {
        if (!inWindow(day)) continue;
        const key = `claude|${container}|${day}`;
        const d = diffDay(cur.blocks[key], blocks.get(day) ?? [], 'claude', container);
        emit(d.write);
        cur.blocks[key] = d.ids;
      }
    }
  } else if (cfg.claudeProjectsDir) {
    ctx.log(`claude: ${cfg.claudeProjectsDir} does not exist — skipped`);
  }

  writeLocalCursor(dir, cur);
  ctx.log(`${host}: ${counts.git} git blocks, ${counts.claude} claude blocks, ${counts.tombstones} tombstones (${repos.length} repos)`);
  return { kind: 'local', ok: errors.length === 0, reauth: false, counts, errors, startedAt, finishedAt: new Date().toISOString() };
}
