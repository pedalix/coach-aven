// Pure PR helpers for the /aven review|autofix commands and (later) the PR-watcher.
// No Slack/Daytona deps, so it's unit-testable in isolation (see pr.test.ts).

export interface PrTarget {
  slug: string; // owning project
  repo: string; // canonical "Org/name"
  number: number;
}

// Minimal project shape the resolver needs.
interface ProjectRepos {
  slug: string;
  repos: string[];
}

const repoShort = (full: string): string => full.split('/')[1] ?? full;

// Resolve a PR reference to its owning project + canonical repo + number. A repo belongs to
// exactly one project, so a URL or "<repo> #n" identifies the project on its own — which is
// why `/aven review` works in DMs and any channel, not just a project-bound channel. Forms:
//   • full PR URL  → repo + number, owner looked up across all projects
//   • "<repo> #123"→ repo matched (short or full) across all projects
//   • "#123"/"123" → needs a project context: `channelSlug` (the channel's project)
export function resolvePr(
  input: string,
  projects: ProjectRepos[],
  channelSlug?: string,
): PrTarget | { error: string } {
  const s = input.trim();

  const url = s.match(/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/i);
  if (url) {
    const repo = url[1];
    const owner = projects.find((p) => p.repos.some((r) => r.toLowerCase() === repo.toLowerCase()));
    if (!owner) return { error: `No project owns ${repo} — check the URL or add the repo to a project.` };
    const canonical = owner.repos.find((r) => r.toLowerCase() === repo.toLowerCase())!;
    return { slug: owner.slug, repo: canonical, number: Number(url[2]) };
  }

  const m = s.match(/^(?:([\w./-]+)\s+)?#?(\d+)$/);
  if (!m) return { error: 'Give a PR URL or a number, e.g. `#123` or `<repo> #123`.' };
  const number = Number(m[2]);
  const repoArg = m[1];

  if (repoArg) {
    for (const p of projects) {
      const match = p.repos.find((r) => r === repoArg || repoShort(r) === repoArg);
      if (match) return { slug: p.slug, repo: match, number };
    }
    return { error: `No repo "${repoArg}" in any project.` };
  }

  // Bare number → needs a project context (the channel's).
  const p = channelSlug ? projects.find((x) => x.slug === channelSlug) : undefined;
  if (p && p.repos.length === 1) return { slug: p.slug, repo: p.repos[0], number };
  if (p) {
    return {
      error: `${p.slug} has ${p.repos.length} repos — give a PR URL or \`<repo> #${number}\` (one of: ${p.repos.map(repoShort).join(', ')}).`,
    };
  }
  return { error: `Tell me which repo — give a PR URL or \`<repo> #${number}\` (works in DMs too).` };
}

// One open PR, as the auto-review poller sees it (carries its repo for keying).
export interface OpenPr {
  repo: string;
  number: number;
  author: string;
  createdAt: string; // ISO
  draft: boolean;
}

// Pure decision for the auto-review poller: which open PRs to review now. Skips drafts, the
// bot's own PRs, PRs opened before auto-review was enabled (`since`, to avoid the backlog),
// and ones already reviewed (`reviewed`, keyed "<repo>#<number>").
export function prsToReview(
  prs: OpenPr[],
  opts: { since?: string; botLogin: string; reviewed: Set<string> },
): OpenPr[] {
  const bot = opts.botLogin.toLowerCase();
  return prs.filter(
    (p) =>
      !p.draft &&
      p.author.toLowerCase() !== bot &&
      (!opts.since || p.createdAt > opts.since) &&
      !opts.reviewed.has(`${p.repo}#${p.number}`),
  );
}

// ── autofix watcher decision ──────────────────────────────────────────────

export interface WatchCursor {
  lastCiSha?: string;
  lastCiConclusion?: string;
  lastReviewId?: number;
}
export interface CiState {
  sha: string;
  conclusion: 'success' | 'failure' | 'pending' | 'none';
}
export interface ReviewState {
  id: number;
  state: string; // APPROVED | CHANGES_REQUESTED | COMMENTED | DISMISSED
  author: string;
}

// Pure decision for the autofix watcher: given current CI + reviews vs the last-seen cursor,
// what's worth notifying about, and what's the new cursor to persist. Notifies once per
// (head sha) CI failure, and on new non-bot reviews that aren't plain approvals. Baselining
// at subscribe (seeding the cursor) means only post-subscription changes fire.
export function autofixEvents(
  prev: WatchCursor,
  ci: CiState,
  reviews: ReviewState[],
  botLogin: string,
): { notes: string[]; next: WatchCursor } {
  const notes: string[] = [];
  const bot = botLogin.toLowerCase();
  const next: WatchCursor = { ...prev, lastCiSha: ci.sha, lastCiConclusion: ci.conclusion };

  if (ci.conclusion === 'failure' && !(prev.lastCiSha === ci.sha && prev.lastCiConclusion === 'failure')) {
    notes.push('CI failed');
  }

  let maxId = prev.lastReviewId ?? 0;
  for (const r of reviews) {
    maxId = Math.max(maxId, r.id);
    if ((prev.lastReviewId ?? 0) >= r.id || r.author.toLowerCase() === bot) continue;
    if (r.state === 'CHANGES_REQUESTED') notes.push(`${r.author} requested changes`);
    else if (r.state === 'COMMENTED') notes.push(`${r.author} left review comments`);
  }
  next.lastReviewId = maxId;

  return { notes, next };
}
