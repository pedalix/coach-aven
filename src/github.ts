import { createAppAuth } from '@octokit/auth-app';
import type { Config } from './config.js';

// Discover the installation id for a repo via the App JWT (the App is installed
// org-wide, so any repo in the org resolves to the same installation).
async function discoverInstallationId(
  appId: string,
  privateKey: string,
  repo: string,
): Promise<number> {
  const { token: jwt } = await createAppAuth({ appId, privateKey })({ type: 'app' });
  const res = await fetch(`https://api.github.com/repos/${repo}/installation`, {
    headers: { Authorization: `Bearer ${jwt}`, Accept: 'application/vnd.github+json' },
  });
  if (!res.ok) {
    throw new Error(
      `Could not find a GitHub App installation for ${repo} (${res.status}). ` +
        `Is the App installed on that org/repo? ${await res.text()}`,
    );
  }
  return ((await res.json()) as { id: number }).id;
}

// Least-privilege permissions a coding agent needs in-box: read/write code +
// open PRs. (metadata:read is implied but spelled out for clarity.) checks:read lets the
// autofix watcher read CI check-runs.
const AGENT_PERMISSIONS = {
  contents: 'write',
  pull_requests: 'write',
  checks: 'read',
  metadata: 'read',
} as const;

// Resolve a GitHub token for in-box clone / push / `gh pr create`.
//  - 'token' auth: returned as-is (a PAT or `gh auth token`).
//  - 'app' auth: mints a short-lived (≈1h) installation token SCOPED to only the
//    given repos + AGENT_PERMISSIONS. This is the key isolation: the App is installed
//    org-wide (tens/hundreds of repos), but each sandbox gets a token that can touch
//    ONLY that project's repo(s). `repositoryNames` are bare names (no owner). The
//    installation id is taken from config or discovered from the first repo. Re-resolve
//    per task so the token stays fresh; long runs that outlast an hour should re-seed.
export async function getGitHubToken(cfg: Config, repos: string[]): Promise<string> {
  const auth = cfg.github;
  if (auth.kind === 'token') return auth.token;

  if (repos.length === 0) throw new Error('getGitHubToken: at least one repo required');
  const installationId = auth.installationId
    ? Number(auth.installationId)
    : await discoverInstallationId(auth.appId, auth.privateKey, repos[0]);

  // "Org/name" → "name"; GitHub scopes the token to these repos within the install.
  const repositoryNames = repos.map((r) => r.split('/')[1]).filter(Boolean);

  const { token } = await createAppAuth({
    appId: auth.appId,
    privateKey: auth.privateKey,
    installationId,
  })({
    type: 'installation',
    installationId,
    repositoryNames,
    permissions: AGENT_PERMISSIONS,
  });
  return token;
}

export interface OpenPullRequest {
  number: number;
  author: string; // user.login ("" if unknown)
  createdAt: string; // ISO 8601
  headSha: string;
  title: string;
  draft: boolean;
}

// List OPEN PRs for one repo ("Org/name"), orchestrator-side (like countOpenPRs). Used by
// the auto-review poller. Returns [] on any failure so the poller degrades quietly.
export async function listOpenPRs(cfg: Config, repo: string): Promise<OpenPullRequest[]> {
  try {
    const token = await getGitHubToken(cfg, [repo]);
    const res = await fetch(`https://api.github.com/repos/${repo}/pulls?state=open&per_page=100`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
    });
    if (!res.ok) return [];
    const arr = (await res.json()) as Array<{
      number: number;
      user?: { login?: string };
      created_at: string;
      head?: { sha?: string };
      title?: string;
      draft?: boolean;
    }>;
    return arr.map((p) => ({
      number: p.number,
      author: p.user?.login ?? '',
      createdAt: p.created_at,
      headSha: p.head?.sha ?? '',
      title: p.title ?? '',
      draft: Boolean(p.draft),
    }));
  } catch {
    return [];
  }
}

// Best-effort count of OPEN pull requests across a project's repos, for `/aven status`.
// Uses a token scoped to exactly those repos. Returns `undefined` if it can't be
// determined (auth/network/rate-limit) so the caller can show "?" instead of failing.
export async function countOpenPRs(cfg: Config, repos: string[]): Promise<number | undefined> {
  try {
    const token = await getGitHubToken(cfg, repos);
    let total = 0;
    for (const repo of repos) {
      const res = await fetch(
        `https://api.github.com/repos/${repo}/pulls?state=open&per_page=100`,
        { headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' } },
      );
      if (!res.ok) return undefined;
      total += ((await res.json()) as unknown[]).length;
    }
    return total;
  } catch {
    return undefined;
  }
}

// ── autofix watcher: read a PR's state, CI, and reviews (orchestrator-side) ──────

const gh = async (cfg: Config, repo: string, path: string): Promise<unknown> => {
  const token = await getGitHubToken(cfg, [repo]);
  const res = await fetch(`https://api.github.com/repos/${repo}${path}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
  });
  if (!res.ok) throw new Error(`GitHub ${path} → ${res.status}`);
  return res.json();
};

export interface PrMeta {
  headSha: string;
  state: 'open' | 'closed';
  merged: boolean;
}

// Head sha + open/closed/merged for one PR. null on failure.
export async function getPrMeta(cfg: Config, repo: string, number: number): Promise<PrMeta | null> {
  try {
    const p = (await gh(cfg, repo, `/pulls/${number}`)) as {
      head?: { sha?: string };
      state?: string;
      merged?: boolean;
    };
    return { headSha: p.head?.sha ?? '', state: p.state === 'closed' ? 'closed' : 'open', merged: Boolean(p.merged) };
  } catch {
    return null;
  }
}

export type CiConclusion = 'success' | 'failure' | 'pending' | 'none';

// Aggregate CI for a commit from its check-runs: any failed/cancelled → failure; any not
// completed → pending; none → none; else success. 'none' on failure (degrade quietly).
export async function ciStatusForSha(cfg: Config, repo: string, sha: string): Promise<CiConclusion> {
  try {
    const r = (await gh(cfg, repo, `/commits/${sha}/check-runs`)) as {
      check_runs?: Array<{ status?: string; conclusion?: string | null }>;
    };
    const runs = r.check_runs ?? [];
    if (runs.length === 0) return 'none';
    if (runs.some((c) => ['failure', 'timed_out', 'cancelled', 'action_required'].includes(c.conclusion ?? ''))) {
      return 'failure';
    }
    if (runs.some((c) => c.status !== 'completed')) return 'pending';
    return 'success';
  } catch {
    return 'none';
  }
}

export interface ReviewSummary {
  id: number;
  state: string; // APPROVED | CHANGES_REQUESTED | COMMENTED | DISMISSED
  author: string;
}

// Reviews submitted on a PR (id ascending). [] on failure.
export async function listReviews(cfg: Config, repo: string, number: number): Promise<ReviewSummary[]> {
  try {
    const arr = (await gh(cfg, repo, `/pulls/${number}/reviews?per_page=100`)) as Array<{
      id: number;
      state?: string;
      user?: { login?: string };
    }>;
    return arr.map((r) => ({ id: r.id, state: r.state ?? '', author: r.user?.login ?? '' }));
  } catch {
    return [];
  }
}
