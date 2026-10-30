# ops-overlay Specification

## Purpose
Keeps an installation (project list, prompts, topology, operator notes) in its own repository, checked out at the runtime directory, so the public repo documents the mechanism and never carries an instance.

## Requirements

### Requirement: Runtime directory is an ops repository
Each installation SHALL be a git checkout of its own private ops repo at `infra/<slug>/` of the product checkout, with the installation's files at the checkout's root (`projects.config.json`, `projects.d/`, `deploy.env`, the two secret files). Every `deploy.sh` command SHALL take the slug as its first argument and act on that overlay only; `export` SHALL push the overlay and upload only the runtime files by scp; `export` and `import` SHALL refuse to run when the directory is not a git checkout and print the clone command.

#### Scenario: Export with unpushed config
- **WHEN** `infra/acme/projects.config.json` is edited and committed but not pushed and `deploy.sh acme export` runs
- **THEN** the `acme` overlay is pushed, its runtime files are uploaded to the host in `infra/acme/deploy.env`, and the script prints `restart` as the next step

#### Scenario: Export with uncommitted config
- **WHEN** the overlay has uncommitted changes and `export` runs
- **THEN** nothing is pushed or uploaded; the script lists the dirty files and exits non-zero

#### Scenario: Runtime dir is a plain folder
- **WHEN** `infra/<slug>/` exists without `.git`
- **THEN** `export`/`import` exit non-zero and name the clone command

#### Scenario: Two installations side by side
- **WHEN** `infra/acme/` and `infra/beta/` are both checked out and `deploy.sh beta deploy` runs
- **THEN** only the host named in `infra/beta/deploy.env` is touched

#### Scenario: Missing slug
- **WHEN** `deploy.sh deploy` runs without a slug, or with a slug whose directory does not exist
- **THEN** the script exits non-zero and lists the overlay directories present under `infra/`

### Requirement: Secrets never enter the ops repo
`.env`, the GitHub App key and Terraform state SHALL be ignored by the ops repo's `.gitignore`; the deploy target (`deploy.env`: host, users, remote dir, service name) is not a secret and SHALL be tracked in the overlay; the public guard SHALL also run against the overlay's tracked files in the operator's CI (advisory, not enforced by the public repo).

#### Scenario: Key placed in the overlay
- **WHEN** `github-app-private-key.pem` is written into `infra/<slug>/`
- **THEN** `git -C infra/<slug> status` does not list it

#### Scenario: Deploy from the overlay's workflow
- **WHEN** the overlay's deploy workflow runs for a release tag
- **THEN** it reads `deploy.env` from its own checkout and needs only the deployer SSH key as a secret

### Requirement: Template for a new installation
The public repo SHALL ship `infra/deploy/ops.example/` with a placeholder `projects.config.json`, one `projects.d/example.md`, a `deploy.env.example`, the deploy workflow and a `.gitignore`, and `infra/deploy/README.md` SHALL explain how to start an ops repo from it and clone it at `infra/<slug>/`.

#### Scenario: Starting a new installation
- **WHEN** an operator copies `infra/deploy/ops.example/` into a new private repository and clones it at `infra/acme/`
- **THEN** `npm run ops -- acme export` accepts it as the ops checkout, `deploy.sh acme install` runs against the host in `infra/acme/deploy.env` without any edit to the public tree, and the template contains no identifier of any installation

### Requirement: Overlay directories are ignored by allow-list
The public repo's `.gitignore` SHALL ignore every path under `infra/` except the public tooling directories it names (`infra/deploy/`, `infra/teams/`, `infra/README.md`), so no overlay checkout — whatever its slug — can be staged, and the ignore file itself names no installation.

#### Scenario: A new overlay is cloned
- **WHEN** a repo is cloned at `infra/acme/` and `git add -A` runs in the product checkout
- **THEN** nothing under `infra/acme/` is staged and `git status` does not list it

#### Scenario: Public tooling stays tracked
- **WHEN** a file is added under `infra/deploy/` or `infra/teams/`
- **THEN** it is staged like any other tracked path

### Requirement: The overlay names the chat driver the service runs
`deploy.env` SHALL name the installation's chat driver (`CHAT_DRIVER`, one of the build's drivers; absent = `slack`). `deploy.sh install` SHALL render that driver into the bot container's command, and the deploy health check SHALL wait for that driver's "bot running" line.

#### Scenario: Default stays Slack
- **WHEN** an overlay's `deploy.env` has no `CHAT_DRIVER`
- **THEN** the bot container runs `orch slack` and the health check waits for `Slack bot running`

#### Scenario: Teams installation
- **WHEN** `deploy.env` says `CHAT_DRIVER=teams` and `install` then `deploy` run
- **THEN** the bot container runs `orch teams` and the deploy reports healthy once `Teams bot running` appears in the bot's log

#### Scenario: Unknown driver
- **WHEN** `CHAT_DRIVER` names a driver the build does not have
- **THEN** `install` exits non-zero naming the drivers available

#### Scenario: Compose installation
- **WHEN** `deploy.env` says `CHAT_DRIVER=teams`, with or without a leftover `RUNTIME=compose`
- **THEN** the bot container runs `orch teams` and the deploy reports healthy once `Teams bot running` appears in the bot's log

### Requirement: The overlay has one runtime
The overlay SHALL name no runtime: the published image under Docker Compose (`container-deploy`) is the only one, and the `RUNTIME` key is retired. A leftover `RUNTIME=compose` SHALL be accepted. `RUNTIME=systemd` SHALL make every `deploy.sh` command exit non-zero with a sentence naming the last release whose tooling had that path (v0.43.0) and the move checklist. Any other value SHALL make every command exit non-zero, naming `compose`.

#### Scenario: No runtime named
- **WHEN** an overlay's `deploy.env` has no `RUNTIME`
- **THEN** `install` renders the compose file, and `deploy` takes a version and uploads nothing

#### Scenario: Compose
- **WHEN** `deploy.env` says `RUNTIME=compose`
- **THEN** every command behaves exactly as with no `RUNTIME`

#### Scenario: The retired runtime
- **WHEN** `deploy.env` says `RUNTIME=systemd`
- **THEN** every command exits non-zero, names v0.43.0 and points at the move checklist

#### Scenario: Unknown runtime
- **WHEN** `deploy.env` says `RUNTIME=docker`
- **THEN** every command exits non-zero and names `compose`

### Requirement: The overlay marks a canary installation
`deploy.env` SHALL mark a canary installation with `CANARY=1`. Only an installation marked this way SHALL accept a `main` commit's image, from `deploy.sh` and from the ops workflow alike.

#### Scenario: Canary
- **WHEN** `deploy.env` says `CANARY=1` and `deploy.sh <slug> deploy sha-<commit>` runs
- **THEN** that commit's image is deployed

#### Scenario: Release installation
- **WHEN** `deploy.env` has no `CANARY` and a `sha-<commit>` deploy is requested
- **THEN** the deploy is refused before anything changes on the box
