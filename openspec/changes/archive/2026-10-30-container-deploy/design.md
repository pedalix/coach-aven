# Design

## Context

The motivation is in proposal.md, *Why*. What shapes the approach:

- **The service today.** `infra/deploy/README.md` describes it:
  - One systemd unit runs `node --import tsx src/cli.ts <driver>` as the deployer, with `WorkingDirectory` set to the installation's directory.
  - Some boxes run a second unit, the sources daemon, from the same code.
  - The README argues for systemd over Docker: a tiny control plane, SIGTERM reaching Node directly, no ports.
- **Paths located through the code.** Twelve runtime paths are built with `new URL('../…', import.meta.url)`:
  - `state.json` (`src/state.ts`) and `queue.jsonl` (`src/queuejournal.ts`);
  - `usage/`, `drafts/`, `facts/`, `feedback/`, `memory/` and `events/`, from the modules of the same names (`src/metering.ts`, `src/drafts.ts`, `src/facts.ts`, `src/feedback.ts`, `src/memjournal.ts`, `src/eventlog.ts`);
  - `shadow/` (`src/messaging/runtime.ts`);
  - `data/` (`src/sources/paths.ts`, which `AVEN_DATA_DIR` overrides);
  - the projects config default (`src/config.ts`, which `PROJECTS_CONFIG_PATH` overrides);
  - `.release` (`src/config.ts`).
- **Paths resolved against the working directory:**
  - `.env` (dotenv);
  - `mirrors.json` (unless `MIRRORS_CONFIG` is set) and the mirror job's `mirrors/` cache (`scripts/mirror.ts`);
  - the relative value of any path setting: `PROJECTS_CONFIG_PATH`, `AVEN_DATA_DIR`, `MIRRORS_CONFIG`, `GITHUB_APP_PRIVATE_KEY_PATH`, `HUB_KEY_PATH`.

  Every unit sets `WorkingDirectory` to the package root, at home and in the box templates, and `npm run` starts there too. So today the two anchors always agree.
- **The deployer's home.** The SSH transport runs the system `ssh` with the deployer's keys and known hosts (`src/sshdocker.ts`, `transportArgv`). Source tokens and, by convention, the hub key live under `~/.config/coach-aven`.
- **Programs the code starts on the host:**
  - `ssh`, for a remote sandbox host;
  - `sh -c "docker …"` when `SSHDOCKER_HOST=local`;
  - `git`, for the local-activity source;
  - `age`, for the sources vault;
  - `gitleaks`, for `orch sources audit`.
- **The two server installations we operate, as of 2026-10-26:**
  - Both have Docker Engine with the Compose plugin, and on both the deployer is already in the `docker` group.
  - One is arm64, runs Node 24 and runs its sandboxes on its own Docker (`local`).
  - The other is amd64 and runs Node 22. It reaches a remote Docker host over SSH, runs a sources daemon unit, and has a crontab job that runs `scripts/mirror.ts` every 30 minutes from the code directory.
  - CI tests on Node 24.
- **The ops workflow.** It checks out the product at a tag and runs `deploy.sh <slug> deploy`. `release.yml` verifies the tag, publishes the GitHub Release and optionally dispatches.
- **The health check.** It only warns when the driver's line does not come (`infra/deploy/deploy.sh`, end of `cmd_deploy`), so a failed deploy still ends green.

## Goals / Non-Goals

**Goals:**
- **Standard deploys.** Every installation runs the same artifact the same way, and a deploy is one command that names a version. Nothing from an operator's machine reaches a box, and nothing is built on a box.
- **Predictable rollouts.** The canary and prod run the same bytes, and a deploy that does not come up fails loudly.
- **Clear rollbacks.** A rollback is the same command with the earlier version, and that version's image is still on the box.
- **A quickstart later.** The image is the basis of an installation someone outside starts with `docker compose up`: whatever is specific to an operated box, the deployer's user, the same-path mounts and the host network, lives in the compose file and never in the image.
- **Simplicity.** The box runs plain `docker compose` in the installation directory. Everything on it is a file an operator can read in a minute: the compose file, a two-line version pin and a log of deploys.

**Non-Goals:**
- **Isolating the bot from its host.** The bot runs as the deployer with host networking, as the service did. Hardening is a later concern.
- **Least privilege for the deployer.** The deployer is in the `docker` group, as it is on both boxes we operate, and so is the CI key that logs in as it. A root-owned wrapper behind a sudo rule would be a later hardening; this change adds no machinery for it.
- **Automatic rollback.** A failed deploy is red, and the operator or the workflow deploys the earlier version.
- **Zero-downtime deploys.** A deploy restarts the bot, as it does today. Socket Mode reconnects and queued turns replay from `queue.jsonl`.
- **Changing the systemd path.** It gains only `RUNTIME`, `CANARY` and the meaning of `AVEN_DIR`. A later change retires it.
- **The quickstart itself.** Web chat and sandboxes on the local Docker from one `docker compose up`, without Slack, is a change of its own after this one. This change only keeps the image free of anything that belongs to a box.

## Decisions

### D1. One directory for the installation: `AVEN_DIR`

- **`src/paths.ts`, pure:** `installDir(env, packageRoot)` returns an absolute directory.
  - Unset or empty gives the package root; a relative value throws.
  - Each runtime path is resolved on first use, never at import time, so the order in which modules are evaluated cannot matter.
- **The eleven state and config anchors** listed in *Context* go through it. `.release` and the bot's assets (fixtures, static files, the sources worker, `snapshot/plain/sources-mcp.mjs`) stay relative to the code: they describe the code, not the installation.
- **The working directory stops mattering.** What *Context* lists as resolved against the working directory is resolved against the installation directory instead:
  - `.env` is loaded from it (`loadDotenv({ path })`);
  - `mirrors.json`, unless `MIRRORS_CONFIG` is set, and the `mirrors/` cache live in it;
  - a relative value of a path setting resolves against it, through one helper in `src/paths.ts`;
  - a path given on a command line keeps resolving against the shell's directory, as with any command-line tool.

  Every launcher starts in the package root today, so with `AVEN_DIR` unset nothing moves. Only a process started elsewhere without the setting changes: it now reads the package root's `.env` instead of its working directory's.
- **`AVEN_DIR` comes from the process environment only.** It says where `.env` is, so `.env` cannot say it. `src/config.ts` resolves the directory first and then loads `.env` from it. When the file sets `AVEN_DIR`, the boot stops with one sentence saying that the setting belongs in the service's environment.
- **Boot log.** One boot line names the directory.
- **A guard test**, in the manner of `src/chat/imports.test.ts`, scans `src/` (tests aside). It fails on `new URL('../…', import.meta.url)` whose target is not on the list of code assets, and on `process.cwd()` outside the CLI probe's type-check helper (`src/cliprobe/typecheck.ts`).
- **Alternatives:**
  - The working directory as the installation directory, with no new setting. A tool started from another directory would then read and write another state, silently.
  - `AVEN_DIR` for what the bot writes, with `.env` and the rest of the configuration still found through the working directory. That is correct only while every launcher sets the working directory to the installation directory: the same silent mismatch, for configuration.
  - Separate directories for state and for configuration: two knobs where nobody needs two.
  - One setting per file: eleven knobs.
- **Name.** `AVEN_DIR` sits beside `AVEN_DATA_DIR`, which narrows `data/` inside it, and `AVEN_TZ`. `AVEN_HOME` would read like the location of the code, as `JAVA_HOME` does.

### D2. An image and Compose, not a release bundle on systemd

Alternatives considered:
- **(a) Patch the tar deploy:** upload tracked files only and delete what dropped out of the previous upload. That fixes the two visible symptoms. The build on the box remains, so do the runtime drift per box and the canary running another artifact than prod.
- **(b) A git checkout on the box:** `git checkout <tag>`, then `npm ci`. Git deletes the removed files, but the build still runs on the box, and the state still lives in a checkout.
- **(c) A release bundle built in CI:** code plus `node_modules`, unpacked into `releases/<version>/` behind a `current` symlink, with the systemd unit kept. It is immutable and atomic without Docker. But:
  - the box's Node, git, OpenSSH, age and gitleaks still drift;
  - `node_modules` built in CI must match each box's architecture and libc, because sharp and esbuild ship binaries per platform;
  - an installer at a client expects a container.
- **(d) Kubernetes or ECS:** an orchestrator for one process per box.

Chosen: an image per commit, run with Compose.
- The boxes we operate already run Docker Engine and Compose.
- The image carries Node and the tools, built once per architecture.
- Compose gives restarts, logs and a declarative file.
- The README's case for systemd still holds and is kept:
  - `init: true` forwards SIGTERM and reaps child processes;
  - host networking adds no port.

### D3. The containers see the box the way the service did

| Setting | Why |
|---|---|
| Installation directory mounted at its own path, read-write, as `AVEN_DIR` and `working_dir` | `.env`, the projects config, the mirror list, relative key paths, state and data resolve through `AVEN_DIR` (D1) to the files they use today, so no data moves; as `working_dir` it also anchors a relative argument given to `run` |
| `~/.ssh` at its own path, read-only, when the sandboxes are on another host (D4) | the SSH transport with its keys and known hosts; with sandboxes on the box's own Docker nothing in the container uses them |
| `~/.config/coach-aven` at its own path, read-write | the pullers refresh source tokens there; the hub key. `install` creates it for the deployer (mode 0700) when it is missing: Docker creates a missing mount source as root, and the bot could not write there |
| `~/.netrc` and `~/.claude/.credentials.json` at their own paths, read-only, each only when the file exists on the box | the code falls back to them for tracker tokens and the Claude token when the settings are absent; a bind mount of a missing file would put a directory in its place, so the deploy command checks at each render |
| `/etc/passwd` and `/etc/group`, read-only; `HOME` set to the deployer's home | OpenSSH refuses to run as a uid without a passwd entry, and git reads the home directory from it |
| `user: <uid>:<gid>` of the deployer, read on the box at `install` | files keep today's owner |
| `network_mode: host` | the loopback listeners behind the host's proxy (Teams, web chat) and the daemon's address in the projects config keep their addresses |
| `init: true`, `stop_grace_period: 90s` | SIGTERM forwarding and reaping of the `ssh` and `sh` children the driver starts; 90 s is systemd's default stop timeout, which the units rely on, and lets the daemon finish a pass in flight |
| `restart: unless-stopped` | `Restart=always`. Docker has no equivalent of `StartLimitBurst`: a crash loop restarts with growing delays instead of failing the unit. Accepted. |
| `name: <service>` | the compose project is the service name, so the containers are `<service>-bot-1` and `<service>-sources-daemon-1` wherever the rendered file lives, and `down` never touches another project on the box |

Everything the bot touches outside the installation directory is under `HOME`: the keys, `.config/coach-aven`, and the fallbacks the code keeps for a developer's machine (`~/.netrc`, `~/.claude/.credentials.json`). An installation that sets `HOME` inside the installation directory therefore needs one mounted directory, and a quickstart will do that. This change's compose file keeps the deployer's home, so the box's files stay where they are.

Alternatives:
- **A fixed image user with named volumes.** It needs a data migration and a `chown`, and every absolute path in the configuration would have to be rewritten.
- **Bridge networking with published ports.** Every loopback address in the configuration and in the proxy would change.

Both buy isolation, which is not this change's goal.

### D4. Where the sandboxes run decides the socket and the keys
The bot reaches its sandboxes in one of two ways, and the installation's `.env` names which. Both are supported placements, not one rule and one exception:
- **On the box's own Docker** (`SSHDOCKER_HOST=local`): the rendered file mounts the Docker socket and adds the socket's group (`group_add`). The sandboxes are the bot's siblings on the host's Docker, so the paths in a project's `sandbox.mounts` stay host paths that the host's daemon resolves, as today. No SSH key is mounted: the sandbox transport is the bot's only SSH client. One installation runs this way today, and a quickstart will stand on it, with the socket as the only thing it needs from the host.
- **On another host** (`SSHDOCKER_HOST=<ssh target>`): the deployer's `.ssh` is mounted read-only for the transport, and the bot container gets no Docker socket.

At each deploy the deploy command reads the one key `SSHDOCKER_HOST` from the installation's `.env`, without printing it, and renders accordingly. The socket is root on the box for whoever holds it; the deployer holds it through the `docker` group today, so the bot gains nothing it does not have.

### D5. The image
- **Base:** the official Node 24 image on Debian slim, pinned by digest, with Dependabot bumping it. Debian rather than Alpine: sharp and esbuild publish glibc binaries per platform, and `npm ci` picks the right ones at build time.
- **Tools:**
  - git, the OpenSSH client and age come from Debian;
  - the Docker CLI is copied from the official `docker:<version>-cli` image, and gitleaks from its official image;
  - nothing is installed with `curl | sh`.
- **Code:**
  - The build context is `git archive <commit>`, so even a local build sees tracked files only.
  - `npm ci` keeps the dev dependencies, because tsx is the runtime loader on the boxes today.
  - Everything sits in `/app`.
  - `package.json` and the lockfile are copied, and `npm ci` runs, before the rest of the tree is copied. The dependency layer then depends only on the base image and those two files.
- **Entry point:** `node --import <absolute path of tsx's loader> /app/src/cli.ts`, in exec form. `--import tsx` would resolve against the working directory, which is the installation directory here, and fail.
- **Default user:** unprivileged, so a bare `docker run` is not root. Compose replaces it with the deployer's uid (D3).
- **No installation inside.** The image fixes no user, path, address or key of a box: those are the compose file's (D3, D4). It runs as whatever uid the runtime gives it, with or without a user record in its `/etc/passwd`; only the SSH transport needs one, and D3 mounts the box's `passwd` for it. Everything it keeps lives under the installation directory and `HOME`. So one mounted directory, `AVEN_DIR` with `HOME` inside it, plus the Docker socket is a complete installation with local sandboxes, which is the shape a quickstart will mount.
- **Labels:** `org.opencontainers.image.source`, `.revision` and `.created`.

### D6. Built once per commit on native runners, promoted on the tag
- **Build.** A reusable workflow, `image.yml`, runs one job per architecture on a native runner (`ubuntu-24.04` and `ubuntu-24.04-arm`), each pushing its image by digest. A merge job then publishes the manifest list as `sha-<commit>`. Under QEMU, `npm ci` would run emulated for minutes, while native arm64 runners are free for public repositories.
- **Build cache.** Each architecture's job reads and writes a build cache in the registry, `buildcache-<arch>`. When the lockfile has not changed, the dependency layer is the very same layer as in the previous image, so a box that runs that image pulls only the code. The cache of GitHub Actions is not used: it drops entries unused for a week, and a dropped entry would put a new dependency layer on every box.
- **Callers:**
  - `ci.yml` calls `image.yml` on pushes to `main` after the verify job;
  - on a pull request that touches the image's inputs, `ci.yml` builds both architectures on their native runners without pushing; such a build reads the build cache and never writes it;
  - `release.yml` runs verify, then the promotion, then the GitHub Release, then the dispatch. The promotion is `docker buildx imagetools create -t vX.Y.Z <image>:sha-<commit>`, with `-t latest` as well when the tag is the highest version among the repository's `v*` tags (`sort -V`), or a build when the image is missing.
- **Tags.** Three names for three readers: `sha-<commit>` for the canary and the promotion, `vX.Y.Z` for a release installation, and `latest` for someone outside who wants the current release. A patch of an older line gets its `vX.Y.Z` and leaves `latest` alone.
- **Registry:** `ghcr.io/<owner>/coach-aven`, public. The workflow writes it with its own `GITHUB_TOKEN` (`packages: write`), and nothing else gets a credential. Boxes pull anonymously, so no box holds a registry token. An owner of the organization makes the package public once, in its settings. A fork publishes to its own namespace the same way.
- **Alternatives:**
  - Building on the tag: prod would run an image the canary never ran.
  - A single architecture: one installation is arm64.
  - Building only amd64 on pull requests: a dependency that breaks only on arm64 would surface after the merge and leave the arm64 installation without an image of `main`.
  - Docker Hub: a second account and a second secret.

### D7. Deploying is `docker compose` in the installation directory
- **The compose directory.** `<installation directory>/compose/` holds the rendered `compose.yaml` and a two-line `.env`: `AVEN_VERSION=<version>` and `AVEN_RELEASE=<release>`. Compose reads that `.env` for `${AVEN_VERSION}` in the image name and `${AVEN_RELEASE}` for `SENTRY_RELEASE`, and nothing else reads it. The bot's own `.env` stays one level up, read by the bot (D1). The project is named after the service (D3), so the directory's name never matters.
- **`install`** on a compose installation: the root stage creates the installation directory as today, checks for Docker Engine with the Compose plugin and names what is missing, and creates the deployer's `~/.config/coach-aven` (D3). Then the compose file is rendered from `infra/deploy/compose.yaml` the way the unit is rendered today, with the overlay's values: the image repository, the directory, the service name, the chat driver, the daemon's listen address when `deploy.env` names one, the uid and gid read on the box, and `SSHDOCKER_HOST` from the overlay's own copy of `.env` (D4), never printed. Rerun after a template change, as for the unit. No sudo rule: compose needs none.
- **`deploy <version>`**, over the deployer's SSH session:
  1. refuse a version that is not `vX.Y.Z`, or `sha-` with 40 hex digits on a canary; `latest` included, because what runs must be nameable;
  2. refuse while the installation's systemd unit is active, since the two would share the ports;
  3. `docker pull <repository>:<version>`; a failed pull changes nothing;
  4. write the two lines;
  5. `docker compose up -d`;
  6. wait up to 90 s for the driver's line (`Slack bot running`, `Teams bot running` or `Web chat running`) in `docker compose logs bot` since the start;
  7. append `<time> <version> ok` or `failed` to `<installation directory>/deploys.log`.

  On failure it prints the last lines of the log and exits 1. The containers stay as they are, and the operator deploys another version. Today's health check only warns; this one fails.
- **Rollback.** `deploy <earlier version>`. The image is still on the box, so it works with the registry down. `deploys.log` and `docker image ls` name the candidates.
- **The other commands.** `status`: the pin and `docker compose ps`. `logs [-f]`: `docker compose logs`. `restart`: `docker compose up -d --force-recreate` followed by the same wait, so an edited `.env` or a re-rendered compose file takes effect. `down`: `docker compose down`; the images and the files stay. `export`, `import` and `ssh` do not change. On a compose installation `deploy` requires a version: there is no default, so the operator names what runs.
- **Privileges.** The deployer runs `docker compose` itself, so it is in the `docker` group, which is root on the box. That is today's position on both boxes we operate, for the same key. The README names the group as the prerequisite and says what it amounts to.
- **Scheduled jobs.** `scripts/mirror.ts` becomes `orch mirror`: the function moves, and the script stays a thin caller for the systemd path. The crontab line on a moved installation: `cd <installation directory>/compose && docker compose run --rm --no-deps bot mirror >> <installation directory>/mirrors/mirror.log 2>&1`. Each run uses the pinned version.
- **The ops workflow** keeps its shape: it checks out the product at the version and the overlay beside it, and runs `deploy.sh <slug> deploy <version>`. It accepts `sha-<commit>` only when its own `deploy.env` says `CANARY=1`. On a systemd installation it does what it does today.
- **Alternatives:**
  - A root-owned deploy command behind a sudo rule, with its configuration and the rendered file under `/etc`, a deploy record, automatic rollback and `revert` and `cleanup` subcommands. That was the first draft: an orchestrator in bash for a two-installation setup, protecting a privilege the deployer already holds. Deferred to a hardening change, if one is ever wanted.
  - Pinning the version by editing the image line of the compose file: two services, two lines. Compose's own `.env` interpolation does it in one place.
  - Keeping the pin in the bot's `.env`: deploy state in the secrets file, which `import` would carry into the overlay.

### D8. Moving an installation is a checklist, and the way back stays open until the old code goes
1. While `RUNTIME` is still `systemd`: `deploy.sh <slug> down` stops and disables the bot's unit. The daemon's unit, installed by hand, is stopped and disabled the same way.
2. `RUNTIME=compose`, and `CANARY=1` on the canary, in `deploy.env`. Then `install`, then `deploy <version>` with the version the box ran: the commit's `sha-` image on the canary, the release tag on prod.
3. The crontab line is rewritten (D7).
4. When the operator is happy, the old code is removed from the directory. The README gives the list: the product's top-level tracked names, `node_modules` and `.release`. None of them is an installation file (checked: no name collides), and configuration and state are never on the list.

- **Back before step 4:** `deploy.sh <slug> down` removes the containers; `systemctl enable --now` as root starts the unit on the code still in the directory, with the same state. After step 4: `RUNTIME=systemd` and a tar deploy from a clean checkout, while that path exists.
- **The old sudoers rule**, the three `systemctl` verbs, stays until step 4. It is harmless, and the way back uses it.
- **Alternative:** the first draft had the first compose deploy stop the units by itself, a `revert-to-systemd` command and a `cleanup` command with refusal rules. Three one-off operations per installation, done twice; a checklist in the ops plan is enough.

### D9. Docs and the ledger
- `infra/deploy/README.md`: the compose runtime becomes the recommended one: prerequisites (Docker Engine with Compose, the deployer in the `docker` group and what that means), install, export, deploy with a version, rollback, `status`, `logs`, `restart` and `down`, the move checklist, the cleanup list and the crontab line. "Why systemd and not Docker" is replaced, and the systemd section stays as legacy until it retires.
- The ops template: `deploy.env.example` gains `RUNTIME`, `CANARY` and the daemon's listen address; its `.gitignore` ignores `compose/` and `deploys.log`; the workflow passes the version.
- `docs/runtime-config.md`: `AVEN_DIR`, and the crontab line in *Repo mirrors*.
- `docs/local-dev.md` and the self-host section of `README.md`.
- CLAUDE.md's release line: tag, then CI, then the image, then the GitHub Release, then the deploy.
- One row in `docs/rollout.md`.

## Risks / Trade-offs

- [Docker becomes a dependency of the bot's box] → `install` checks for Docker Engine and the Compose plugin and names what is missing. The boxes we operate have both.
- [Host networking, the passwd mount and the home mounts give the container the deployer's view of the box] → These are the privileges the service had. The socket comes only with local sandboxes, and isolation is a later change.
- [The deployer's key is root-equivalent through the `docker` group] → It is today, on both boxes. A later hardening can put a wrapper and a sudo rule in front of the same compose directory without changing anything else.
- [The registry is unavailable at deploy time] → The pull happens before anything stops. The earlier image stays on the box, so a rollback works offline.
- [A failed deploy leaves the failed version running] → The exit is non-zero, the workflow run is red, the log names the version, and the rollback is one command.
- [arm64 runners are missing or slow to start] → That job falls back to QEMU: slow, but correct.
- [Node 22 becomes Node 24 on an installation still on 22] → CI tests 24, and the canary installation already runs 24. The switch happens at that installation's move, under watch.
- [Every deploy adds an image to the disk] → Only the code layer differs between versions. `docker image prune -a` is documented; a pruned earlier version pulls again on rollback.
- [An image for every `main` commit clutters the registry] → Accepted. A retention job is a separate change if it is ever needed.
- [Docker Desktop has no journald logging] → The README says which line of the rendered file to change there.
- [A crash loop restarts forever] → Restart delays grow, the journal shows the loop, and `docker compose ps` shows the restarts.
- [A vulnerability in the base image] → The base is pinned by digest, and Dependabot covers the image's build file.

## Migration Plan

1. **PR 1, the installation directory (bucket 2).** `AVEN_DIR`, `src/paths.ts`, the guard test and the boot line. Home and staging run it with `AVEN_DIR` unset; prod gets it with the next tag.
2. **PR 2, the image.** The image's build file, `image.yml`, the jobs in `ci.yml` and `release.yml`, and `orch mirror`. Images appear for every `main` commit; no box changes.
3. **PR 3, the compose runtime.** `compose.yaml`, `deploy.sh` (`RUNTIME`, `CANARY`, the compose commands), the ops workflow template, the docs and the ledger row.
4. **The canary installation**, following the operator's plan in their ops repository: the checklist of D8 with the `sha-` image of the commit it runs, two days of watching, then the old code removed.
5. **Prod, after the canary period, with the next release tag:** the checklist of D8 with `vX.Y.Z`; the old code removed after one release without trouble.
6. **Retirement.** The template's default becomes `compose`. A later change retires the systemd path: the tar deploy, the unit templates and `.release`. The ledger row then moves to *Retired*.

**Rollback:** before the old code is removed, D8's way back; after, `RUNTIME=systemd` and a tar deploy from a clean checkout, while the tar path still exists.

## Open Questions

- **Serve units.** Whether `orch sources serve` units, installed by hand today, become Compose services once an installation needs one.
- **The home bot.** Whether it moves to the image. It runs from a development checkout, so its operator decides.
- **Hardening.** Whether the deployer ever leaves the `docker` group, behind a wrapper with a sudo rule. Not needed for the goals; a later change if an installation asks for it.
