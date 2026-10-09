// Git commits → activity blocks. Commits ≤90 min apart form one block, each block gets a
// 20-min lead-in for the work before its first commit, a lone commit still counts 20 min.
// Why these numbers: commits are frequent enough (130 in two weeks on one repo) that the gaps
// between them are a fair proxy for sitting at the keyboard; the lead-in and minimum stop a
// one-commit day from vanishing. Blocks are bucketed per local day so none straddles two days.
import { execFileSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { clusterByDay } from './cluster.js';
import { blockId, containerOfRemote, shortContainer, type ActivityRecord } from './normalise.js';

export const GIT_GAP_MIN = 90;
export const GIT_LEAD_IN_MIN = 20;
export const GIT_MIN_MIN = 20;

export interface Commit {
  sha: string;
  iso: string;
  subject: string;
}
export interface RepoRef {
  path: string;
  remote: string;
  container: string;
}

/** Git repos under `root` up to `maxDepth` (worktrees' `.git` files count too). */
export function discoverRepos(root: string, maxDepth = 4): RepoRef[] {
  const out: RepoRef[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > maxDepth) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    if (entries.includes('.git')) {
      let remote = '';
      try {
        remote = execFileSync('git', ['-C', dir, 'remote', 'get-url', 'origin'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      } catch {
        /* no origin */
      }
      out.push({ path: dir, remote, container: containerOfRemote(remote) ?? dir });
      return; // nested repos are rare and usually vendored
    }
    for (const e of entries) {
      if (e === 'node_modules' || e === 'vendor' || e.startsWith('.')) continue;
      const p = join(dir, e);
      try {
        if (statSync(p).isDirectory()) walk(p, depth + 1);
      } catch {
        /* skip */
      }
    }
  };
  walk(root, 0);
  return out;
}

/** Author filter as git --author patterns (OR-ed by git); regex metachars escaped. */
export function authorArgs(authors: string[]): string[] {
  return authors.map((a) => `--author=${a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`);
}

export function readCommits(repoPath: string, sinceIso: string, authors: string[]): Commit[] {
  const args = ['-C', repoPath, 'log', '--all', '--no-merges', `--since=${sinceIso}`, ...authorArgs(authors), '--format=%H%x09%aI%x09%s'];
  let txt = '';
  try {
    txt = execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 });
  } catch {
    return [];
  }
  return txt
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const [sha, iso, ...rest] = l.split('\t');
      return { sha: sha!, iso: iso!, subject: rest.join('\t') };
    })
    .filter((c) => c.sha && !Number.isNaN(Date.parse(c.iso)));
}

/** Pure: one container's commits → activity blocks keyed by local day. */
export function commitBlocks(container: string, commits: Commit[], tz: string, host: string): Map<string, ActivityRecord[]> {
  const bySha = new Map<string, Commit>();
  for (const c of commits) bySha.set(c.sha, c);
  const points = [...bySha.values()].map((c) => ({ t: Date.parse(c.iso), ref: c.sha }));
  const out = new Map<string, ActivityRecord[]>();
  const short = shortContainer(container);
  for (const [day, blocks] of clusterByDay(points, tz, GIT_GAP_MIN, GIT_LEAD_IN_MIN, GIT_MIN_MIN)) {
    out.set(
      day,
      blocks.map((b) => {
        const cs = b.refs.map((sha) => bySha.get(sha)!).sort((a, z) => Date.parse(a.iso) - Date.parse(z.iso));
        const start = new Date(b.start).toISOString();
        return {
          source: 'git',
          account: host,
          id: blockId('git', container, start),
          container,
          start,
          end: new Date(b.end).toISOString(),
          minutes: b.minutes,
          title: `${short}: ${cs.length} commit${cs.length > 1 ? 's' : ''} — ${cs[0]!.subject.slice(0, 80)}`,
          items: cs.map((c) => ({ ts: new Date(c.iso).toISOString(), text: `${c.sha.slice(0, 7)} ${c.subject}`.slice(0, 300) })),
        } satisfies ActivityRecord;
      }),
    );
  }
  return out;
}
