// Where a project's repo lives (OpenSpec bitbucket-repos). A repo entry in projects.config.json is either
// `<owner>/<repo>` — GitHub, as it always was — or `bitbucket.org/<workspace>/<repo>`, a Bitbucket Cloud
// repository the agent reads and never writes. Every caller that needs the host, the clone URL or the checkout
// name asks here instead of splitting the string itself.
//
// Pure: no I/O. Tested in repohost.test.ts.

export type RepoHost = 'github' | 'bitbucket';

export interface RepoRef {
  entry: string; // as written in the config
  host: RepoHost;
  owner: string; // GitHub owner or Bitbucket workspace
  name: string; // the checkout's directory name
  url: string; // the tokenless HTTPS clone URL
}

const BITBUCKET = /^bitbucket\.org\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)$/;

/**
 * The entry's host, owner, name and clone URL. A GitHub entry is taken as it always was (no validation beyond the
 * host: a malformed `owner/name` fails at clone, as before); an entry with a host part other than `bitbucket.org`
 * throws — the config load turns that into an error naming the project (repoProblems).
 */
export function parseRepo(entry: string): RepoRef {
  const bb = BITBUCKET.exec(entry);
  if (bb) {
    return { entry, host: 'bitbucket', owner: bb[1]!, name: bb[2]!, url: `https://bitbucket.org/${bb[1]}/${bb[2]}.git` };
  }
  const parts = entry.split('/');
  if (parts.length > 2) {
    throw new Error(`repo ${JSON.stringify(entry)}: only "<owner>/<repo>" (GitHub) and "bitbucket.org/<workspace>/<repo>" are supported`);
  }
  return { entry, host: 'github', owner: parts[0]!, name: parts[1] ?? entry, url: `https://github.com/${entry}.git` };
}

export const isBitbucket = (entry: string): boolean => BITBUCKET.test(entry);

/** The entries on GitHub, in config order: what the GitHub token covers and the PR work looks at. */
export const githubRepos = (repos: readonly string[]): string[] => repos.filter((r) => !isBitbucket(r));

/** The entries on Bitbucket, in config order. */
export const bitbucketRepos = (repos: readonly string[]): string[] => repos.filter(isBitbucket);

/**
 * What is wrong with a project's repo list, as sentences for the load error: an unsupported host, and two
 * entries that would share one checkout directory (their last path segment). Empty when the list is fine.
 */
export function repoProblems(repos: readonly string[]): string[] {
  const problems: string[] = [];
  const byName = new Map<string, string>();
  for (const r of repos) {
    let ref: RepoRef;
    try {
      ref = parseRepo(r);
    } catch (e) {
      problems.push(e instanceof Error ? e.message : String(e));
      continue;
    }
    const first = byName.get(ref.name);
    if (first !== undefined) problems.push(`repos ${JSON.stringify(first)} and ${JSON.stringify(r)} would share the checkout "${ref.name}"`);
    else byName.set(ref.name, r);
  }
  return problems;
}
