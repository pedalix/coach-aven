# Tasks

## 1. The installation directory (PR 1, bucket 2)

- [ ] 1.1 `src/paths.ts`, pure (design D1): `installDir(env, packageRoot)`, one resolver per runtime path, each evaluated on first use, and one helper that resolves a path setting's relative value against the installation directory.
  - unset or empty gives the package root;
  - an absolute value is used as it is;
  - a relative value throws one sentence that names `AVEN_DIR`.

  Verify, in `src/paths.test.ts`: the default, an absolute value, a relative value, `AVEN_DATA_DIR` still narrowing `data/`, and the helper with a relative and an absolute setting.
- [ ] 1.2 The eleven anchors go through `src/paths.ts`: `src/state.ts`, `src/queuejournal.ts`, `src/metering.ts`, `src/drafts.ts`, `src/facts.ts`, `src/feedback.ts`, `src/memjournal.ts`, `src/eventlog.ts`, `src/messaging/runtime.ts`, `src/sources/paths.ts`, and the projects config default in `src/config.ts`. `.release` stays where it is. Verify:
  - `npm run typecheck`;
  - `npm test` passes with no existing test changed;
  - a new test sets `AVEN_DIR` to a temporary directory and finds `state.json`, `queue.jsonl` and the month's usage file there.
- [ ] 1.3 The working directory stops mattering (design D1):
  - `src/config.ts` loads `.env` from the installation directory;
  - `mirrors.json` and the `mirrors/` cache come from the installation directory: `mirrorsPath` in `src/mirrors.ts` takes it instead of the working directory, and `scripts/mirror.ts` passes it;
  - relative path settings go through the helper: `PROJECTS_CONFIG_PATH` and `GITHUB_APP_PRIVATE_KEY_PATH` (`src/config.ts`), `AVEN_DATA_DIR` (`src/sources/paths.ts`), `MIRRORS_CONFIG` (`src/mirrors.ts`), `HUB_KEY_PATH` (`src/messaging/config.ts`, `src/messaging/cli.ts`).

  Verify:
  - `src/mirrors.test.ts` covers the list's path from the installation directory;
  - a test starts the CLI from a temporary working directory, with `AVEN_DIR` naming a fixture installation, and the command reads that installation's `.env` and `state.json`. The child's environment must not carry `NODE_TEST_CONTEXT`, or `.env` is never loaded.
- [ ] 1.4 The overlay's layout (requirement *The configuration has the overlay's layout*): a test beside the deploy tests in `src/chat/teams/deploy.test.ts` compares the names `deploy.sh runtime-files` carries with the names the bot reads from the installation directory: `.env`, the projects config default with `projects.d/` and `hub.peers.json` beside it, `mirrors.json`, and the key path in `infra/deploy/ops.example/.env.example`. Verify: it passes, and renaming one side makes it fail (checked once, then reverted).
- [ ] 1.5 `src/config.ts` at boot:
  - `AVEN_DIR` is resolved from the process environment before `.env` is loaded, and a `.env` that sets `AVEN_DIR` stops the boot;
  - a relative value stops the boot;
  - one boot line names the installation directory before the chat driver starts.

  Verify: cases in `src/config.test.ts` for "set in .env", "relative", and the boot line's text.
- [ ] 1.6 The guard, a test beside `src/chat/imports.test.ts`:
  - It fails on `new URL('../…', import.meta.url)` under `src/` (tests aside) when the target is not a code asset. The code assets are the fixtures, the static files, `sources/worker.mjs`, `snapshot/plain/sources-mcp.mjs` and `.release`.
  - It fails on `process.cwd()` under `src/` (tests aside) outside `src/cliprobe/typecheck.ts`.

  Verify: it passes on the tree. A fake anchor of each kind makes it fail, naming the file and the path (checked once, then reverted).
- [ ] 1.7 Docs:
  - `docs/runtime-config.md` gets an `AVEN_DIR` row: what lives under it (configuration and state), the default, that relative path settings resolve against it, and that it comes from the process environment only;
  - `docs/local-dev.md` says `.env` and the state live in the checkout unless `AVEN_DIR` is set.

  Verify: `git diff --stat docs` lists those two files, and the public guard is clean.
- [ ] 1.8 `docs/rollout.md` gets a ledger row: the installation directory, bucket 2, nothing moves while it is unset. Verify: the diff of `docs/rollout.md`.
- [ ] 1.9 Canary: restart home and deploy staging with `AVEN_DIR` unset. Verify:
  - the boot line names the package root;
  - the routines, the queue journal and `/aven usage` keep working;
  - nothing new appears outside the package root.

## 2. The image (PR 2)

- [ ] 2.1 `orch mirror` (design D10): the body of `scripts/mirror.ts` moves into a function that `orch mirror` (`src/cli.ts`) and `scripts/mirror.ts` both call, with the list and the `mirrors/` cache in the installation directory (task 1.3). Verify:
  - `npm test`, `src/mirrors.test.ts` included;
  - `npm run orch -- mirror --help`;
  - a test that both entry points import the same function.
- [ ] 2.2 The image's build file and `.dockerignore` (design D5):
  - Node 24 on Debian slim, pinned by digest;
  - git, `openssh-client` and `age` from Debian;
  - the Docker CLI and gitleaks copied from their official images;
  - `npm ci` into `/app`, after copying only `package.json` and the lockfile, and before the rest of the tree is copied;
  - an exec-form entry point that loads tsx by absolute path;
  - an unprivileged default user, and OCI labels for the source and the revision;
  - nothing of a box: no user, path, address or key of an installation (design D5).

  Verify:
  - `git archive HEAD | docker build -t aven:test -`;
  - a second build, of a commit that changes only a file under `src/`, shares every layer up to and including `npm ci` with the first (`docker history`);
  - `docker run --rm aven:test --help` lists the commands;
  - `docker run --rm -w /tmp aven:test routines --help` runs from another working directory;
  - `docker run --rm --entrypoint sh aven:test -c 'git --version && ssh -V && docker --version && age --version && gitleaks version'`;
  - `docker run --rm --user 4242:4242 -e HOME=/aven -e AVEN_DIR=/aven -v aven-test:/aven aven:test --help` runs as a uid the image does not know;
  - the one-directory scenario by hand (requirement *The image carries no installation*): a scratch directory with a `.env` for the web chat driver, mounted as `/aven`, `--user 4242:4242`, `-e HOME=/aven -e AVEN_DIR=/aven -e SSHDOCKER_HOST=local` and the Docker socket; the web chat answers on its port, a sandbox starts, and `ls -lnR` of the directory shows uid 4242 only.
- [ ] 2.3 `scripts/image-contents.sh` compares `/app` in an image, `node_modules` aside, with `git ls-files` of its commit (requirement *The image holds the commit and nothing else*); CI runs it after every build. Verify: it passes on the built image, and fails on an image built by hand from a context with one extra file.
- [ ] 2.4 `.github/workflows/image.yml`, a reusable workflow (design D6): one job per architecture on native runners (`ubuntu-24.04`, `ubuntu-24.04-arm`), each pushing by digest, then a merge job that publishes `sha-<commit>`. Each architecture's job reads and writes the registry build cache `buildcache-<arch>`. `packages: write` is granted in this workflow only. Verify:
  - a manual run on the branch publishes `sha-<branch head>`;
  - `docker buildx imagetools inspect` lists `linux/amd64` and `linux/arm64`;
  - a second manual run, after a commit that changes only code, takes `npm ci` from the cache, and both images carry the same dependency layer digest;
  - the test image is deleted afterwards.
- [ ] 2.5 `ci.yml`:
  - on pushes to `main`, `image.yml` runs after verify;
  - on a pull request that touches the build file, `.dockerignore`, `package.json` or the lockfile, both architectures build on their native runners without pushing; they read the build cache and never write it; each job runs the image it built once as a uid the image does not know (`--user 4242:4242 … --help`).

  Verify: this pull request's own run shows both build jobs, and after the merge `sha-<merge commit>` exists.
- [ ] 2.6 `release.yml`: a promotion job sits between verify and the GitHub Release. It runs `imagetools create -t vX.Y.Z …:sha-<commit>`, with `-t latest` as well when the tag is the highest `v*` tag (`git tag -l 'v*' | sort -V | tail -1`), or builds when the image is missing; the release and the dispatch need it. Verify, on the next tag's run:
  - `vX.Y.Z`, `sha-<commit>` and `latest` have the same digest;
  - the release was created after the promotion.
- [ ] 2.7 The registry package is public and linked to the repository. An owner of the organization sets the visibility once, in the package's settings, after the first publish. Verify: `docker logout ghcr.io && docker pull ghcr.io/<owner>/coach-aven:sha-<commit>`.
- [ ] 2.8 Retention: a scheduled workflow deletes `sha-*` images older than 90 days that no `v*` tag names. It never touches `v*` images, `latest` or the `buildcache-*` caches. Verify:
  - its dry run lists only such images;
  - its first real run deletes nothing a release names.
- [ ] 2.9 `.github/dependabot.yml` gets the `docker` ecosystem for the image's base. Verify: the diff of `.github/dependabot.yml`.
- [ ] 2.10 Docs:
  - `infra/deploy/README.md` gets an *Images* section: the three tags and who each is for, the promotion, where the image is built and how to pull it;
  - `docs/runtime-config.md`, *Repo mirrors*, names `orch mirror`;
  - CLAUDE.md's release line names the image.

  Verify: the public guard is clean, and the README's commands run as written.
- [ ] 2.11 The ledger row: the images, CI only, no box changes. Verify: the diff of `docs/rollout.md`.

## 3. The compose runtime (PR 3)

- [ ] 3.1 The template `infra/deploy/compose.yaml`, with a format number:
  - a `bot` service whose command is the chat driver;
  - an optional `sources-daemon` service;
  - one image, `<repository>:<version>`;
  - the settings of design D3;
  - the socket and its group for sandboxes on the box's own Docker, the deployer's `.ssh` for sandboxes on another host (D4);
  - `SENTRY_RELEASE` (D9), and the log driver from the configuration.

  Verify: render tests (new compose cases in `src/chat/teams/deploy.test.ts`) for Slack by default, Teams, with a daemon, local sandboxes, a remote Docker host, and a canary's release name. `docker compose -f <rendered> config` accepts each.
- [ ] 3.2 `infra/deploy/aven-deploy.sh`, the box's deploy command, part one (design D7, D8):
  - argument forms;
  - pulling before anything stops;
  - rendering from the template inside the pulled image, with the diff written to the log;
  - `up -d`, then the wait for the driver's line;
  - rollback to the last `ok` version;
  - the deploy record in the installation directory;
  - pruning down to two previous versions;
  - refusing a newer template format.

  Verify: `shellcheck`, and a test harness with a fake `docker` on `PATH`, run by `npm test`, covering:
  - a malformed version is refused;
  - an unknown version touches nothing;
  - a healthy deploy is recorded;
  - when the line does not come, the previous version runs again and the exit is 1;
  - `sha-` is accepted only with the canary flag.
- [ ] 3.3 The box's deploy command, part two: `start`, `stop`, `restart`, `status`, which shows the version, the digest and the previous version, `logs [-f]`, and `run <args…>`, which passes argv to the CLI and never goes through a shell. Verify: harness cases for `status` after two deploys, and for `run` with an argument holding `;` and spaces, which reaches the CLI verbatim.
- [ ] 3.4 The box's deploy command, part three (design D11):
  - the first compose deploy stops the systemd units, starts the containers and, on success, disables the units; on failure it starts the units again;
  - `revert-to-systemd`, which refuses after cleanup.

  Verify: harness cases with a fake `systemctl` for a successful first deploy, a failed one, and a revert.
- [ ] 3.5 The box's deploy command, part four, `cleanup` (design D11):
  - the lists: what is removed (the image's `/app` top level, `node_modules`, `.release`, the old unit files), what is kept (configuration and state) and what is unknown (kept);
  - it refuses while a unit is enabled or a cron line runs `node`, `tsx` or `npm` from the directory;
  - it removes only after `--yes`.

  Verify: harness cases for the three lists, an enabled unit, a cron line, and a run without `--yes`.
- [ ] 3.6 `deploy.sh` (design D12):
  - `RUNTIME` and `CANARY` from `deploy.env`, and an unknown runtime refused, naming both values;
  - the compose `install`: the Docker Engine and Compose check, then the command, `deploy.conf` and the sudo rule over the root SSH session, starting nothing;
  - the compose commands over `ssh deployer@host sudo …`;
  - `deploy` requires a version;
  - `run` and `cleanup`;
  - a `render-compose` subcommand without SSH, for tests.

  Verify, in `src/chat/teams/deploy.test.ts`:
  - with no `RUNTIME`, today's unit renders byte for byte, all existing cases unchanged;
  - `RUNTIME=docker` is refused;
  - `render-compose` works for an example overlay.
- [ ] 3.7 The ops workflow template (`infra/deploy/ops.example/workflows/deploy.yml`):
  - it reads `RUNTIME` and `CANARY` from its own `deploy.env`;
  - for compose there is no product checkout, and the deploy command runs over SSH with the version;
  - `sha-<commit>` is accepted only with `CANARY=1`, and refused before any SSH connection.

  Verify: `actionlint`, and a run against the canary installation (task 4.2).
- [ ] 3.8 `infra/deploy/ops.example/deploy.env.example` documents `RUNTIME` and `CANARY`, and `ops.example/README.md` describes the compose path. Verify: the diff, and a clean public guard.
- [ ] 3.9 Docs.
  - `infra/deploy/README.md` presents the compose runtime as the recommended one:
    - the prerequisites;
    - install → export → deploy with a version;
    - rollback;
    - `status`, `logs` and `run`;
    - the move and cleanup;
    - the privilege model.

    "Why systemd and not Docker" is replaced, and the systemd path stays as the legacy section.
  - The self-host section of `README.md`.
  - `docs/runtime-config.md`: the mirror's crontab line through `run mirror`.

  Verify: a clean public guard, and the commands run as written against the canary (group 4).
- [ ] 3.10 The ledger row: the compose runtime, bucket 3, gated per installation by `RUNTIME=compose`, with the stages canary → prod → template default → systemd path retired. Verify: the diff of `docs/rollout.md`.
- [ ] 3.11 The Home tab does not change: no Slack surface changes. Verify: `git diff --stat src/fixtures/chat` is empty.
- [ ] 3.12 The prompt goldens do not change. Verify: `git diff --stat src/fixtures/prompt` is empty.

## 4. The canary installation

The operator's plan for their own boxes lives in their ops repository. These are the generic checks.

- [ ] 4.1 `CANARY=1` and `RUNTIME=compose` in its overlay, then `install`. Verify:
  - the output of `install`;
  - `sudo -l` for the deployer shows the deploy command beside the rules it already had;
  - no container was started.
- [ ] 4.2 The first compose deploy, of the commit the installation runs now (from the ops workflow, task 3.7). Verify:
  - `status` shows the version and the digest;
  - `systemctl is-enabled` reports the old units as disabled;
  - `/aven status` and one turn work;
  - the routines are the same as before;
  - the boot line names the installation directory.
- [ ] 4.3 Rollback and moving back, once each:
  - deploy the previous commit's image, then the current one again;
  - run `revert-to-systemd`, then deploy with compose again.

  Verify: the record and `status` after each step, and the bot answers each time.
- [ ] 4.4 Two days on the canary: routines at their slots, restart recovery, sandboxes created and stopped by the idle stop, and the listeners behind the host's proxy. Verify: the canary channel, and a journal without new errors.
- [ ] 4.5 `cleanup`: review the list, then run with `--yes`. Verify:
  - the bot keeps running;
  - the directory holds only configuration and state;
  - the list is saved in the operator's notes.

## 5. Prod

- [ ] 5.1 With the first release tag after group 4:
  - `RUNTIME=compose`, then `install`;
  - the mirror's crontab line rewritten to `run mirror`;
  - deploy `vX.Y.Z`.

  Verify:
  - `status` shows `vX.Y.Z` with the digest the canary ran;
  - `/aven status` works;
  - the next mirror run writes its log line;
  - the sources daemon container answers the bot;
  - the next error-tracker event carries the release `vX.Y.Z`.
- [ ] 5.2 `cleanup` after one release without trouble. Verify: as in 4.5.
- [ ] 5.3 The ledger's canary and prod dates. Verify: the diff of `docs/rollout.md`.

## Workflow follow-up

- After every installation we operate runs compose, a later change makes `compose` the template's default and retires the systemd path: the tar deploy, the unit templates, `.release` and the `scripts/mirror.ts` caller. The ledger row then moves to *Retired*.
- The operator's plan for their own installations (which boxes, in which order, the crontab lines) is a change in their ops repository's OpenSpec store, linked from here in prose.
- Archive this change after group 5.
