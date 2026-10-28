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
- The code on a box is an immutable artifact named by a version. The canary and prod run the same bytes.
- Nothing from an operator's machine can reach a box. This holds by construction, not through an exclude list.
- Moving an installation moves no data and can be undone until cleanup.
- The deployer's key keeps the privilege it has today: one narrow sudo rule.

**Non-Goals:**
- **Isolating the bot from its host.** The bot runs as the deployer with host networking, as the service did. Hardening is a later concern.
- **Zero-downtime deploys.** A deploy restarts the bot, as it does today. Socket Mode reconnects and queued turns replay from `queue.jsonl`.
- **Changing the systemd path.** It gains only `RUNTIME`, `CANARY` and the meaning of `AVEN_DIR`. A later change retires it.

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
| `~/.ssh` at its own path, read-only | the SSH transport with its keys and known hosts |
| `~/.config/coach-aven` at its own path, read-write | the pullers refresh source tokens there; the hub key |
| `/etc/passwd` and `/etc/group`, read-only; `HOME` set to the deployer's home | OpenSSH refuses to run as a uid without a passwd entry, and git reads the home directory from it |
| `user: <uid>:<gid>` of the deployer, read on the box at `install` | files keep today's owner |
| `network_mode: host` | the loopback listeners behind the host's proxy (Teams, web chat) and the daemon's address in the projects config keep their addresses |
| `init: true`, `stop_grace_period: 90s` | SIGTERM forwarding and reaping of the `ssh` and `sh` children the driver starts; 90 s is systemd's default stop timeout, which the units rely on, and lets the daemon finish a pass in flight |
| `restart: unless-stopped` | `Restart=always`. Docker has no equivalent of `StartLimitBurst`: a crash loop restarts with growing delays instead of failing the unit. Accepted. |

Alternatives:
- **A fixed image user with named volumes.** It needs a data migration and a `chown`, and every absolute path in the configuration would have to be rewritten.
- **Bridge networking with published ports.** Every loopback address in the configuration and in the proxy would change.

Both buy isolation, which is not this change's goal.

### D4. The Docker socket only when `SSHDOCKER_HOST=local`
At each deploy the deploy command reads the one key `SSHDOCKER_HOST` from the installation's `.env`, without printing it.
- With `local`, the rendered file mounts the socket and adds the socket's group (`group_add`). The sandboxes are siblings on the host's Docker, so the paths in a project's `sandbox.mounts` stay host paths that the host's daemon resolves, as today.
- With any other value, the bot container has no socket.

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
- **Default user:** unprivileged. Compose replaces it with the deployer's uid (D3).
- **Labels:** `org.opencontainers.image.source`, `.revision` and `.created`.

### D6. Built once per commit on native runners, promoted on the tag
- **Build.** A reusable workflow, `image.yml`, runs one job per architecture on a native runner (`ubuntu-24.04` and `ubuntu-24.04-arm`), each pushing its image by digest. A merge job then publishes the manifest list as `sha-<commit>`. Under QEMU, `npm ci` would run emulated for minutes, while native arm64 runners are free for public repositories.
- **Build cache.** Each architecture's job reads and writes a build cache in the registry, `buildcache-<arch>`. When the lockfile has not changed, the dependency layer is the very same layer as in the previous image, so a box that runs that image pulls only the code. The cache of GitHub Actions is not used: it drops entries unused for a week, and a dropped entry would put a new dependency layer on every box.
- **Callers:**
  - `ci.yml` calls `image.yml` on pushes to `main` after the verify job;
  - on a pull request that touches the image's inputs, `ci.yml` builds both architectures on their native runners without pushing; such a build reads the build cache and never writes it;
  - `release.yml` runs verify, then the promotion, then the GitHub Release, then the dispatch. The promotion is `docker buildx imagetools create -t vX.Y.Z <image>:sha-<commit>`, or a build when the image is missing.
- **Registry:** `ghcr.io/<owner>/coach-aven`, public. The workflow writes it with its own `GITHUB_TOKEN` (`packages: write`), and nothing else gets a credential. Boxes pull anonymously, so no box holds a registry token. An owner of the organization makes the package public once, in its settings. A fork publishes to its own namespace the same way.
- **Alternatives:**
  - Building on the tag: prod would run an image the canary never ran.
  - A single architecture: one installation is arm64.
  - Building only amd64 on pull requests: a dependency that breaks only on arm64 would surface after the merge and leave the arm64 installation without an image of `main`.
  - Docker Hub: a second account and a second secret.

### D7. The box's deploy command
- **What it is.** `/usr/local/sbin/<service>-deploy`, a root-owned bash script whose source is `infra/deploy/aven-deploy.sh`.
- **What `deploy.sh install` puts beside it:**
  - its configuration, `/etc/coach-aven/<service>/deploy.conf`, owned by root: the image repository, the installation directory, uid and gid, service name, chat driver, the sources daemon's listen address, the canary flag and the log driver;
  - a sudoers rule, `<deployer> ALL=(root) NOPASSWD: /usr/local/sbin/<service>-deploy`, checked with `visudo` like today's rule.
- **Subcommands:** `deploy <version>`, `start`, `stop`, `restart`, `status`, `logs [-f]`, `run <cli args…>`, `revert-to-systemd`, `cleanup [--yes]`.
- **`deploy`, step by step:**
  1. It checks the version's form: `v<major>.<minor>.<patch>`, or `sha-` with 40 hex digits when the canary flag is set.
  2. It pulls `<repository>:<version>`. A failed pull stops the deploy with nothing touched.
  3. It reads the digest.
  4. It renders the Compose file from the template inside that image (`/app/infra/deploy/compose.yaml`) and from `deploy.conf`, into `/etc/coach-aven/<service>/compose.yaml`. The difference against the previous file goes to the log.
  5. It runs `docker compose up -d`.
  6. It waits for the driver's line (D8) and records the result.
- **Where the files live.** The rendered file and its configuration stay outside the installation directory. The deployer owns that directory, and a Compose file the deployer could edit would make anyone holding its key root.
- **`run`** runs `docker compose run --rm bot <args>` with the bot's mounts and environment. The arguments reach the CLI as argv, never through a shell.
- **The template's format.** The template carries a format number. A command older than the template refuses it and says to rerun `install`.
- **Alternatives:**
  - The deployer in the `docker` group: one line, but the CI key becomes root on the box. Both boxes we operate already grant it; the template should not.
  - An agent on the box that pulls versions by itself: out of scope.

### D8. The health check and the automatic rollback
- **The wait.** The deploy waits up to 90 s for the driver's line in the bot container's log since the container started. The lines are the ones `deploy.sh` waits for today: `Slack bot running`, `Teams bot running` and `Web chat running`.
- **When the line does not come,** the deploy renders the previous version again, runs `up -d`, waits for that version's line, records `rolled-back` and exits 1. The previous version is the last record with outcome `ok`.
- **The first compose deploy** has no such record. There, the previous version is the systemd units: a failure stops the containers and starts the units again (D11).
- The systemd deploy keeps its warning until it retires.

### D9. Versions, the canary and the error tracker's release
- **The canary flag.** `CANARY=1` in `deploy.env` goes into `deploy.conf`. Only then is `sha-<commit>` accepted, by `deploy.sh` and by the ops workflow, which reads its own `deploy.env`.
- **The release.** The rendered file sets `SENTRY_RELEASE` to `vX.Y.Z`, or to `main@<first 7 characters>` for a commit image, the stamp the canary uses today. `resolveRelease()` already prefers `SENTRY_RELEASE`, so no code changes. `.release` stays for the systemd path.

### D10. Scheduled jobs
- **`orch mirror`.** It runs the function that `scripts/mirror.ts` runs today. Since the first PR that function reads `mirrors.json` and keeps the `mirrors/` cache in the installation directory (D1). `scripts/mirror.ts` stays as a thin caller until the systemd path retires, so an installation that has not moved keeps its crontab line.
- **The crontab line on a moved installation:** `sudo /usr/local/sbin/<service>-deploy run mirror >> <dir>/mirrors/mirror.log 2>&1`. The operator rewrites the line during the move, and `cleanup` refuses until that is done (D11).

### D11. Moving an installation, moving back, cleaning up
- **The first compose deploy** is the one with no `ok` record:
  1. it pulls the image and renders the file;
  2. it stops the systemd units, `<service>` and `<service>-sources-daemon` when present;
  3. it runs `up -d` and waits for the line;
  4. on success it disables the units;
  5. on failure it brings the containers down and starts the units again.
- **`revert-to-systemd`** brings the containers down, then enables and starts the units. After cleanup it refuses, because the code is gone: going back then takes `RUNTIME=systemd` and a tar deploy from a clean checkout, until that path retires.
- **`cleanup`** sorts the top level of the installation directory into three groups:
  - **Removed after `--yes`:** the top-level names in the running image's `/app`, plus `node_modules` and `.release`. That is everything a tar deploy can have put there, and the list follows the code by itself. The two old unit files go too.
  - **Kept:** configuration (`.env`, `github-app-private-key.pem`, `projects.config.json`, `projects.d/`, `mirrors.json`, `hub.peers.json`) and state (`state.json`, `queue.jsonl`, `usage/`, `drafts/`, `facts/`, `memory/`, `feedback/`, `events/`, `shadow/`, `data/`, `mirrors/` and the deploy record).
  - **Listed as unknown and kept:** anything else, such as an operator's backup.
- **When `cleanup` refuses:** while a unit is still enabled, or while a cron line names the directory together with `node`, `tsx` or `npm`. It looks for such lines in the deployer's crontab and in `/etc/cron*`.

### D12. `deploy.sh` and the ops workflow
- **`deploy.sh`:**
  - It reads `RUNTIME` (default `systemd`) and `CANARY` from `deploy.env`.
  - On a compose installation, `install` copies the deploy command and writes its configuration over the root SSH session, the way it installs the unit today.
  - On a compose installation, `deploy`, `start`, `stop`, `restart`, `status`, `logs`, `run`, `down` and `cleanup` run as `ssh deployer@host sudo /usr/local/sbin/<service>-deploy …`.
  - On a compose installation, `deploy` requires a version: there is no default, so the operator names what runs.
  - `export`, `import` and `ssh` do not change.
- **The ops workflow template:**
  - It reads `RUNTIME` and `CANARY` from its own `deploy.env`.
  - For compose it does not check out the product. It runs the deploy command over SSH with the version.
  - For systemd it does what it does today.
  - The `tag` input takes `vX.Y.Z` always, and `sha-<commit>` only with `CANARY=1`.

### D13. Docs and the ledger
- `infra/deploy/README.md`: the compose runtime becomes the recommended one, and the systemd section stays until it retires.
- The ops template: `deploy.env.example` gains `RUNTIME` and `CANARY`, and the workflow its compose path.
- `docs/runtime-config.md`: `AVEN_DIR`, and the crontab line in *Repo mirrors*.
- `docs/local-dev.md` and the self-host section of `README.md`.
- CLAUDE.md's release line: tag, then CI, then the image, then the GitHub Release, then the deploy.
- One row in `docs/rollout.md`.

## Risks / Trade-offs

- [Docker becomes a dependency of the bot's box] → `install` checks for Docker Engine and the Compose plugin and names what is missing. The boxes we operate have both.
- [Host networking, the passwd mount and the home mounts give the container the deployer's view of the box] → These are the privileges the service had. The socket comes only with local sandboxes, and isolation is a later change.
- [On boxes where the deployer is already in the `docker` group, its key stays root-equivalent] → The template does not need the group. Removing it after the move is an operator step, not enforced.
- [The registry is unavailable at deploy time] → The pull happens before anything stops. The running and the previous images stay on the box, so a rollback works offline.
- [arm64 runners are missing or slow to start] → That job falls back to QEMU: slow, but correct.
- [Node 22 becomes Node 24 on an installation still on 22] → CI tests 24, and the canary installation already runs 24. The switch happens at that installation's move, under watch.
- [Every deploy adds an image to the disk] → The deploy command keeps the running version and the two before it, and prunes the repository's other images.
- [An image for every `main` commit clutters the registry] → A scheduled workflow deletes `sha-*` images older than 90 days that no release names.
- [Docker Desktop has no journald logging] → `deploy.conf` names the log driver; it is `json-file` with rotation where journald is missing.
- [The template in a new image is newer than the deploy command on the box] → The command refuses it and says to rerun `install` (D7).
- [A crash loop restarts forever] → Restart delays grow, the journal shows the loop, and `status` reports the restart count.
- [A vulnerability in the base image] → The base is pinned by digest, and Dependabot covers the image's build file.

## Migration Plan

1. **PR 1, the installation directory (bucket 2).** `AVEN_DIR`, `src/paths.ts`, the guard test and the boot line. Home and staging run it with `AVEN_DIR` unset; prod gets it with the next tag.
2. **PR 2, the image.** The image's build file, `image.yml`, the jobs in `ci.yml` and `release.yml`, and `orch mirror`. Images appear for every `main` commit; no box changes.
3. **PR 3, the compose runtime.** `compose.yaml`, `aven-deploy.sh`, `deploy.sh` (`RUNTIME`, `CANARY` and the new commands), the ops workflow template, the docs and the ledger row.
4. **The canary installation**, following the operator's plan in their ops repository:
   - set `CANARY=1` and `RUNTIME=compose`, run `install`, then deploy `sha-<the commit it runs now>`;
   - watch it for two days;
   - run `cleanup` once no cron line runs the old code.
5. **Prod, after the canary period, with the next release tag:**
   - set `RUNTIME=compose`, run `install`, rewrite the mirror's crontab line, deploy `vX.Y.Z`;
   - run `cleanup` after one release without trouble.
6. **Retirement.** The template's default becomes `compose`. A later change retires the systemd path: the tar deploy, the unit templates and `.release`. The ledger row then moves to *Retired*.

**Rollback:**
- Before cleanup, `revert-to-systemd` is one command.
- After cleanup, set `RUNTIME=systemd` and run `deploy.sh deploy` from a clean checkout, while the tar path still exists.

## Open Questions

- **Retention on the box.** How many old images a box keeps. The starting value is the two previous versions. The registry keeps `sha-*` images for 90 days unless a release names them.
- **Serve units.** Whether `orch sources serve` units, installed by hand today, become Compose services once an installation needs one.
- **The home bot.** Whether it moves to the image. It runs from a development checkout, so its operator decides.
