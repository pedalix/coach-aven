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
// open PRs. (metadata:read is implied but spelled out for clarity.)
const AGENT_PERMISSIONS = {
  contents: 'write',
  pull_requests: 'write',
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
