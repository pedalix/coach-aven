# release-deploy-split Specification

## Purpose
Separates publishing a release of the product from deploying an installation of it, so the public repository holds no installation's secrets and any number of installations can deploy the same release with their own.

## Requirements

### Requirement: The product repo publishes and notifies, never deploys
On a `v*` tag the product repository SHALL verify the code, publish a GitHub Release, and — when the notification credentials (a GitHub App key) are configured — notify the operator's ops repository with the tag; it SHALL NOT hold deploy keys, deploy targets or a deploy environment.

#### Scenario: Tag with a dispatch token
- **WHEN** `vX.Y.Z` is pushed and the App secrets are set
- **THEN** a release `vX.Y.Z` is published and the ops repository receives a `coach-aven-release` dispatch whose payload names `vX.Y.Z`

#### Scenario: Tag without a dispatch token (a fork, a self-hoster)
- **WHEN** `vX.Y.Z` is pushed and no App secrets exist
- **THEN** the release is published and the notification step is skipped without failing the workflow

#### Scenario: Verification fails
- **WHEN** typecheck, tests or a guard fail on the tag
- **THEN** no release is published and no notification is sent

### Requirement: The ops repo deploys a named release with its own secrets
The ops repository's deploy workflow SHALL deploy exactly one tag of the product repository to the installation it describes, using an SSH key and a deploy target stored only in that repository, and SHALL run the same upload → install → restart → health-check sequence as the manual `deploy.sh deploy`.

#### Scenario: Release dispatch
- **WHEN** the ops repository receives `coach-aven-release` for `vX.Y.Z`
- **THEN** the product repository is checked out at `vX.Y.Z`, deployed, and the service reports healthy; the deployed release is stamped `vX.Y.Z` for error tracking

#### Scenario: Manual deploy of a tag
- **WHEN** an operator starts the workflow by hand with tag `vX.Y.Z`
- **THEN** the same deployment runs for that tag

#### Scenario: Two deploys at once
- **WHEN** a second deploy starts while one is running
- **THEN** it waits; deploys never overlap on the box

#### Scenario: Health check fails
- **WHEN** the service does not report healthy after restart
- **THEN** the workflow fails and the failure is visible on the ops repository's Actions page

### Requirement: The pattern is reproducible for another installation
The product repository SHALL ship a template of the ops deploy workflow with placeholders and instructions, such that a second installation needs only its own ops repository, two secrets and (optionally) a dispatch token to deploy releases.

#### Scenario: A new installation
- **WHEN** an operator copies the template into their ops repository and adds `DEPLOY_SSH_KEY` and `DEPLOY_ENV`
- **THEN** `workflow_dispatch` with a tag deploys that release to their host without any change to the product repository
