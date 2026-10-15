# Spec Delta

## Purpose
Keeps the public repository free of tenant and personal identifiers and keeps production deploy secrets reachable only from protected tags, so publishing the code never publishes a customer, a person, or a host.

## ADDED Requirements

### Requirement: No tenant identifiers in tracked files
CI SHALL fail when any tracked file matches a pattern in `scripts/public-guard.txt` (third-party e-mail domains, tenant ids, host IPs and hostnames). Product defaults (channel-name prefixes, example slugs) are not identifiers and SHALL NOT be listed.

#### Scenario: A real mailbox lands in a test
- **WHEN** a commit adds `someone@<a-real-partner-domain>` to a `*.test.ts`
- **THEN** the `public-guard` job fails and names the file and line

#### Scenario: Placeholder values
- **WHEN** a doc uses `you@example.com`, `T_FIX_1` or `<gateway-host>`
- **THEN** the guard passes

### Requirement: No secrets in tracked files
CI SHALL run gitleaks over the tree on every push and pull request and fail on a finding; test placeholders are allow-listed by path in `.gitleaks.toml`.

#### Scenario: Scrub-test placeholder
- **WHEN** `src/scrub.test.ts` contains a `xoxb-1234…` fixture
- **THEN** gitleaks passes because the path is allow-listed

### Requirement: History free of the same identifiers
Before the visibility flip, the full history (`git log --all -p`) SHALL match no pattern of `scripts/public-guard.txt`.

#### Scenario: Rewritten history
- **WHEN** `git filter-repo --replace-text` has run and been force-pushed
- **THEN** the guard over the fresh mirror's full history reports nothing

### Requirement: Deploy secrets only from protected tags
The `production` GitHub environment SHALL require a reviewer and SHALL allow deployments only from `v*` tags.

#### Scenario: Workflow dispatched from a branch
- **WHEN** the deploy job is started with a branch ref
- **THEN** GitHub refuses the environment and no secret is exposed

### Requirement: License and public scaffolding
The repository SHALL carry `LICENSE` (Apache-2.0), `CONTRIBUTING.md` and `SECURITY.md`, and `README.md` SHALL describe a self-host path without naming any tenant.
