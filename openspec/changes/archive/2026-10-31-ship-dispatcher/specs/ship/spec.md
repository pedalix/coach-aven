# Spec Delta

## Purpose

Moving an operator's installations to a version in a fixed stage order, from one command with one lock and one journal, so parallel sessions never deploy over each other and a release installation only receives a commit that an earlier stage already runs.

## ADDED Requirements

### Requirement: Only installations with a stage are shipped
`ship` SHALL act only on installations whose overlay `deploy.env` names `STAGE=<n>` (a positive integer). For an installation without it, `ship` SHALL exit non-zero before changing anything and name the key. Several installations MAY share a stage.

#### Scenario: Overlay without a stage
- **WHEN** the operator runs `npm run ship -- pilot` and `infra/pilot/deploy.env` has no `STAGE`
- **THEN** nothing is deployed and the message names `STAGE` and the file

#### Scenario: Order follows the stage, not the arguments
- **WHEN** `home` has `STAGE=1`, `pilot` has `STAGE=2` and the operator runs `npm run ship -- pilot home`
- **THEN** `home` is shipped first, then `pilot`

### Requirement: The first stage gets the newest green main
For an installation of the lowest configured stage, `ship` SHALL pick by default the newest `main` commit whose CI run succeeded and whose `sha-<commit>` image exists. When no such commit exists, it SHALL exit non-zero, naming the newest `main` commit and what it lacks.

#### Scenario: The newest commit is still building
- **WHEN** the newest `main` commit's CI is still running and the one before it is green with its image published
- **THEN** `ship home` deploys the one before it and says which commit it skipped and why

### Requirement: A later stage gets what the stage before it runs
For an installation of stage N above the lowest, `ship` SHALL by default pick the commit that the installations of the nearest lower stage run, read from their pinned versions. When those installations run different commits, it SHALL pick the oldest of them, which is an ancestor of the others.

#### Scenario: Promoting staging's commit to prod
- **WHEN** `pilot` (stage 2) runs `sha-abc…` and the operator runs `ship prod` (stage 3)
- **THEN** `prod` receives a release of commit `abc…`, not the newest `main`

### Requirement: A release stage only receives what a lower stage already ran
`ship` SHALL refuse to deploy a commit to an installation of stage N unless the commit is the commit pinned on an installation of a lower stage, or an ancestor of it. An explicit `--version` or `--commit` SHALL be checked the same way. The lowest stage is exempt.

#### Scenario: Skipping a stage
- **WHEN** the operator runs `ship prod --commit <newest main>` and no lower stage runs that commit or a descendant of it
- **THEN** nothing is deployed and the message names the lower stages and what they run

#### Scenario: Rollback passes the check
- **WHEN** the operator runs `ship prod --version v0.47.0` while `pilot` runs a descendant of `v0.47.0`
- **THEN** `prod` is deployed `v0.47.0` through `deploy.sh` as any other version

### Requirement: A release installation is deployed a tag
For an installation not marked `CANARY=1`, `ship` SHALL deploy a `vX.Y.Z` tag of the chosen commit. When the commit has no release tag, `ship` SHALL create the next one and push it. When the commit already has one, it SHALL reuse it. It SHALL deploy only after the release workflow has published that version's image, and SHALL stop with the run's link when the workflow fails.

#### Scenario: Re-shipping a tagged commit
- **WHEN** the chosen commit already carries `v0.48.0`
- **THEN** no tag is created and `v0.48.0` is deployed

#### Scenario: The release workflow fails
- **WHEN** the release workflow for the new tag fails
- **THEN** no installation is deployed and `ship` prints the failed run's link

### Requirement: The next version follows the merged PRs' labels
The tag `ship` creates SHALL be the next minor version when a PR merged since the last release tag carries the `feature` label, and the next patch version otherwise. `--version vX.Y.Z` SHALL override the computed tag.

#### Scenario: Only fixes since the last tag
- **WHEN** the last tag is `v0.48.0` and the PRs merged since carry only `fix` and `docs` labels
- **THEN** `ship` tags `v0.48.1`

#### Scenario: A feature since the last tag
- **WHEN** one PR merged since `v0.48.0` carries the `feature` label
- **THEN** `ship` tags `v0.49.0`

### Requirement: A canary installation is deployed the commit's image
For an installation marked `CANARY=1`, `ship` SHALL deploy `sha-<commit>` of the chosen commit, unless `--version vX.Y.Z` names a release.

#### Scenario: Home takes main's image
- **WHEN** `home` is `CANARY=1`, `STAGE=1` and the newest green commit is `def…`
- **THEN** `ship home` runs `deploy.sh home deploy sha-def…`

### Requirement: Each step deploys through deploy.sh and stops at the first failure
`ship` SHALL deploy each installation with `deploy.sh <slug> deploy <version>`, one at a time in stage order. When a step fails, it SHALL deploy no later installation, exit non-zero, and name the failed installation and the earlier version deployed there.

#### Scenario: Staging does not come up
- **WHEN** `ship home pilot prod` runs and `pilot` does not report its running line
- **THEN** `prod` is not touched, and the message names `pilot` and the version to deploy for a rollback

### Requirement: A local installation deploys without ssh
`deploy.sh` SHALL run the deploy script directly on the machine for an installation whose `deploy.env` names `DEPLOY_HOST=localhost`. For any other host it SHALL run the same script over ssh as before.

#### Scenario: The home installation on the operator's machine
- **WHEN** `infra/home/deploy.env` names `DEPLOY_HOST=localhost` and the operator runs `deploy.sh home deploy sha-<commit>`
- **THEN** the image is pulled, pinned and started on this machine with no ssh connection

#### Scenario: A box is unchanged
- **WHEN** `deploy.env` names a remote host
- **THEN** the deploy runs over ssh with the same script as before this change

### Requirement: Ships never overlap
`ship` SHALL hold one lock for the whole run, shared by every checkout of the same operator machine. A second `ship` started while the lock is held SHALL exit non-zero at once, naming the running ship's installations and start time. A plan (`--plan`) and `where` SHALL NOT need the lock.

#### Scenario: Two sessions ship at once
- **WHEN** session A runs `ship home` and session B runs `ship home` a few seconds later
- **THEN** B exits without deploying and says that A's ship to `home` started at the given time

### Requirement: Every step is journaled
`ship` SHALL append one line per installation step to `infra/ships.log` of the checkout that holds the overlays: UTC time, installation, version, commit, and `ok` or `failed`. The journal SHALL be ignored by git.

#### Scenario: A three-stage ship
- **WHEN** `ship home pilot prod` succeeds
- **THEN** `infra/ships.log` gains three lines in stage order, each `ok`

### Requirement: A plan changes nothing
`ship --plan <slug>…` SHALL print, for each installation in stage order, the version and commit it would deploy, the range since what that installation runs, and the titles and numbers of the PRs merged in that range. It SHALL create no tag, deploy nothing and write no journal line.

#### Scenario: Planning a release
- **WHEN** the operator runs `ship --plan prod`
- **THEN** the output names the version `ship` would tag, the commit, and every PR merged since prod's version, and `git tag` and `infra/ships.log` are unchanged

### Requirement: where reports what each installation runs
`npm run where` SHALL read each staged installation's pinned version from where the installation runs, and print the version, the commit and how many `main` commits it is behind. With a PR number or a commit, it SHALL print for each installation whether it runs that commit (the commit is the pinned one or an ancestor of it). It SHALL say when an installation could not be reached.

#### Scenario: Is my PR live?
- **WHEN** PR #142 was merged as commit `c1…`, `home` runs a descendant of `c1…` and `prod` runs an older release
- **THEN** `where 142` prints `home ✓` with its version and `prod ✗` with its version

#### Scenario: A box is unreachable
- **WHEN** the ssh connection to `prod`'s host fails
- **THEN** `where` prints the other installations and says `prod: unreachable`, and exits non-zero
