# Spec Delta

## Purpose

The trial installation the repository ships: a directory with the layout of an operated installation, which starts the bot from the published image, with the web chat and unprivileged sandboxes on the machine's own Docker, from one `docker compose up`.

## ADDED Requirements

### Requirement: The quickstart is an installation directory
The repository SHALL ship `quickstart/` holding `.env.example`, `projects.config.example.json`, `compose/compose.yaml` and `init.sh`. Mounted as `AVEN_DIR`, it SHALL be a complete installation with `HOME` inside it. It SHALL name no path outside itself except the Docker socket and the sandbox image's build context. Everything the person and the installation write there SHALL be ignored by git. Its sandboxes SHALL carry a name prefix and a `managedBy` label of their own.

#### Scenario: State stays out of git
- **WHEN** the quickstart has run turns
- **THEN** `git status` in the clone shows nothing under `quickstart/`

#### Scenario: Beside another installation
- **WHEN** the machine already runs an installation with a project named `demo`
- **THEN** the quickstart creates its own sandbox container and never touches the other one

### Requirement: The trial needs no registry, privilege, Slack or identity provider
The quickstart SHALL:
- run the bot from the published bot image, with the web chat as its chat driver and `WEB_AUTH=link`;
- build the plain sandbox image locally, from the clone, before the bot starts;
- run every project in it unprivileged and without docker-in-docker;
- take its GitHub access from a `GITHUB_TOKEN`.

It SHALL publish the web chat on the machine's loopback only.

#### Scenario: Fresh start
- **WHEN** a person on a machine with Docker runs `./init.sh`, fills the credit, `GITHUB_TOKEN` and the repository, and runs `docker compose up -d` in `quickstart/compose/`
- **THEN** the sandbox image is built, the bot logs `Web chat running` and the sign-in link, and nothing was pulled from a registry other than the bot image and the sandbox image's base

#### Scenario: First answer
- **WHEN** the person opens the link and posts a question in the project's room
- **THEN** a sandbox container is created from `coach-aven-sandbox-plain:local` without `--privileged`, the repository is cloned, and the answer lands in the thread

#### Scenario: Not on the LAN
- **WHEN** another machine on the same network opens port 8787 of the person's machine
- **THEN** the connection is refused

### Requirement: The setup script writes the machine, never secrets
`init.sh` SHALL:
- copy `.env.example` and `projects.config.example.json` only when their targets are missing;
- write `compose/.env` with the image version of the clone's commit (its tag, else `sha-<commit>`, never `latest`), the user's uid and gid, the Docker socket's group as a container sees it, and the web port;
- be safe to run again.

A compose command run before it SHALL fail with a sentence naming `./init.sh`.

It SHALL NOT read, write or print a credential.

#### Scenario: Rerun after editing .env
- **WHEN** the person edits `.env` and reruns `./init.sh`
- **THEN** `.env` is untouched and `compose/.env` is written again

#### Scenario: A clone off a tag
- **WHEN** the clone's HEAD is a `main` commit with no tag
- **THEN** `compose/.env` names `sha-<commit>` and the script warns that it is a canary build

#### Scenario: Compose before init
- **WHEN** the person runs `docker compose up -d` before `./init.sh`
- **THEN** compose stops with a sentence naming `./init.sh`

### Requirement: The bot says when it cannot reach the local Docker
With `SSHDOCKER_HOST=local`, the bot SHALL check in the background after boot that the Docker CLI reaches the daemon, retrying for up to 60 seconds. When it still fails, it SHALL log one error naming the socket and the fix. The boot SHALL NOT wait for the check, and the check SHALL send nothing to the error tracker.

#### Scenario: Wrong socket group
- **WHEN** the bot's process is not in the socket's group
- **THEN** the chat surface starts, and within about a minute the log has one error naming `/var/run/docker.sock` and `./init.sh`

#### Scenario: Docker starting late
- **WHEN** the Docker engine answers 30 seconds after the bot's boot
- **THEN** nothing is logged

#### Scenario: Remote sandbox host
- **WHEN** `SSHDOCKER_HOST` names an ssh target
- **THEN** no check runs and nothing new is logged

### Requirement: The documented path is measured
`docs/quickstart.md` SHALL list the steps from clone to first answer, each with its command, its measured time and what it needs from whom. It SHALL say where the measurement was taken and which platforms were run. It SHALL end with how to uninstall, the sandbox containers included. The README SHALL link to it from a "Try it" block.

#### Scenario: Reading the page
- **WHEN** a reader opens `docs/quickstart.md`
- **THEN** they see the total measured time, the date and machine of the measurement, and the accounts they need before they start
