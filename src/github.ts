import { createAppAuth } from '@octokit/auth-app';
import type { Config } from './config.js';
import { captureError } from './sentry.js';
import { log } from './log.js';

// ── credential-failure reporting ─────────────────────────────────────────────────
// A broken GitHub credential (expired/revoked token, misconfigured App key, a repo the App
// isn't installed on, a missing scope) silently starves every background poller: the helpers
// below all degrade quietly (return []/undefined/null/'none'), so without this the operator
// gets NO signal — the bot just "finds nothing" forever. So we surface credential-class
// failures to Sentry. Transient 5xx / network blips / rate-limit 403s are NOT reported: they
// self-heal and aren't a token problem.

// True for statuses that mean "this credential won't work" rather than "try again later":
// 401 = bad/expired token; 403 without an exhausted rate-limit = missing scope / repo not on
// the installation. (A rate-limit 403 carries x-ratelimit-remaining: 0 — that one self-heals.)
export function isAuthFailure(res: { status: number; headers: { get(name: string): string | null } }): boolean {
  if (res.status === 401) return true;
  if (res.status === 403) return res.headers.get('x-ratelimit-remaining') !== '0';
  return false;
}

// Throttle per op: the pollers call these every couple minutes, so a persistently bad token
// would otherwise raise the same failure hundreds of times a day. Sentry still groups events
// into one issue; this just keeps outbound volume (and log noise) sane. `op` is the throttle
// key and a Sentry tag naming the call site.
const REPORT_EVERY_MS = 15 * 60_000;
const lastReportAt = new Map<string, number>();

export function reportGitHubAuthFailure(op: string, err: unknown): void {
  const now = Date.now();
  if (now - (lastReportAt.get(op) ?? 0) < REPORT_EVERY_MS) return;
  lastReportAt.set(op, now);
  const e = err instanceof Error ? err : new Error(String(err));
  log.error(`github auth failure (${op}): ${e.message}`);
  captureError(e, { subsystem: 'github', op });
}

interface Installation {
  id: number;
  // The permissions the org owner has actually granted this installation, e.g.
  // { contents: 'write', checks: 'write', metadata: 'read' }. Absent → treat as none granted.
  permissions?: Record<string, string>;
}

// Resolve an installation (id + granted permissions) via the App JWT. The App is installed
// org-wide, so any repo in the org resolves to the same installation; when the id is configured
// we hit it directly. We read `permissions` here so the mint can scope to desired ∩ granted.
async function fetchInstallation(
  appId: string,
  privateKey: string,
  ref: { repo: string } | { installationId: number },
): Promise<Installation> {
  const { token: jwt } = await createAppAuth({ appId, privateKey })({ type: 'app' });
  const url =
    'installationId' in ref
      ? `https://api.github.com/app/installations/${ref.installationId}`
      : `https://api.github.com/repos/${ref.repo}/installation`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${jwt}`, Accept: 'application/vnd.github+json' },
  });
  if (!res.ok) {
    const what = 'installationId' in ref ? `installation ${ref.installationId}` : ref.repo;
    throw new Error(
      `Could not resolve GitHub App installation for ${what} (${res.status}). ` +
        `Is the App installed on that org/repo? ${await res.text()}`,
    );
  }
  return (await res.json()) as Installation;
}

// Least-privilege permissions a coding agent needs in-box: read/write code +
// open PRs. (metadata:read is implied but spelled out for clarity.) checks:read lets the
// autofix watcher read CI check-runs. This is the DESIRED set — the mint scopes it down further
// to what the installation actually granted (see intersectPermissions), so requesting more here
// than a given install has approved degrades that capability instead of breaking the whole mint.
const AGENT_PERMISSIONS = {
  contents: 'write',
  pull_requests: 'write',
  checks: 'read',
  metadata: 'read',
} as const;

// GitHub permission levels are ordered: read < write < admin.
const LEVEL_RANK: Record<string, number> = { read: 1, write: 2, admin: 3 };

// Scope the desired permissions down to what the installation actually granted:
//   - granted at a lower level than desired → request the lower (granted) level (can't exceed it)
//   - granted → request desired (our least-privilege intent, even if the install granted more)
//   - not granted at all → drop it (goes in `missing`)
// GitHub rejects the ENTIRE token mint if you request a permission the installation lacks (the
// checks:read incident), so requesting desired ∩ granted makes a mint impossible to fail on
// permissions: an un-approved capability simply isn't in the token — the feature degrades — and a
// new permission "lights up" per-installation as each owner approves, with no synchronized deploy.
export function intersectPermissions(
  desired: Record<string, string>,
  granted: Record<string, string> | undefined,
): { permissions: Record<string, string>; missing: string[] } {
  const permissions: Record<string, string> = {};
  const missing: string[] = [];
  for (const [key, want] of Object.entries(desired)) {
    const have = granted?.[key];
    if (!have) {
      missing.push(key);
      continue;
    }
    permissions[key] = (LEVEL_RANK[have] ?? 0) < (LEVEL_RANK[want] ?? 0) ? have : want;
  }
  return { permissions, missing };
}

// A granted-but-not-all-desired install is degraded, not broken — surface it once (throttled,
// keyed per install + set) so we can nudge the owner to approve, while still minting a working
// token with what we do have. Reuses the auth-failure throttle map.
function warnMissingPermissions(installationId: number, missing: string[]): void {
  const key = `perms:${installationId}:${[...missing].sort().join(',')}`;
  const now = Date.now();
  if (now - (lastReportAt.get(key) ?? 0) < REPORT_EVERY_MS) return;
  lastReportAt.set(key, now);
  log.warn(
    `github installation ${installationId} has not granted: ${missing.join(', ')} — ` +
      `those capabilities are disabled until the org owner approves the permission request`,
  );
}

// The REST headers for a token; an empty one (GITHUB_AUTH=none) asks anonymously — public repositories
// answer, within GitHub's unauthenticated rate limit.
export function apiHeaders(token: string): Record<string, string> {
  return token ? { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' } : { Accept: 'application/vnd.github+json' };
}

// Resolve a GitHub token for in-box clone / push / `gh pr create`.
//  - 'token' auth: returned as-is (a PAT or `gh auth token`).
//  - 'app' auth: mints a short-lived (≈1h) installation token SCOPED to only the
//    given repos + AGENT_PERMISSIONS. This is the key isolation: the App is installed
//    org-wide (tens/hundreds of repos), but each sandbox gets a token that can touch
//    ONLY that project's repo(s). `repositoryNames` are bare names (no owner). The
//    installation id is taken from config or discovered from the first repo. Re-resolve
//    per task so the token stays fresh; long runs that outlast an hour should re-seed.
export async function getGitHubToken(cfg: Config, repos: string[]): Promise<string> {
  try {
    return await resolveGitHubToken(cfg, repos);
  } catch (err) {
    // Failing to even mint/find a token is unambiguously a credential problem — report it here,
    // the one chokepoint every caller shares, then rethrow so behavior is unchanged (chat turns
    // surface it to the user via errText; pollers swallow-and-retry, but now it's on record).
    reportGitHubAuthFailure('getGitHubToken', err);
    throw err;
  }
}

async function resolveGitHubToken(cfg: Config, repos: string[]): Promise<string> {
  const auth = cfg.github;
  if (auth.kind === 'token') return auth.token;
  // GITHUB_AUTH=none: no credential at all — callers seed nothing and ask the API anonymously.
  if (auth.kind === 'none') return '';

  if (repos.length === 0) throw new Error('getGitHubToken: at least one repo required');

  // One JWT-authed call gives us both the installation id and the permissions its owner granted.
  const install = await fetchInstallation(
    auth.appId,
    auth.privateKey,
    auth.installationId ? { installationId: Number(auth.installationId) } : { repo: repos[0] },
  );

  // "Org/name" → "name"; GitHub scopes the token to these repos within the install.
  const repositoryNames = repos.map((r) => r.split('/')[1]).filter(Boolean);

  // Request desired ∩ granted so the mint can never fail on an un-approved permission.
  const { permissions, missing } = intersectPermissions(AGENT_PERMISSIONS, install.permissions);
  if (missing.length) warnMissingPermissions(install.id, missing);

  const { token } = await createAppAuth({
    appId: auth.appId,
    privateKey: auth.privateKey,
    installationId: install.id,
  })({
    type: 'installation',
    installationId: install.id,
    repositoryNames,
    permissions,
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
      headers: apiHeaders(token),
    });
    if (!res.ok) {
      if (isAuthFailure(res)) reportGitHubAuthFailure('listOpenPRs', new Error(`GitHub pulls → ${res.status}`));
      return [];
    }
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
        { headers: apiHeaders(token) },
      );
      if (!res.ok) {
        if (isAuthFailure(res)) reportGitHubAuthFailure('countOpenPRs', new Error(`GitHub pulls → ${res.status}`));
        return undefined;
      }
      total += ((await res.json()) as unknown[]).length;
    }
    return total;
  } catch {
    return undefined;
  }
}

// ── autofix watcher: read a PR's state, CI, and reviews (orchestrator-side) ──────

// `op` is a coarse, stable label (the caller name, not the resource path) so the auth-failure
// throttle groups by call site rather than per-PR/per-sha.
const gh = async (cfg: Config, repo: string, path: string, op: string): Promise<unknown> => {
  const token = await getGitHubToken(cfg, [repo]);
  const res = await fetch(`https://api.github.com/repos/${repo}${path}`, {
    headers: apiHeaders(token),
  });
  if (!res.ok) {
    if (isAuthFailure(res)) reportGitHubAuthFailure(op, new Error(`GitHub ${path} → ${res.status}`));
    throw new Error(`GitHub ${path} → ${res.status}`);
  }
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
    const p = (await gh(cfg, repo, `/pulls/${number}`, 'getPrMeta')) as {
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
    const r = (await gh(cfg, repo, `/commits/${sha}/check-runs`, 'ciStatusForSha')) as {
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
    const arr = (await gh(cfg, repo, `/pulls/${number}/reviews?per_page=100`, 'listReviews')) as Array<{
      id: number;
      state?: string;
      user?: { login?: string };
    }>;
    return arr.map((r) => ({ id: r.id, state: r.state ?? '', author: r.user?.login ?? '' }));
  } catch {
    return [];
  }
}
