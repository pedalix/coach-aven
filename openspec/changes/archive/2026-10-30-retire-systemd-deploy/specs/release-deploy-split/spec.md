# Spec Delta

## MODIFIED Requirements

### Requirement: The ops repo deploys a named release with its own secrets
The ops repository's deploy workflow SHALL deploy exactly one published version of the product to the installation it describes, using an SSH key and a deploy target stored only in that repository. It SHALL run `deploy.sh <slug> deploy <version>`, which pulls the version's image on the box and uploads nothing.

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
- **THEN** the workflow fails and the failure is visible on the ops repository's Actions page; the failed version is recorded on the box, and the earlier version is one deploy away

#### Scenario: A canary deploys a main commit
- **WHEN** the ops repository marks its installation as a canary and an operator starts the workflow with `sha-<commit>`
- **THEN** that commit's image is deployed

#### Scenario: A main commit on a release installation
- **WHEN** an ops repository that does not mark its installation as a canary is asked to deploy `sha-<commit>`
- **THEN** the workflow refuses before it connects to the box
