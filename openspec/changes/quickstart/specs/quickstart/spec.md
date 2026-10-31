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
- run its sandboxes from the published plain sandbox image of the same version as the bot image, pulled by `coach-aven up`;
- run every project in it unprivileged and without docker-in-docker;
- take its GitHub access from a `GITHUB_TOKEN`, or run with none (`GITHUB_AUTH=none`).

It SHALL publish the web chat on the machine's loopback only.

#### Scenario: Fresh start
- **WHEN** a person on a machine with Docker runs `quickstart/coach-aven up`, pastes a Claude token and presses Enter at the two other questions
- **THEN** nothing is built on the machine, the project reads the demo repository with no GitHub access, and the script prints the sign-in link of that start

#### Scenario: First answer
- **WHEN** the person opens the link and posts a question in the project's room
- **THEN** a sandbox container is created from `ghcr.io/pedalix/coach-aven-sandbox-plain:<the bot's version>` without `--privileged`, the repository is cloned, and the answer lands in the thread

#### Scenario: Not on the LAN
- **WHEN** another machine on the same network opens port 8787 of the person's machine
- **THEN** the connection is refused

### Requirement: Up writes the machine's values
`coach-aven up` SHALL copy `.env.example` and `projects.config.example.json` only when their targets are missing, and SHALL write `compose/.env` on every run: the image version of the clone's commit (its tag, else `sha-<commit>`, never `latest`), the user's uid and gid, the Docker socket's group as a container sees it, and the web port. It SHALL pull an image only when it is missing. A compose command before it SHALL fail with a sentence naming `./coach-aven up`.

#### Scenario: Rerun after editing .env
- **WHEN** the person edits `.env` and reruns `quickstart/coach-aven up`
- **THEN** `.env` is untouched, `compose/.env` is written again, and the bot restarts with the edit

#### Scenario: A clone off a tag
- **WHEN** the clone's HEAD is a `main` commit with no tag
- **THEN** `compose/.env` names `sha-<commit>` and the script warns that it is a canary build

#### Scenario: Compose before up
- **WHEN** the person runs `docker compose up -d`, or `link`, `logs` or `down`, before `quickstart/coach-aven up`
- **THEN** it stops with a sentence naming `./coach-aven up`

### Requirement: Up asks only for what is missing
At a terminal, or with `QS_ASK=1`, `coach-aven up` SHALL ask only for what `.env` lacks: the Claude credit, the repository when the project configuration is new, and a GitHub token. Enter SHALL mean, in turn: get a subscription token now, the demo repository, and no GitHub access (`GITHUB_AUTH=none`). It SHALL write the answers into `.env` and never print a credential. Without a terminal, missing values SHALL stop it, named in one line.

#### Scenario: Enter twice
- **WHEN** the first run gets a Claude token, then Enter, then Enter
- **THEN** `.env` holds the token and `GITHUB_AUTH=none`, the project lists the demo repository, and neither output stream shows the token

#### Scenario: The person's repository and token
- **WHEN** the first run gets an API key, `acme/shop` and a GitHub token
- **THEN** `.env` holds `ANTHROPIC_API_KEY` and `GITHUB_TOKEN`, and the project lists `acme/shop`; a value that is not `owner/repo` is refused and asked again on the next run

#### Scenario: A later token
- **WHEN** the person puts a `GITHUB_TOKEN` into a `.env` that says `GITHUB_AUTH=none` and runs `up`
- **THEN** `GITHUB_AUTH` is emptied, because the bot refuses the two together

#### Scenario: No terminal
- **WHEN** `up` runs without a terminal and `.env` has no credit and no GitHub setting
- **THEN** it stops with one line naming both, and nothing starts

### Requirement: The bot says when it cannot reach the local Docker
With `SANDBOX_HOST=local`, the bot SHALL check in the background after boot that the Docker CLI reaches the daemon, retrying for up to 60 seconds. When it still fails, it SHALL log one error naming the socket and the fix. The boot SHALL NOT wait for the check, and the check SHALL send nothing to the error tracker.

#### Scenario: Wrong socket group
- **WHEN** the bot's process is not in the socket's group
- **THEN** the chat surface starts, and within about a minute the log has one error naming `/var/run/docker.sock` and `./coach-aven up`

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
`quickstart/coach-aven` SHALL offer `up`, `link`, `logs`, `down` and `uninstall`, from any working directory. `up` SHALL start the bot afresh and print the sign-in link of that start. `link` SHALL print the running bot's current link, never an earlier start's. `uninstall` SHALL stop the bot and remove the sandbox containers carrying the quickstart's label and the two images of its version.

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
