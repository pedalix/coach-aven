# Proposal

## Why

An installation is deployed by `deploy.sh <slug> deploy`, which works in three steps:
1. It packs the operator's working tree with `tar`, minus an exclude list.
2. It unpacks the tree over the directory on the box where the bot also keeps its configuration and state.
3. It runs `npm ci` there.

The bot computes its state paths from the location of its own code: `new URL('../state.json', import.meta.url)` and ten others. So the code cannot be replaced as a unit, only poured over its predecessor, and every weakness of the deploy follows from that:
- **Nothing is ever deleted.** On 2026-10-26 one box held 74 files that are no longer in the repository and another held 77. They included the code of two retired features, archived OpenSpec changes and an old template carrying a retired provider's settings.
- **Whatever is untracked and not excluded goes up.** Private notes and 322 MB of another package's `node_modules` reached a box from a laptop checkout.
- **Every deploy builds on the box.** `npm ci` downloads from the registry for minutes while the old process runs on the new files.
- **The canary does not run what prod will run.** The canary runs a laptop's tree. A rollback unpacks an older tree over a newer one, so the newer files stay.
- **The runtime differs per box.** Node 22 runs on one box; Node 24 runs on another and in CI.

Two installations deploy this way today and more are coming, each with the same weaknesses. The goal is simple: a standard deploy, a predictable rollout, a clear rollback, and an image a quickstart can build on later.

## What Changes

- **The installation lives in one directory, apart from the code.** A new process setting, `AVEN_DIR`, names the installation directory:
  - everything the bot writes lives under it: `state.json`, `queue.jsonl`, `usage/`, `drafts/`, `facts/`, `memory/`, `feedback/`, `events/`, `shadow/`, `data/` and the mirror job's `mirrors/`;
  - the configuration is read from it: `.env`, `projects.config.json` when `PROJECTS_CONFIG_PATH` is unset, and `mirrors.json`. A relative path in a setting resolves against it, so the working directory no longer matters;
  - it comes from the process environment, because it says where `.env` is;
  - its configuration files keep the names an ops overlay uses, so an overlay is an installation directory and the other way round, without a rename;
  - unset, it is the package root, which is today's layout.
- **One image per commit, built once.**
  - CI builds an image of every `main` commit from a clean checkout, for amd64 and arm64. The image holds tracked files only, with `npm ci` run at build time, and nothing of any box: it runs under any uid, and one directory mounted as `AVEN_DIR` with `HOME` inside it is a complete installation.
  - The image is published to the GitHub container registry as `sha-<commit>`.
  - A release tag promotes the image of its commit to `vX.Y.Z`, so prod gets the same digest the canary ran, and `latest` follows the newest release for anyone outside. The promotion happens before the GitHub Release and the ops dispatch.
- **An installation runs the image with Docker Compose, in its own directory.**
  - `RUNTIME=compose` in the overlay's `deploy.env` selects it. Absent, the installation keeps today's systemd unit.
  - `install` renders the compose file into `compose/` under the installation directory. The bot runs from one image version, and so does the sources daemon where the installation runs one.
  - The installation directory is mounted at its own path, with host networking and the journal for logs. So `.env`, the projects config, the state and every path a setting names stay where they are.
  - Where the sandboxes run decides the rest: on the box's own Docker the bot gets the Docker socket, on another host the deployer's SSH keys. Both placements are supported, and the first is what a later quickstart builds on.
- **Deploying means pinning a version.**
  - `deploy.sh <slug> deploy <version>` and the ops workflow pull a published version on the box, write it to a two-line file the compose file reads, and run `docker compose up -d`. Nothing is uploaded and nothing is built on the box.
  - Only an installation marked `CANARY=1` accepts a `main` commit's image; every other installation runs release tags only.
  - The deploy waits for the chat driver's "running" line and fails when it does not come. Each deploy appends a line to `deploys.log`.
  - A rollback is a deploy of the earlier version, whose image is still on the box.
- **The deployer runs compose itself.** It is in the `docker` group, as it is on the boxes we operate today. No new privilege and no new machinery; hardening is a later change.
- **Scheduled jobs run from the image too.** `scripts/mirror.ts`, which one installation's crontab runs every 30 minutes from the code directory, becomes `orch mirror`. A job on the box runs it with `docker compose run` in the compose directory.
- **The migration is a checklist.** Stop and disable the units, set the runtime, install, deploy the version the box ran, rewrite the scheduled job, and remove the old code last with a documented command. Until that last step, moving back is `down` plus enabling the unit. The tar deploy keeps working for installations that have not moved yet, and a later change retires it once the last one has moved.
- **Docs follow.**
  - `infra/deploy/README.md` replaces "Why systemd and not Docker" with the compose runtime, the checklist and the cleanup command.
  - The ops template, `docs/runtime-config.md`, `docs/local-dev.md`, `README.md` and CLAUDE.md's release line are updated.
  - The rollout ledger gets a row for this change.

## Capabilities

### New Capabilities
- `installation-directory`: where an installation's configuration and state live, independent of where the code is and of where the process starts. It covers the default, the overlay's layout, and the rule that no runtime file is located through the code's own path or the working directory.
- `bot-image`: the published image of the bot: what is in it, what of a box must not be in it, how it is built for every `main` commit, how it is tagged (`sha-<commit>`, `vX.Y.Z`, `latest`), and how a release promotes it. The image of the sandboxes stays `sandbox-image`.
- `container-deploy`:
  - how an installation runs the image;
  - how a version is deployed, checked and rolled back;
  - how scheduled jobs run;
  - how an installation moves off its systemd unit, and back.

### Modified Capabilities
- `release-deploy-split`:
  - a release publishes the promoted image before the GitHub Release and the dispatch;
  - the ops workflow deploys an image version to a compose installation through `deploy.sh`, uploading nothing;
  - an installation marked as a canary may deploy a `main` commit's image.
- `ops-overlay`: `deploy.env` names the runtime (`RUNTIME`) and marks a canary installation (`CANARY`). For a compose installation the chat driver is the bot container's command, and the health check reads the container's log.

## Impact

- **Rollout:**
  - The installation directory is bucket 2. With `AVEN_DIR` unset every path stays where it is, and a test pins today's paths. Every unit and npm script starts in the package root, so reading `.env` and relative paths from there changes nothing.
  - The image builds touch CI only and change nothing on any box.
  - The compose runtime is bucket 3, gated per installation by `RUNTIME=compose` in its `deploy.env`. Absent, the installation keeps the systemd unit, today's shape.
  - Order: a canary installation first, then prod together with a release tag. Prod changes only when its operator sets the key.
  - `docs/rollout.md` gets one row with four stages: canary → prod → template default → systemd path retired.
- **Code:**
  - new: `src/paths.ts` with its test;
  - eleven modules stop locating runtime files through `import.meta.url`: `src/state.ts`, `src/queuejournal.ts`, `src/metering.ts`, `src/drafts.ts`, `src/facts.ts`, `src/feedback.ts`, `src/memjournal.ts`, `src/eventlog.ts`, `src/messaging/runtime.ts`, `src/sources/paths.ts` and `src/config.ts` (the projects config default);
  - `.env`, the mirror list and its cache, and relative path settings resolve against the installation directory instead of the working directory: `src/config.ts`, `src/mirrors.ts`, `scripts/mirror.ts`, `src/sources/paths.ts`, `src/messaging/config.ts` and `src/messaging/cli.ts`;
  - the release marker (`.release`) stays beside the code;
  - `scripts/mirror.ts` moves behind a CLI command, `orch mirror`, in `src/cli.ts`.
- **Deploy tooling:**
  - new: `Dockerfile`, `.dockerignore`, `.github/workflows/image.yml` and `infra/deploy/compose.yaml`;
  - changed: `infra/deploy/deploy.sh`, `.github/workflows/release.yml`, `infra/deploy/ops.example/workflows/deploy.yml`, `infra/deploy/ops.example/deploy.env.example` and `infra/deploy/ops.example/.gitignore`.
- **Tests:**
  - `src/paths.test.ts`;
  - a guard that fails when code under `src/` locates a runtime file through its own location (`import.meta.url`) or through the working directory (`process.cwd()`);
  - compose cases in `src/chat/teams/deploy.test.ts`: the rendered file, the default runtime and an unknown runtime;
  - the overlay's layout: the names `deploy.sh runtime-files` carries against the names the bot reads;
  - a harness for `deploy.sh`'s compose deploy with a fake `docker` on `PATH`;
  - the pull-request build runs the image once as a uid the image does not know.
- **Dependencies:**
  - Nothing changes in `package.json`.
  - A compose installation needs Docker Engine with the Compose plugin on the box, and the deployer in the `docker` group.
  - The image carries Node 24 (the version CI tests), git, the OpenSSH client, the Docker CLI, age and gitleaks.
- **Systems:**
  - The GitHub container registry gets a public package beside the public repository. The workflow writes it with its own token, so no new secret is needed.
  - Each installation's ops repository updates its deploy workflow from the template.

## Out of scope

- **How secrets reach the box.** `export` and `import` keep carrying `.env`, the GitHub App key and the projects config by scp. Keeping them encrypted in the ops repository is a change of its own.
- **Least privilege for the deployer.** The deployer keeps the `docker` group it has today. A wrapper behind a sudo rule is a later hardening.
- **Automatic rollback.** A failed deploy is red; the rollback is one command.
- **Registry retention.** `sha-*` images accumulate in a public package until a separate change cleans them, if ever.
- **Pull-based deploys and automatic canary deploys.** No box follows a version recorded in the ops repository, and no canary deploys every `main` commit by itself. A deploy stays one command over SSH, run by hand or by the ops workflow.
- **Kubernetes, ECS, Helm or any other orchestrator.** The image makes them possible; this change does not use them.
- **Compiling TypeScript at build time.** The image runs `tsx`, as the unit does today.
- **Other deploys and units.** The hub's deploy, the sandbox images under `snapshot/` and the `orch sources serve` units stay as they are; the serve units are still installed by hand.
- **A health endpoint and a container health check.** The deploy waits for the log line, as it does today.
- **The home bot.** It runs from a development checkout. Whether it moves to the image is its operator's decision (design, open questions).
- **The quickstart.** A separate change after this one, on this image.
