# Spec Delta

## Purpose

The trial installation the repository ships: a directory with the layout of an operated installation, which starts the bot from the published image, with the web chat and unprivileged sandboxes on the machine's own Docker, driven by one script.

## ADDED Requirements

### Requirement: The quickstart is an installation directory
The repository SHALL ship `quickstart/` holding `.env.example`, `projects.config.example.json`, `compose/compose.yaml` and the script `coach-aven`. Mounted as `AVEN_DIR`, it SHALL be a complete installation with `HOME` inside it. It SHALL name no path outside itself except the Docker socket. Everything the person and the installation write there SHALL be ignored by git. Its sandboxes SHALL carry a name prefix and a `managedBy` label of their own.

#### Scenario: State stays out of git
- **WHEN** the quickstart has run turns
- **THEN** `git status` in the clone shows nothing under `quickstart/`

#### Scenario: Beside another installation
- **WHEN** the machine already runs an installation with a project named `demo`
- **THEN** the quickstart creates its own sandbox container and never touches the other one

### Requirement: The trial needs no registry, privilege, Slack or identity provider
The quickstart SHALL:
- run the bot from the published bot image, with the web chat as its chat driver and `WEB_AUTH=link`;
- run its sandboxes from the published plain sandbox image of the same version as the bot image, pulled by `coach-aven init`;
- run every project in it unprivileged and without docker-in-docker;
- take its GitHub access from a `GITHUB_TOKEN`.

It SHALL publish the web chat on the machine's loopback only.

#### Scenario: Fresh start
- **WHEN** a person on a machine with Docker runs `./coach-aven init <owner/repo>`, fills the credit and `GITHUB_TOKEN`, and runs `./coach-aven up`
- **THEN** nothing is built on the machine, and the script prints the sign-in link of that start

#### Scenario: First answer
- **WHEN** the person opens the link and posts a question in the project's room
- **THEN** a sandbox container is created from `ghcr.io/pedalix/coach-aven-sandbox-plain:<the bot's version>` without `--privileged`, the repository is cloned, and the answer lands in the thread

#### Scenario: Not on the LAN
- **WHEN** another machine on the same network opens port 8787 of the person's machine
- **THEN** the connection is refused

### Requirement: The setup script writes the machine, never secrets
`coach-aven init` SHALL:
- copy `.env.example` and `projects.config.example.json` only when their targets are missing;
- write `compose/.env` with the image version of the clone's commit (its tag, else `sha-<commit>`, never `latest`), the user's uid and gid, the Docker socket's group as a container sees it, and the web port;
- be safe to run again.

A compose command run before it SHALL fail with a sentence naming `./coach-aven init`.

The script SHALL NOT read, write or print a credential.

#### Scenario: Rerun after editing .env
- **WHEN** the person edits `.env` and reruns `./coach-aven init`
- **THEN** `.env` is untouched and `compose/.env` is written again

#### Scenario: A clone off a tag
- **WHEN** the clone's HEAD is a `main` commit with no tag
- **THEN** `compose/.env` names `sha-<commit>` and the script warns that it is a canary build

#### Scenario: Compose before init
- **WHEN** the person runs `docker compose up -d` or `./coach-aven up` before `./coach-aven init`
- **THEN** it stops with a sentence naming `./coach-aven init`

### Requirement: The setup script names the repository
`coach-aven init owner/repo` SHALL write that repository as the only entry of the project's `repos`, and SHALL refuse a value that is not `owner/repo`.

#### Scenario: The repository named
- **WHEN** the person runs `./coach-aven init acme/shop`, then `./coach-aven init acme/billing`
- **THEN** the project lists `acme/billing` only, and `./coach-aven init 'not a repo'` is refused

### Requirement: The bot says when it cannot reach the local Docker
With `SANDBOX_HOST=local`, the bot SHALL check in the background after boot that the Docker CLI reaches the daemon, retrying for up to 60 seconds. When it still fails, it SHALL log one error naming the socket and the fix. The boot SHALL NOT wait for the check, and the check SHALL send nothing to the error tracker.

#### Scenario: Wrong socket group
- **WHEN** the bot's process is not in the socket's group
- **THEN** the chat surface starts, and within about a minute the log has one error naming `/var/run/docker.sock` and `./coach-aven init`

#### Scenario: Docker starting late
- **WHEN** the Docker engine answers 30 seconds after the bot's boot
- **THEN** nothing is logged

#### Scenario: Remote sandbox host
- **WHEN** `SANDBOX_HOST` names an ssh target
- **THEN** no check runs and nothing new is logged

### Requirement: The documented path is measured
`docs/quickstart.md` SHALL list the steps from clone to first answer, each with its command, its measured time and what it needs from whom. It SHALL say where the measurement was taken and which platforms were run. It SHALL end with how to uninstall, the sandbox containers included. The README SHALL link to it from a "Try it" block.

#### Scenario: Reading the page
- **WHEN** a reader opens `docs/quickstart.md`
- **THEN** they see the total measured time, the date and machine of the measurement, and the accounts they need before they start

### Requirement: One script drives the trial
`quickstart/coach-aven` SHALL offer `init`, `setup-token`, `up`, `link`, `logs`, `down` and `uninstall`, from any working directory. `up` SHALL start the bot afresh and print the sign-in link of that start. `link` SHALL print the running bot's current link, never an earlier start's. `uninstall` SHALL stop the bot and remove the sandbox containers carrying the quickstart's label and the two images of its version.

#### Scenario: Restart after an edit
- **WHEN** the person edits `.env` and runs `./coach-aven up` while the bot runs
- **THEN** the bot starts again with the edit, and the script prints the new sign-in link

#### Scenario: Two starts in the log
- **WHEN** the bot's log holds the sign-in lines of an earlier start and of the current one
- **THEN** `./coach-aven link` prints the current one

#### Scenario: Uninstall
- **WHEN** the person runs `./coach-aven uninstall`
- **THEN** no container with the quickstart's label remains, the images of this version are gone unless another container uses them, and the person's files stay

### Requirement: The page says what to do next
`docs/quickstart.md` SHALL list, after the first answer, at least five things to ask or type in the project's room, and link the command list and the annotated project example. It SHALL describe adding Slack to the same installation, for which `quickstart/.env.example` SHALL carry `CHAT_SURFACES=slack` and the two Slack tokens as commented-out lines.

#### Scenario: After the first answer
- **WHEN** a reader reaches the end of the steps
- **THEN** they see a change request, a review, a schedule, the memory and the status to try, and how Slack joins the web chat
