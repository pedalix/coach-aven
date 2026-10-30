# Spec Delta

## Purpose

Runs an installation from the published image with Docker Compose. A deploy names a version, nothing is uploaded from an operator's machine, and nothing is built on the box. This covers how a version is deployed, checked and rolled back, how scheduled jobs run, and how an installation moves off its systemd unit.

## ADDED Requirements

### Requirement: Install prepares the box and starts nothing
On a compose installation, `deploy.sh <slug> install` SHALL check that the box has Docker Engine with the Compose plugin and SHALL refuse, naming what is missing, when it does not. When the check passes, it SHALL render the compose file into `compose/` under the installation directory, create the deployer's `.config/coach-aven` when it is missing, and start nothing.

#### Scenario: Docker missing
- **WHEN** `install` runs against a box without the Compose plugin
- **THEN** it exits non-zero, names the missing component, and changes nothing on the box

#### Scenario: Ready box
- **WHEN** `install` runs against a box with Docker Engine and the Compose plugin
- **THEN** `compose/compose.yaml` is in the installation directory, and no container and no unit has been started or stopped

#### Scenario: Missing configuration directory
- **WHEN** `install` runs for a deployer whose home has no `.config/coach-aven`
- **THEN** the directory exists afterwards, owned by the deployer and readable by nobody else

### Requirement: An installation runs one version of the image
A compose installation SHALL run the bot, and the sources daemon where it has one, as containers of the same pinned image version, in a compose project named after the installation's service. Docker SHALL restart each container when it exits, and no code SHALL run from the installation directory.

#### Scenario: Bot and daemon
- **WHEN** `v1.4.0` is deployed to an installation that runs a sources daemon
- **THEN** both containers run the digest of `v1.4.0`

#### Scenario: Crash
- **WHEN** the bot process exits
- **THEN** Docker starts it again with the same version

#### Scenario: Other projects on the box
- **WHEN** the box runs other compose projects
- **THEN** a deploy or a `down` touches only the project named after the service, and the bot's containers carry that name

### Requirement: The containers see the box the way the service did
The containers SHALL run as the deployer's user with host networking. They SHALL mount the installation directory at its own path as their working directory and as `AVEN_DIR`, the deployer's `.config/coach-aven` at its own path and, when the sandboxes are on another host, the deployer's `.ssh` read-only. Every path and address in `.env` and the projects config then means what it meant under systemd.

#### Scenario: Remote sandbox host
- **WHEN** `SSHDOCKER_HOST` names a host the deployer reaches with its key
- **THEN** the bot in the container reaches that host with the same key and the same known hosts

#### Scenario: Loopback listener behind the host's proxy
- **WHEN** the installation serves its web chat on `127.0.0.1:8787` behind the host's reverse proxy
- **THEN** the proxy reaches it as before, without a port mapping

#### Scenario: Files the bot writes
- **WHEN** the bot writes `state.json`
- **THEN** the file belongs to the deployer, as it did under systemd

#### Scenario: A key named by absolute path
- **WHEN** `HUB_KEY_PATH` names a file under the deployer's `.config/coach-aven`
- **THEN** the bot in the container reads it

### Requirement: The home files the code falls back to follow the deployer
When the deployer's home holds a file the code falls back to when a setting is absent, `.netrc` or `.claude/.credentials.json`, the bot container SHALL see it read-only at its own path. When the file is absent, the container SHALL start without it and nothing SHALL be created in its place.

#### Scenario: A tracker's credentials in `.netrc`
- **WHEN** the deployer's `.netrc` holds the entry a tracker puller falls back to
- **THEN** the puller in the container reads the same entry

#### Scenario: No such file
- **WHEN** the deployer's home has no `.netrc`
- **THEN** the container starts, and the deployer's home still has no `.netrc` and no directory of that name

### Requirement: Sandboxes on the box's own Docker or on another host
An installation whose sandboxes run on the box's own Docker (`SSHDOCKER_HOST=local`) SHALL give the bot container the host's Docker socket and no SSH key; the sandboxes it starts are then its siblings on that engine, as they are under systemd. An installation whose sandboxes run on another host SHALL give the bot container the deployer's keys and no Docker socket. Both are supported placements of an installation.

#### Scenario: Local sandboxes
- **WHEN** the installation's `.env` sets `SSHDOCKER_HOST=local`
- **THEN** the bot container creates and runs sandboxes on the host's Docker, and holds no SSH key

#### Scenario: Remote sandboxes
- **WHEN** `SSHDOCKER_HOST` names another host
- **THEN** the bot container has no Docker socket, and reaches that host with the deployer's key

### Requirement: Logs go to the journal
Each container's output SHALL go to the host journal, so the lines survive the container's replacement at the next deploy, and `deploy.sh <slug> logs` SHALL follow the bot's output as it did under systemd.

#### Scenario: Following the bot
- **WHEN** an operator runs `deploy.sh <slug> logs` on a compose installation
- **THEN** the bot's output follows, the same lines the systemd unit's journal carried

#### Scenario: The log of a failed deploy
- **WHEN** a deploy failed and its containers were replaced by the next deploy
- **THEN** the failed version's lines are still in the journal

### Requirement: A deploy names a published version
`deploy.sh <slug> deploy <version>` and the ops workflow SHALL deploy a version that exists in the registry: `vX.Y.Z`, or `sha-<commit>` on an installation configured as a canary, and nothing else, `latest` included. They SHALL upload nothing from the operator's machine and build nothing on the box.

#### Scenario: Deploy from a dirty checkout
- **WHEN** an operator deploys `v1.4.0` from a checkout with local edits and untracked files
- **THEN** the box runs exactly the registry's `v1.4.0`, and nothing from the checkout reaches the box

#### Scenario: Unknown version
- **WHEN** the version does not exist in the registry
- **THEN** the deploy stops before the running containers are touched, and names the version

#### Scenario: Commit image on a release installation
- **WHEN** `sha-<commit>` is deployed to an installation that is not configured as a canary
- **THEN** the deploy is refused before anything changes

#### Scenario: A moving tag
- **WHEN** `latest` is given as the version
- **THEN** the deploy is refused, and the message names the two accepted forms

### Requirement: The version is pinned in the installation directory
The deployed version SHALL be written to a file in the compose directory that the compose file reads, so that `docker compose` in that directory always runs the pinned version. Each deploy SHALL append one line with its time, version and outcome to `deploys.log` in the installation directory. `deploy.sh <slug> status` SHALL show the pinned version and the containers.

#### Scenario: Status after a deploy
- **WHEN** `v1.4.0` was deployed after `v1.3.0` and an operator runs `status`
- **THEN** it shows `v1.4.0` as pinned with the running containers, and `deploys.log` ends with the lines for `v1.3.0` and `v1.4.0`

#### Scenario: Compose by hand
- **WHEN** an operator runs `docker compose up -d` in the compose directory
- **THEN** the pinned version runs, not another

### Requirement: A deploy that does not come up fails
After starting a version, the deploy SHALL wait for the chat driver's running line in the bot's log. When the line does not come in time, the deploy SHALL exit non-zero, show the end of the log and record the version as failed. The earlier version's image SHALL stay on the box, so that deploying it again needs no registry.

#### Scenario: Healthy release
- **WHEN** the driver's running line appears in time
- **THEN** the deploy exits zero and records the version as `ok`

#### Scenario: Broken release
- **WHEN** the line does not appear in time
- **THEN** the deploy exits non-zero, `deploys.log` records the version as `failed`, and `deploy.sh <slug> deploy <earlier version>` puts the earlier version back without pulling

### Requirement: A rollback is a deploy of the earlier version
Deploying an earlier version SHALL run exactly the image that version had, so nothing of the later version stays in the code that runs.

#### Scenario: Back to the previous release
- **WHEN** `v1.3.0` is deployed after `v1.4.0`
- **THEN** the bot runs the digest `v1.3.0` had, and no file of `v1.4.0` is part of what runs

### Requirement: The deployer deploys with its own Docker access
On a compose installation the deployer SHALL run `docker compose` itself, from the compose directory, with the Docker access its membership of the `docker` group gives it. No root session and no sudo rule SHALL be needed for a deploy.

#### Scenario: Deploy from CI
- **WHEN** the ops workflow logs in with the deployer's key and deploys `v1.4.0`
- **THEN** the deploy succeeds over that one session

#### Scenario: A deployer outside the group
- **WHEN** the deployer is not in the `docker` group
- **THEN** `install` refuses and names the prerequisite

### Requirement: Scheduled jobs run from the image
A job that the installation schedules on the box SHALL run the CLI from the pinned version's image, with the bot's mounts and environment, through `docker compose run` in the compose directory. The repository mirror SHALL be the CLI command `orch mirror`.

#### Scenario: The mirror job
- **WHEN** the deployer's crontab runs `docker compose run --rm --no-deps bot mirror` in the compose directory every 30 minutes
- **THEN** each run mirrors with the pinned version and appends to the same log file as before

#### Scenario: The job follows the deploy
- **WHEN** a new version is deployed between two runs
- **THEN** the next run uses the new version

### Requirement: Errors carry the deployed version
The bot in a compose installation SHALL report errors with the deployed version as the release: `vX.Y.Z` for a release, and `main@<short commit>` for a commit image.

#### Scenario: Canary
- **WHEN** `sha-<commit>` runs on a canary installation and an error is reported
- **THEN** the error's release is `main@` followed by the first seven characters of the commit

### Requirement: An installation moves by a documented checklist, and can move back until the old code is removed
A compose deploy SHALL refuse while the installation's systemd unit is active. The move SHALL be documented as a checklist: stop and disable the units, set the runtime, install, deploy the version the box ran, rewrite the scheduled job, and remove the old code last. The documentation SHALL list what the cleanup removes, which SHALL be the code only, never configuration or state, and how to move back while the code is still there.

#### Scenario: Unit still active
- **WHEN** `deploy` runs on a box whose bot unit is active
- **THEN** it refuses and names the command that stops the unit

#### Scenario: Moving back before cleanup
- **WHEN** an operator runs `down` and enables the unit again after the first compose deploy and before the cleanup
- **THEN** the unit runs the code still in the directory, with the same state

#### Scenario: What the cleanup removes
- **WHEN** the operator runs the documented cleanup command
- **THEN** `src/`, `node_modules/`, `package.json` and the rest of the old code are gone, and `.env`, `state.json`, `data/`, `compose/` and the other configuration and state stay
