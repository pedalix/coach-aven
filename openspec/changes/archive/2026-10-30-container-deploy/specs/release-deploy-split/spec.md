# Spec Delta

## MODIFIED Requirements

### Requirement: The product repo publishes and notifies, never deploys
On a `v*` tag the product repository SHALL verify the code and publish the tag's image (`bot-image`). It SHALL then publish a GitHub Release and, when the notification credentials (a GitHub App key) are configured, notify the operator's ops repository with the tag. The image SHALL exist before the release and the notification. The product repository SHALL NOT hold deploy keys, deploy targets or a deploy environment.

#### Scenario: Tag with a dispatch token
- **WHEN** `vX.Y.Z` is pushed and the App secrets are set
- **THEN** the image `vX.Y.Z` is published first, then a release `vX.Y.Z`, and the ops repository receives a `coach-aven-release` dispatch whose payload names `vX.Y.Z`

#### Scenario: Tag without a dispatch token (a fork, a self-hoster)
- **WHEN** `vX.Y.Z` is pushed and no App secrets exist
- **THEN** the image and the release are published, and the notification step is skipped without failing the workflow

#### Scenario: Verification fails
- **WHEN** typecheck, tests or a guard fail on the tag
- **THEN** no image is published under the tag, no release is published and no notification is sent

#### Scenario: The image cannot be published
- **WHEN** the tag's image cannot be built or published
- **THEN** no release is published and no notification is sent

### Requirement: The ops repo deploys a named release with its own secrets
The ops repository's deploy workflow SHALL deploy exactly one published version of the product to the installation it describes, using an SSH key and a deploy target stored only in that repository. On a systemd installation it SHALL run the sequence of the manual `deploy.sh deploy`. On a compose installation it SHALL run `deploy.sh <slug> deploy <version>`, which pulls the version's image on the box and uploads nothing.

#### Scenario: Release dispatch
- **WHEN** the ops repository receives `coach-aven-release` for `vX.Y.Z`
- **THEN** `vX.Y.Z` is deployed and the service reports healthy, and the deployed release is stamped `vX.Y.Z` for error tracking

#### Scenario: Manual deploy of a tag
- **WHEN** an operator starts the workflow by hand with tag `vX.Y.Z`
- **THEN** the same deployment runs for that tag

#### Scenario: Two deploys at once
- **WHEN** a second deploy starts while one is running
- **THEN** it waits; deploys never overlap on the box

#### Scenario: Health check fails
- **WHEN** the service does not report healthy after the new version starts
- **THEN** the workflow fails and the failure is visible on the ops repository's Actions page. On a compose installation the failed version is recorded, and the earlier version is one deploy away.

#### Scenario: A canary deploys a main commit
- **WHEN** the ops repository marks its installation as a canary and an operator starts the workflow with `sha-<commit>`
- **THEN** that commit's image is deployed

#### Scenario: A main commit on a release installation
- **WHEN** an ops repository that does not mark its installation as a canary is asked to deploy `sha-<commit>`
- **THEN** the workflow refuses before it connects to the box
