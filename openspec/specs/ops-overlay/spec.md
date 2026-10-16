# ops-overlay Specification

## Purpose
Keeps an installation (project list, prompts, topology, operator notes) in its own repository, checked out at the runtime directory, so the public repo documents the mechanism and never carries an instance.

## Requirements

### Requirement: Runtime directory is an ops repository
`infra/prod/runtime/` SHALL be a git checkout of the operator's private ops repo; `deploy.sh export` SHALL push it and upload only the secret files by scp, ; both SHALL refuse to run when the directory is not a git checkout and print the clone command.

#### Scenario: Export with unpushed config
- **WHEN** `projects.config.json` is edited and committed but not pushed and `export` runs
- **THEN** the overlay is pushed, the runtime files are uploaded, and the script prints `restart` as the next step

#### Scenario: Export with uncommitted config
- **WHEN** the checkout has uncommitted changes and `export` runs
- **THEN** nothing is pushed or uploaded; the script lists the dirty files and exits non-zero

#### Scenario: Runtime dir is a plain folder
- **WHEN** `infra/prod/runtime/` exists without `.git`
- **THEN** `export`/`import` exit non-zero and name the clone command

### Requirement: Secrets never enter the ops repo
`.env` and the GitHub App key SHALL be ignored by the ops repo's `.gitignore`; the public guard SHALL also run against the overlay's tracked files in the operator's CI (advisory, not enforced by the public repo).

#### Scenario: Key placed in the overlay
- **WHEN** `github-app-private-key.pem` is written into `infra/prod/runtime/`
- **THEN** `git -C infra/prod/runtime status` does not list it

### Requirement: Template for a new installation
The public repo SHALL ship `infra/prod/runtime.example/` with a placeholder `projects.config.json` and one `projects.d/example.md`, and `infra/prod/README.md` SHALL explain how to start an ops repo from it.

#### Scenario: Starting a new installation
- **WHEN** an operator copies `infra/prod/runtime.example/` into a new private repository and clones it at `infra/prod/runtime/`
- **THEN** `npm run prod:export` accepts it as the ops checkout and the template contains no identifier of our installation
