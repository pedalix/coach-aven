import type { SandboxHandle } from './driver.js';
import { DEPENDS_ON_REPOS, projectSubject, type Fact, type FactStore } from './facts.js';
import { log } from './log.js';

// Dependency scanner — the first "competency" that writes a project fact without an LLM.
//
// Problem it solves: a project's private composer packages live in sibling repos of the
// same GitHub org (caldora-admin → BluefinOrg/laravel-apaleo, mews, gatora-php-sdk,
// …). The App installation covers the whole org, but the per-turn token is scoped to
// exactly the project's repos, so `composer install` got 403s on the packages and we
// used to paper over it with a hand-made PAT in the config (which then expired). The
// mechanical answer: read the manifests in the checkout, record which GitHub repos they
// reference as a fact, and let the token mint + composer auth seeder read that fact.
// No config field, no PAT, no human in the loop.
//
// The grep runs inside the sandbox and the pure part (URL → "Owner/name") is here with
// tests. Only composer.json is read, NOT composer.lock: the lock names the GitHub source
// of every public package too (hundreds of repos, all packagist), whereas the root
// composer.json `repositories` block is, by composer's own rule, the complete list of
// VCS sources — repositories are never inherited from dependencies, so a private
// package's private deps must be declared there as well. package.json private git deps
// would slot into the same grep when a project needs it.

const MANIFESTS = ['composer.json'];

// Every way a GitHub repo shows up in a composer manifest, in one grep-friendly pattern:
//   https://github.com/Org/name.git         (repositories[].url)
//   git@github.com:Org/name.git             (SSH form — composer rewrites it to https+token)
//   https://api.github.com/repos/Org/name/… (a dist url, should one be declared)
const GREP_PATTERN = '(github\\.com[/:]|api\\.github\\.com/repos/)[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+';

// "Owner/name" out of any of the fragments the grep yields; undefined for non-repo
// matches (e.g. "github.com/settings/tokens" in a README-ish string).
export function repoFromFragment(fragment: string): string | undefined {
  const m = /^(?:api\.github\.com\/repos\/|github\.com[/:])([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(
    fragment.trim(),
  );
  if (!m) return undefined;
  const owner = m[1];
  const name = m[2].replace(/\.git$/, '');
  if (!owner || !name || owner === 'orgs' || owner === 'settings') return undefined;
  return `${owner}/${name}`;
}

// Normalize a batch of grep fragments to a sorted, de-duplicated "Owner/name" list.
export function reposFromFragments(fragments: string[]): string[] {
  const out = new Set<string>();
  for (const f of fragments) {
    const r = repoFromFragment(f);
    if (r) out.add(r);
  }
  return [...out].sort();
}

// The per-checkout shell: prints "@<repoName> <short sha>" then one fragment per line,
// or nothing when the checkout has no composer.json (a Nuxt repo, an infra repo).
export function scanScript(checkouts: { repo: string; dir: string }[]): string {
  return checkouts
    .map(({ repo, dir }) => {
      const name = repo.split('/')[1] ?? repo;
      return (
        `if [ -f ${dir}/composer.json ]; then ` +
        `echo "@${name} $(git -C ${dir} rev-parse --short HEAD 2>/dev/null || echo unknown)"; ` +
        `grep -ohE '${GREP_PATTERN}' ${MANIFESTS.map((m) => `${dir}/${m}`).join(' ')} 2>/dev/null | sort -u; ` +
        `fi`
      );
    })
    .join('; ');
}

// Parse the scan output into the fact's value + provenance. Exported for tests.
export function parseScan(output: string): { repos: string[]; sources: string[] } {
  const fragments: string[] = [];
  const sources: string[] = [];
  for (const line of output.split('\n')) {
    const l = line.trim();
    if (!l) continue;
    if (l.startsWith('@')) {
      const [name, sha] = l.slice(1).split(/\s+/);
      sources.push(`${name}@${sha ?? 'unknown'}:${MANIFESTS.join(',')}`);
    } else {
      fragments.push(l);
    }
  }
  return { repos: reposFromFragments(fragments), sources };
}

// Scan every checkout of a project and record the `depends_on_repos` fact. Returns the
// repos found. Best-effort: a scan failure logs and leaves the previous fact in place —
// the worst case is the pre-scanner behaviour (a token that can't see the packages).
export async function scanDependencyRepos(
  sandbox: SandboxHandle,
  facts: FactStore,
  slug: string,
  checkouts: { repo: string; dir: string }[],
): Promise<string[]> {
  try {
    const res = await sandbox.exec(scanScript(checkouts));
    const { repos, sources } = parseScan(res.result);
    const fact: Fact = {
      subject: projectSubject(slug),
      predicate: DEPENDS_ON_REPOS,
      value: repos,
      sources,
      observedAt: new Date().toISOString(),
    };
    facts.put(slug, fact);
    if (repos.length) log.step(`deps: ${slug} manifests reference ${repos.length} GitHub repo(s)`);
    return repos;
  } catch (e) {
    log.error(`deps scan ${slug}: ${e instanceof Error ? e.message : String(e)}`);
    return facts.dependsOnRepos(slug);
  }
}

// The repos a project's GitHub token should cover: its own repos plus every dependency
// repo under the SAME owner(s). One installation token can only name repos of its own
// installation (= org), so a public third-party dep (ace18/filament-flatpickr) is kept
// in the fact but must not be requested — GitHub would reject the whole mint.
export function tokenRepos(projectRepos: string[], dependencyRepos: string[]): string[] {
  const owners = new Set(projectRepos.map((r) => r.split('/')[0]));
  const out = [...projectRepos];
  for (const r of dependencyRepos) {
    if (owners.has(r.split('/')[0]) && !out.includes(r)) out.push(r);
  }
  return out;
}

// Same filter, for what the prompt tells the agent it can actually reach.
export function reachableDependencyRepos(projectRepos: string[], dependencyRepos: string[]): string[] {
  return tokenRepos(projectRepos, dependencyRepos).filter((r) => !projectRepos.includes(r));
}
