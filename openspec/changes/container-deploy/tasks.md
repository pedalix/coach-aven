# Tasks

## 1. The installation directory (PR 1, bucket 2)

- [x] 1.1 `src/paths.ts`, pure (design D1): `installDir(env, packageRoot)`, one resolver per runtime path, each evaluated on first use, and one helper that resolves a path setting's relative value against the installation directory.
  - unset or empty gives the package root;
  - an absolute value is used as it is;
  - a relative value throws one sentence that names `AVEN_DIR`.

  Verify, in `src/paths.test.ts`: the default, an absolute value, a relative value, `AVEN_DATA_DIR` still narrowing `data/`, and the helper with a relative and an absolute setting.
- [x] 1.2 The eleven anchors go through `src/paths.ts`: `src/state.ts`, `src/queuejournal.ts`, `src/metering.ts`, `src/drafts.ts`, `src/facts.ts`, `src/feedback.ts`, `src/memjournal.ts`, `src/eventlog.ts`, `src/messaging/runtime.ts`, `src/sources/paths.ts`, and the projects config default in `src/config.ts`. `.release` stays where it is. Verify:
  - `npm run typecheck`;
  - `npm test` passes with no existing test changed;
  - a new test sets `AVEN_DIR` to a temporary directory and finds `state.json`, `queue.jsonl` and the month's usage file there.
- [x] 1.3 The working directory stops mattering (design D1):
  - `src/config.ts` loads `.env` from the installation directory;
  - `mirrors.json` and the `mirrors/` cache come from the installation directory: `mirrorsPath` in `src/mirrors.ts` takes it instead of the working directory, and `scripts/mirror.ts` passes it;
  - relative path settings go through the helper: `PROJECTS_CONFIG_PATH` and `GITHUB_APP_PRIVATE_KEY_PATH` (`src/config.ts`), `AVEN_DATA_DIR` (`src/sources/paths.ts`), `MIRRORS_CONFIG` (`src/mirrors.ts`), `HUB_KEY_PATH` (`src/messaging/config.ts`, `src/messaging/cli.ts`).

  Verify:
  - `src/mirrors.test.ts` covers the list's path from the installation directory;
  - a test starts the CLI from a temporary working directory, with `AVEN_DIR` naming a fixture installation, and the command reads that installation's `.env` and `state.json`. The child's environment must not carry `NODE_TEST_CONTEXT`, or `.env` is never loaded.
- [x] 1.4 The overlay's layout (requirement *The configuration has the overlay's layout*): a test beside the deploy tests in `src/chat/teams/deploy.test.ts` compares the names `deploy.sh runtime-files` carries with the names the bot reads from the installation directory: `.env`, the projects config default with `projects.d/` and `hub.peers.json` beside it, `mirrors.json`, and the key path in `infra/deploy/ops.example/.env.example`. Verify: it passes, and renaming one side makes it fail (checked once, then reverted).
- [x] 1.5 `src/config.ts` at boot:
  - `AVEN_DIR` is resolved from the process environment before `.env` is loaded, and a `.env` that sets `AVEN_DIR` stops the boot;
  - a relative value stops the boot;
  - one boot line names the installation directory before the chat driver starts.

  Verify: cases in `src/config.test.ts` for "set in .env", "relative", and the boot line's text.
- [x] 1.6 The guard, a test beside `src/chat/imports.test.ts`:
  - It fails on `new URL('../…', import.meta.url)` under `src/` (tests aside) when the target is not a code asset. The code assets are the fixtures, the static files, `sources/worker.mjs`, `snapshot/plain/sources-mcp.mjs` and `.release`.
  - It fails on `process.cwd()` under `src/` (tests aside) outside `src/cliprobe/typecheck.ts`.

  Verify: it passes on the tree. A fake anchor of each kind makes it fail, naming the file and the path (checked once, then reverted).
- [x] 1.7 Docs:
  - `docs/runtime-config.md` gets an `AVEN_DIR` row: what lives under it (configuration and state), the default, that relative path settings resolve against it, and that it comes from the process environment only;
  - `docs/local-dev.md` says `.env` and the state live in the checkout unless `AVEN_DIR` is set.

  Verify: `git diff --stat docs` lists those two files, and the public guard is clean.
- [x] 1.8 `docs/rollout.md` gets a ledger row: the installation directory, bucket 2, nothing moves while it is unset. Verify: the diff of `docs/rollout.md`.
- [ ] 1.9 Canary: restart home and deploy staging with `AVEN_DIR` unset. Verify:
  - the boot line names the package root;
  - the routines, the queue journal and `/aven usage` keep working;
  - nothing new appears outside the package root.

## 2. The image (PR 2)

- [x] 2.1 `orch mirror` (design D7): the body of `scripts/mirror.ts` moves into a function that `orch mirror` (`src/cli.ts`) and `scripts/mirror.ts` both call, with the list and the `mirrors/` cache in the installation directory (task 1.3). Verify:
  - `npm test`, `src/mirrors.test.ts` included;
  - `npm run orch -- mirror --help`;
  - a test that both entry points import the same function.
- [x] 2.2 The image's build file and `.dockerignore` (design D5):
  - Node 24 on Debian slim, pinned by digest;
  - git, `openssh-client` and `age` from Debian;
  - the Docker CLI and gitleaks copied from their official images;
  - `npm ci` into `/app`, after copying only `package.json` and the lockfile, and before the rest of the tree is copied;
  - an exec-form entry point that loads tsx by absolute path;
  - an unprivileged default user, and OCI labels for the source and the revision;
  - nothing of a box: no user, path, address or key of an installation (design D5).

  Verify:
  - `git archive HEAD | docker build -t aven:test -`;
  - the files under `/app`, `node_modules` aside, are the commit's tracked files and nothing else (`git ls-files` against `find`), checked once by hand;
  - a second build, of a commit that changes only a file under `src/`, shares every layer up to and including `npm ci` with the first (`docker history`);
  - `docker run --rm aven:test --help` lists the commands;
  - `docker run --rm -w /tmp aven:test routines --help` runs from another working directory;
  - `docker run --rm --entrypoint sh aven:test -c 'git --version && ssh -V && docker --version && age --version && gitleaks version'`;
  - `docker run --rm --user 4242:4242 -e HOME=/aven -e AVEN_DIR=/aven -v aven-test:/aven aven:test --help` runs as a uid the image does not know;
  - the one-directory scenario by hand (requirement *The image carries no installation*): a scratch directory with a `.env` for the web chat driver, mounted as `/aven`, `--user 4242:4242`, `-e HOME=/aven -e AVEN_DIR=/aven -e SSHDOCKER_HOST=local` and the Docker socket; the web chat answers on its port, a sandbox starts, and `ls -lnR` of the directory shows uid 4242 only.
- [x] 2.3 `.github/workflows/image.yml`, a reusable workflow (design D6): one job per architecture on native runners (`ubuntu-24.04`, `ubuntu-24.04-arm`), each pushing by digest, then a merge job that publishes `sha-<commit>`. Each architecture's job reads and writes the registry build cache `buildcache-<arch>`. `packages: write` is granted in this workflow only. Verify:
  - a manual run on the branch publishes `sha-<branch head>`;
  - `docker buildx imagetools inspect` lists `linux/amd64` and `linux/arm64`;
  - a second manual run, after a commit that changes only code, takes `npm ci` from the cache, and both images carry the same dependency layer digest;
  - the test image is deleted afterwards.
- [x] 2.4 `ci.yml`:
  - on pushes to `main`, `image.yml` runs after verify;
  - on a pull request that touches the build file, `.dockerignore`, `package.json` or the lockfile, both architectures build on their native runners without pushing; they read the build cache and never write it; each job runs the image it built once as a uid the image does not know (`--user 4242:4242 … --help`).

  Verify: this pull request's own run shows both build jobs, and after the merge `sha-<merge commit>` exists.
- [x] 2.5 `release.yml`: a promotion job sits between verify and the GitHub Release. It runs `imagetools create -t vX.Y.Z …:sha-<commit>`, with `-t latest` as well when the tag is the highest `v*` tag (`git tag -l 'v*' | sort -V | tail -1`), or builds when the image is missing; the release and the dispatch need it. Verify, on the next tag's run:
  - `vX.Y.Z`, `sha-<commit>` and `latest` have the same digest;
  - the release was created after the promotion.
- [ ] 2.6 The registry package is public and linked to the repository. An owner of the organization sets the visibility once, in the package's settings, after the first publish. Verify: `docker logout ghcr.io && docker pull ghcr.io/<owner>/coach-aven:sha-<commit>`.
- [x] 2.7 `.github/dependabot.yml` gets the `docker` ecosystem for the image's base. Verify: the diff of `.github/dependabot.yml`.
- [x] 2.8 Docs:
  - `infra/deploy/README.md` gets an *Images* section: the three tags and who each is for, the promotion, where the image is built and how to pull it;
  - `docs/runtime-config.md`, *Repo mirrors*, names `orch mirror`;
  - CLAUDE.md's release line names the image.

  Verify: the public guard is clean, and the README's commands run as written.
- [x] 2.9 The ledger row: the images, CI only, no box changes. Verify: the diff of `docs/rollout.md`.

## 3. The compose runtime (PR 3)

- [ ] 3.1 The template `infra/deploy/compose.yaml` (design D3, D4, D7):
  - `name` set to the service;
  - a `bot` service whose command is the chat driver, and a `sources-daemon` service when a listen address is given;
  - `image: <repository>:${AVEN_VERSION}` and `SENTRY_RELEASE: ${AVEN_RELEASE}`, both from the compose directory's `.env`;
  - the settings of D3, the optional home files only when present, and journald logging;
  - the socket and its group for sandboxes on the box's own Docker, the deployer's `.ssh` for sandboxes on another host (D4).

  Verify: render tests in `src/chat/teams/deploy.test.ts` for Slack by default, Teams, with a daemon, local sandboxes, a remote Docker host, and a home with and without the optional files; `docker compose config` accepts each rendered file.
- [ ] 3.2 `deploy.sh` (design D7, D8):
  - `RUNTIME` and `CANARY` from `deploy.env`; an unknown runtime refused, naming both values;
  - the compose `install`: the Docker Engine and Compose check, the deployer's `.config/coach-aven` (mode 0700) when it is missing, and the compose file rendered into `<dir>/compose/`, starting nothing;
  - `deploy <version>`: the version's form, the canary rule, the refusal while the unit is active, the pull, the two-line pin, `up -d`, the 90 s wait, the line in `deploys.log`, a non-zero exit when the line does not come;
  - `status`, `logs [-f]`, `restart` and `down` as compose commands;
  - a `render-compose` subcommand without SSH, for tests.

  Verify, in `src/chat/teams/deploy.test.ts`: with no `RUNTIME`, today's unit renders byte for byte and every existing case is unchanged; `RUNTIME=docker` is refused; `render-compose` works for an example overlay. And a harness with a fake `docker` and `systemctl` on `PATH`, run by `npm test`: a malformed version is refused; `sha-` only with the canary flag; `latest` is refused; an active unit refuses the deploy; a failed pull writes nothing; the line comes → `ok` logged, exit 0; the line does not come → `failed` logged, exit 1, the log's tail printed.
- [ ] 3.3 The ops workflow template (`infra/deploy/ops.example/workflows/deploy.yml`): the version check moves after the overlay's checkout and accepts `sha-<commit>` only with `CANARY=1` in that `deploy.env`; the deploy step runs `deploy.sh "$OPS_SLUG" deploy "$TAG"`; the header comment describes both runtimes. Verify: `actionlint`, and a run against the canary (task 4.2).
- [ ] 3.4 The ops template: `deploy.env.example` documents `RUNTIME`, `CANARY` and the daemon's listen address; `.gitignore` ignores `compose/` and `deploys.log`; `ops.example/README.md` describes the compose path. Verify: the diff, and a clean public guard.
- [ ] 3.5 Docs (design D9):
  - `infra/deploy/README.md`: the compose runtime as the recommended one: prerequisites, including the `docker` group and what it amounts to; install → export → deploy with a version; rollback; `status`, `logs`, `restart`, `down`; the move checklist; the cleanup list as one command; the crontab line; "Why systemd and not Docker" replaced, the systemd path as the legacy section;
  - the self-host section of `README.md`;
  - `docs/runtime-config.md`: the mirror's crontab line.

  Verify: a clean public guard, and the commands run as written against the canary (group 4).
- [ ] 3.6 The ledger row: the compose runtime, bucket 3, gated per installation by `RUNTIME=compose`, with the stages canary → prod → template default → systemd path retired. Verify: the diff of `docs/rollout.md`.
- [ ] 3.7 The Home tab and the prompt goldens do not change. Verify: `git diff --stat src/fixtures/chat src/fixtures/prompt` is empty.

## 4. The canary installation

The operator's plan for their own boxes lives in their ops repository. These are the generic checks.

- [ ] 4.1 With `RUNTIME` still `systemd`: `deploy.sh <slug> down`. Then `RUNTIME=compose` and `CANARY=1` in the overlay, and `install`. Verify: no container was started; `compose/compose.yaml` is in the directory; the deployer's `.config/coach-aven` exists.
- [ ] 4.2 `deploy sha-<the commit it ran>` from the ops workflow (task 3.3). Verify:
  - `status` shows the pin and the containers;
  - `/aven status` and one turn work;
  - the routines are the same as before;
  - the boot line names the installation directory;
  - the unit is disabled.
- [ ] 4.3 Rollback once: deploy the previous commit's image, then the current one again. Verify: `deploys.log`, `status`, and the bot answers each time.
- [ ] 4.4 Two days on the canary: routines at their slots, restart recovery, sandboxes created and stopped by the idle stop, and the listeners behind the host's proxy. Verify: the canary channel, and a journal without new errors.
- [ ] 4.5 The old code removed with the README's command. Verify: the bot keeps running, and the directory holds only configuration, state, `compose/` and `deploys.log`.

## 5. Prod

- [ ] 5.1 With the first release tag after group 4: `down` for the bot's unit and the daemon's; `RUNTIME=compose` and the daemon's listen address in the overlay; `install`; the mirror's crontab line rewritten; `deploy vX.Y.Z`. Verify:
  - `status` shows `vX.Y.Z`, and `docker compose images` shows the digest the canary ran;
  - `/aven status` works;
  - the next mirror run writes its log line;
  - the sources daemon container answers the bot;
  - the next error-tracker event carries the release `vX.Y.Z`.
- [ ] 5.2 The old code removed after one release without trouble. Verify: as in 4.5.
- [ ] 5.3 The ledger's canary and prod dates. Verify: the diff of `docs/rollout.md`.

## Workflow follow-up

- After every installation we operate runs compose, a later change makes `compose` the template's default and retires the systemd path: the tar deploy, the unit templates, `.release` and the `scripts/mirror.ts` caller. The ledger row then moves to *Retired*.
- The operator's plan for their own installations (which boxes, in which order, the crontab lines) is a change in their ops repository's OpenSpec store, linked from here in prose.
- Hardening the deployer's privileges (a wrapper behind a sudo rule) and registry retention are separate changes, if ever.
- Archive this change after group 5.
