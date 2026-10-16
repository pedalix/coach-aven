# public-repo-hygiene Specification

## Purpose
Keeps the public repository free of tenant and personal identifiers and keeps production deploy secrets reachable only from protected tags, so publishing the code never publishes a customer, a person, or a host.

## Requirements

### Requirement: No tenant identifiers in tracked files
CI SHALL fail when any tracked file matches a pattern of the guard: the public patterns in `scripts/public-guard.txt` plus the operator's private deny-list (names of installations, customers and people, their e-mail domains, ids, IPs and hostnames), which SHALL NOT live in this repository and reaches CI as the secret `PUBLIC_GUARD_PATTERNS`. Product defaults (channel-name prefixes, example slugs) are not identifiers and SHALL NOT be listed. On pushes and tags a missing private list SHALL fail the guard; a fork pull request (no secrets) runs the public patterns only. The guard's output SHALL name file and line only, never the matched text.

#### Scenario: A real mailbox lands in a test
- **WHEN** a commit adds `someone@<a-real-partner-domain>` to a `*.test.ts`
- **THEN** the `public-guard` job fails and names the file and line

#### Scenario: A name in a pull request's text
- **WHEN** a pull request's title, body or one of its commit messages contains a name of the private list
- **THEN** the `public-guard` job fails, also after the title is edited, and names only the line

#### Scenario: The deny-list stays private
- **WHEN** someone reads the public repository, its history or a CI log
- **THEN** they find no list of the names the guard looks for

#### Scenario: Placeholder values
- **WHEN** a doc uses `you@example.com`, `T_FIX_1` or `<gateway-host>`
- **THEN** the guard passes

### Requirement: No secrets in tracked files
CI SHALL run gitleaks over the tree on every push and pull request and fail on a finding; test placeholders are allow-listed by path in `.gitleaks.toml`.

#### Scenario: Scrub-test placeholder
- **WHEN** `src/scrub.test.ts` contains a `xoxb-1234…` fixture
- **THEN** gitleaks passes because the path is allow-listed

### Requirement: History free of the same identifiers
Before the visibility flip, the full history (`git log --all -p`, commit and tag messages, and the decompressed contents of gzipped blobs) SHALL match no pattern of the guard, private list included.

#### Scenario: Rewritten history
- **WHEN** the history has been rewritten with the private scrub dictionary and pushed to a recreated repository
- **THEN** the guard over the fresh mirror's full history reports nothing

### Requirement: Deploy secrets only from protected tags
The `production` GitHub environment SHALL require a reviewer and SHALL allow deployments only from `v*` tags.

#### Scenario: Workflow dispatched from a branch
- **WHEN** the deploy job is started with a branch ref
- **THEN** GitHub refuses the environment and no secret is exposed

### Requirement: License and public scaffolding
The repository SHALL carry `LICENSE` (Apache-2.0), `CONTRIBUTING.md` and `SECURITY.md`, and `README.md` SHALL describe a self-host path without naming any tenant.

#### Scenario: A stranger opens the repository
- **WHEN** someone without access to our installation reads the repository root
- **THEN** they find `LICENSE` (Apache-2.0), `CONTRIBUTING.md`, `SECURITY.md` and a README whose quickstart names no tenant, host or person of ours
