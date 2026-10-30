# bot-image Specification

## Purpose
Publishes the bot as one container image per commit, built once in CI from the commit's tracked files. An installation then runs an artifact it can name by version, and prod runs the very image the canary ran. The sandboxes' image stays `sandbox-image`.

## Requirements

### Requirement: Every main commit has one published image
Once a commit pushed to `main` has passed verification, CI SHALL build its image for `linux/amd64` and `linux/arm64`. CI SHALL publish the image to the product repository's GitHub container registry as `sha-<commit>`, where `<commit>` is the full commit id.

#### Scenario: Merge to main
- **WHEN** a pull request is merged and the commit's verification passes
- **THEN** `sha-<commit>` exists in the registry with an amd64 and an arm64 image

#### Scenario: Verification fails
- **WHEN** typecheck, the tests or a guard fail on the commit
- **THEN** no image is published for it

### Requirement: The image holds the commit and nothing else
The image SHALL be built from the commit's tracked files only, never from a working tree. It SHALL hold those files, the dependencies `npm ci` installs from the commit's lockfile, Node 24 and the host tools the code calls: git, the OpenSSH client, the Docker CLI, age and gitleaks. No `.git` directory, secret or installation file SHALL enter it.

#### Scenario: Untracked file on the building machine
- **WHEN** the checkout that runs the build holds an untracked file, such as private notes or a `.env`
- **THEN** the image does not contain it

#### Scenario: Contents match the commit
- **WHEN** the files under the image's application directory are listed, `node_modules` aside
- **THEN** each is a tracked file of the commit, and each tracked file of the commit is there

### Requirement: A release promotes the canary's image
On a `vX.Y.Z` tag, CI SHALL publish `vX.Y.Z` as a second name of the tagged commit's `sha-<commit>` image, with the same digest, and `latest` as a third name when `vX.Y.Z` is the highest version among the repository's release tags. It SHALL build that image first only when it does not exist yet.

#### Scenario: Tag of a commit the canary ran
- **WHEN** `vX.Y.Z` is pushed for a `main` commit whose image exists
- **THEN** `vX.Y.Z` and `sha-<commit>` resolve to the same digest, and nothing is rebuilt

#### Scenario: Tag of a commit without an image
- **WHEN** `vX.Y.Z` is pushed for a commit that has no image
- **THEN** the image is built from the commit's tracked files and published as `sha-<commit>` and `vX.Y.Z`

#### Scenario: The newest release
- **WHEN** `v1.5.0` is pushed and no higher release tag exists
- **THEN** `latest` resolves to the digest of `v1.5.0`

#### Scenario: A patch of an older line
- **WHEN** `v1.4.1` is pushed while `v1.5.0` exists
- **THEN** `v1.4.1` is published and `latest` still resolves to `v1.5.0`

### Requirement: The image runs the CLI from any working directory
The image's entry point SHALL run the product's CLI with the arguments the container is given, whatever its working directory. The CLI process SHALL receive the container's stop signal as the systemd service's process does.

#### Scenario: The bot
- **WHEN** a container of the image runs with the arguments `slack` and `/srv/acme` as its working directory
- **THEN** it runs the Slack bot with the configuration it reads there, as `node --import tsx src/cli.ts slack` would in a checkout

#### Scenario: Stop
- **WHEN** the container is stopped
- **THEN** the CLI process receives SIGTERM and shuts down the way it does under systemd

### Requirement: The image carries no installation
The image SHALL hold nothing of any box: no user, path, address or key of an installation. It SHALL run under any uid the runtime gives it, with or without a user record in the image, and keep everything it writes under the installation directory and `HOME`. With sandboxes on the local Docker (`SSHDOCKER_HOST=local`) it SHALL need no SSH key and no user record.

#### Scenario: One mounted directory
- **WHEN** a container of the image runs as uid 4242, which the image does not know, with one directory holding a `.env` for the web chat driver mounted as `AVEN_DIR`, `HOME` set inside that directory, `SSHDOCKER_HOST=local` and the host's Docker socket
- **THEN** the web chat comes up, its sandboxes start on that Docker, and everything the bot writes lands in the mounted directory

#### Scenario: Sandboxes over SSH
- **WHEN** `SSHDOCKER_HOST` names another host
- **THEN** the uid needs a user record and the deployer's keys, which the runtime supplies (`container-deploy`); the image itself holds neither

### Requirement: The image names its source
The image SHALL carry the standard labels for its source repository and the commit it was built from. A release tag adds a name, never a different image.

#### Scenario: Inspecting a release
- **WHEN** an operator inspects `vX.Y.Z`
- **THEN** its labels name the product repository and the tagged commit

### Requirement: A broken image build is caught before merge
A pull request that changes the image's inputs (the image's build file, `package.json` or the lockfile) SHALL build the image for `linux/amd64` and `linux/arm64` without publishing it, and SHALL fail when either build fails.

#### Scenario: A dependency that does not build
- **WHEN** a pull request changes the lockfile so that `npm ci` fails inside the image
- **THEN** the pull request's checks fail and nothing is published

#### Scenario: A dependency that builds on one architecture only
- **WHEN** a pull request adds a dependency that installs on amd64 but not on arm64
- **THEN** the pull request's checks fail before the merge, so `main` never lacks an arm64 image because of it
