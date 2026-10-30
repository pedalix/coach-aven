# Spec Delta

## ADDED Requirements

### Requirement: The plain image is published under the bot's version names
This repository's CI SHALL build the plain sandbox image from `snapshot/plain` for every `main` commit, for `amd64` and `arm64`. It SHALL publish the image as `ghcr.io/<owner>/coach-aven-sandbox-plain:sha-<commit>`. A release tag SHALL promote it to `vX.Y.Z`, and to `latest` when that tag is the highest release, beside the bot image of the same commit. A commit without a sandbox image SHALL NOT fail the release. Only the plain variant SHALL be published.

#### Scenario: A main commit
- **WHEN** a commit lands on `main` and verify passes
- **THEN** `ghcr.io/<owner>/coach-aven:sha-<commit>` and `ghcr.io/<owner>/coach-aven-sandbox-plain:sha-<commit>` both exist for both architectures

#### Scenario: A release
- **WHEN** `vX.Y.Z` is tagged on a commit with both images
- **THEN** both images get `vX.Y.Z`, each with the same digest as its `sha-<commit>`

#### Scenario: A pull request changing the image
- **WHEN** a pull request changes a file under `snapshot/plain/`
- **THEN** CI builds the image for both architectures without publishing it, and checks every listed tool, the absence of `docker`, and `claude --version`
