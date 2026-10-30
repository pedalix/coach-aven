# CoachAven — deploy an installation onto a Linux box

A **scripted** deployment of the CoachAven orchestrator onto one Linux box over ssh (any small VM
does; it shares fine with other services). One installation = one **ops repo** checked out at
`infra/<slug>/` (below); every command here names that slug. Where *your* box is, who runs on
it and what it talks to belongs in that repo, not in this file.

One runtime (OpenSpec `container-deploy`; the systemd path retired after v0.43.0, OpenSpec
`retire-systemd-deploy`): the bot is the published image, `ghcr.io/<owner>/coach-aven` (*Images*, below), run by
`docker compose` in `REMOTE_DIR/compose/` as the deployer. A deploy names a version — `deploy.sh <slug> deploy
v1.4.0` — and uploads nothing: the box pulls the image, pins the version in a two-line file, starts the containers
and waits for the chat driver's "bot running" line. A rollback is the same command with the earlier version; its
image is still on the box. The canary and prod run the same bytes, and a deploy that does not come up is red.

CoachAven is just the **control plane**: one long-lived Node process that holds the chat connection
(Slack Socket Mode dials *out*; Teams and the web chat listen on loopback behind the host's proxy) and
drives sandboxes (containers on a Docker host, over SSH or on this very box — `docs/sandbox-drivers.md`).
All the heavy work (Claude Code, Sail stacks, builds) happens **inside the sandboxes**, so the footprint
here is tiny: no nginx, no ports, no TLS of its own.

```
   Slack  ⇄ (outbound WebSocket, Socket Mode)
              │
   docker compose, project coach-aven  (user=deployer, REMOTE_DIR mounted at its own path = AVEN_DIR)
     bot:             ghcr.io/<owner>/coach-aven:<version>  slack
     sources-daemon:  the same image  sources daemon --listen 127.0.0.1:3416   (where the installation runs one)
              │  SSH, or the box's own Docker socket
              ▼
   sandbox host(s) ── one warm sandbox per project, worktree per task
```

## Files

| Path | Role |
| --- | --- |
| `deploy.sh` | `<slug> <command>`: install / export·import / deploy / logs / status / start·stop·restart / ssh / down |
| `compose.yaml` | the compose file template (placeholders and switches rendered at `install` from `deploy.env` and the box) |
| `nginx-sources.conf.example` | nginx in front of `orch sources serve` (TLS); the sources daemon itself is the `sources-daemon` compose service |
| `ops.example/` | template for an ops repo: `deploy.env.example`, `.env.example`, `projects.d/example.md`, the deploy workflow |
| `../<slug>/` | **your ops repo**, checked out beside this directory (gitignored) — see below |

## `infra/<slug>/` is your ops repo

The app's runtime config — `projects.config.json`, `projects.d/<slug>.md` prompts — the deploy
target `deploy.env` (host, users, remote dir, service name) and the two secret files `.env` and
`github-app-private-key.pem` live in **`infra/<slug>/`**, deliberately apart from the repo-root files (those are your **local-dev** runtime, per
[`../../docs/local-dev.md`](../../docs/local-dev.md)).

That directory is a **git checkout of a private repository of yours** — the *ops overlay*:
the place for everything that describes your installation and must never enter this public
repo (project list, prompts, host topology, operator notes, plans, customer specifics). The two
secret files sit in the checkout but are ignored by its `.gitignore`; they travel by scp only.
`deploy.env` is tracked: it is a host and user names, and the deploy workflow reads it from its
own checkout. Start one from [`ops.example/`](ops.example/README.md). Several installations sit
side by side under `infra/` — the whole directory is gitignored by allow-list (only `deploy/`,
`teams/` and the README are tracked), so no slug ever reaches the public tree.

- `npm run ops -- <slug> export` — refuses while the checkout is dirty, **pushes it**, then uploads
  the runtime files to the box. The ops repo, not a laptop, is the record of what the box runs.
- `npm run ops -- <slug> import` — pulls the box's live copies back into the checkout and shows the
  drift as `git status`, for you to commit (a change made directly on the box, or seeding a
  fresh clone).

The pattern is the usual app-repo / ops-repo split: this repo documents the mechanism, yours
holds the instance. The rule of thumb for what goes where: a line a stranger self-hosting
would need is public; a line naming your host, customer or a person is ops.

## Prerequisites

- SSH access to `deployer@<host>` (runs the containers, owns the files) and, for `install` only, to
  `root@<host>` (creates `REMOTE_DIR`). Uses your default SSH keys/agent. The deploy workflow and every
  day-2 command need the deployer alone.
- Your ops repo cloned at `infra/<slug>/` with `deploy.env`, `.env`,
  `github-app-private-key.pem`, `projects.config.json` present (from `ops.example/`, or pull a running box
  with `npm run ops -- <slug> import`).
- On the box: **Docker Engine with the Compose plugin**, and the deployer **in the `docker` group**.
  `install` checks all three and names what is missing. Be clear about the group: whoever holds the Docker
  socket is root on the box, so the deployer — and the deploy key that logs in as it — is root-equivalent.
  That is the position the deployer has on a box whose sandboxes run on its own Docker anyway; a wrapper
  behind a sudo rule is a later hardening, not part of this runtime.

## Deploy (first time)

```bash
npm run ops -- <slug> install          # root: REMOTE_DIR. deployer: the checks, ~/.config/coach-aven,
                                       #   REMOTE_DIR/compose/compose.yaml rendered — nothing started
npm run ops -- <slug> export           # push ops repo, upload → .env, GitHub App key, projects.config.json, projects.d/
npm run ops -- <slug> deploy v1.4.0    # pull → pin → docker compose up -d → wait for "Slack bot running"
```

`install` renders the compose file from `deploy.env` (service name, image repository, chat driver, the
daemon's listen address) and what the box says (the deployer's uid, gid and home, the Docker socket's
group, which optional home files exist) and from one key of the installation's `.env`, `SSHDOCKER_HOST`:
`local` mounts the box's Docker socket and no ssh key, another host mounts the deployer's `~/.ssh`
read-only and no socket. Rerun `install` after changing any of those, then `restart`.

## Updates and rollbacks

```bash
npm run ops -- <slug> deploy v1.5.0    # the new version
npm run ops -- <slug> deploy v1.4.0    # back: the same command, the earlier version — no registry needed
npm run ops -- <slug> status           # the pin, the containers, the last deploys
```

A version is `vX.Y.Z`, or `sha-<commit>` on the installation whose `deploy.env` says `CANARY=1`; `latest`
and branches are refused, because what runs must be nameable. The deploy pulls first (a failed pull changes
nothing), writes `REMOTE_DIR/compose/.env` (`AVEN_VERSION`, `AVEN_RELEASE`), runs `docker compose up -d`
and waits up to 90 s for the driver's line; then it appends `<time> <version> ok` — or `failed`, with the
bot's last lines on screen and exit 1 — to `REMOTE_DIR/deploys.log`. A failed version stays running until
you deploy another; nothing rolls back on its own. Every deployed image stays on the box: `docker image ls`
and `deploys.log` name the rollback candidates, `docker image prune -a` on the box reclaims the disk (a
pruned earlier version is pulled again when deployed).

`deploy` never touches the server's `.env`, GitHub key, `projects.config.json` or `state.json`. Change a
secret or the project list in the ops checkout → commit → `export` → `restart` (`.env` is read at boot;
the project list is read at boot and re-read by `/aven reload` for new sessions only).

## Day-2 commands

All take the slug first: `npm run ops -- <slug> <command>` (no slug → the help and the slugs found).

| Command | What it does |
| --- | --- |
| `deploy <version>` | pull → pin → `up -d` → wait → `deploys.log` |
| `export` | push the ops repo, upload `infra/<slug>/` → the box |
| `import` | pull the box's runtime back into the ops checkout, show the drift |
| `status` | the pin, `docker compose ps`, the last deploys |
| `logs [-f]` | the bot's log (`docker compose logs bot`) |
| `restart` | `up -d --force-recreate` + the same wait (an edited `.env` or compose file takes effect) |
| `start` / `stop` | `up -d` + wait / `docker compose stop` |
| `ssh` | interactive shell on the box (deployer) |
| `down` | `docker compose down` — the images, the pin and the files stay |

## Moving an installation from the systemd deploy of v0.43.0 or earlier

Done once per installation, as a checklist. There is no way back: v0.43.0 is the last release whose tooling
installs or deploys the unit, and `RUNTIME=systemd` in `deploy.env` is refused since, pointing here.

1. As root on the box: stop and disable the bot's unit and, where one ran, the sources daemon's
   (`systemctl disable --now <service> <service>-sources-daemon`), then remove the unit files and
   `/etc/sudoers.d/<service>`. The compose deploy refuses while the bot's unit is still active.
2. In `deploy.env`: drop `RUNTIME`, set `CANARY=1` on the canary installation, `DAEMON_LISTEN=…` where the
   box ran the daemon. Then `install`, then `deploy <version>` with the version the box ran: the commit's
   `sha-<commit>` on the canary, the release tag on prod (v0.43.0 is the first tag with an image). The state
   (`state.json`, the journals, `data/`) is where it was, now mounted into the containers.
3. The crontab: the mirror job becomes `*/30 * * * * cd REMOTE_DIR/compose && docker compose --progress quiet run --rm --no-deps bot mirror >> REMOTE_DIR/mirrors/mirror.log 2>&1`
   (every run uses the pinned version; `--progress quiet` keeps compose's container lines out of the log).
4. Remove the old code from `REMOTE_DIR`. The list is the product's top-level names, `node_modules` and the
   `.release` marker the tar deploy wrote — never configuration or state:

   ```bash
   cd REMOTE_DIR && rm -rf .claude .dockerignore .env.example .github .gitignore .gitleaks.toml .nvmrc \
     CHANGELOG.md CLAUDE.md CODE_OF_CONDUCT.md CONTRIBUTING.md Dockerfile LICENSE NOTICE README.md SECURITY.md SUPPORT.md \
     docs hub infra openspec package-lock.json package.json projects.config.example.json scripts slack-app-manifest.json \
     snapshot src tsconfig.json node_modules .release
   ```

   Afterwards `ls -a` shows the configuration (`.env`, the key, `projects.config.json`, `projects.d/`,
   `mirrors.json`, `hub.peers.json`), the state (`state.json`, `queue.jsonl`, `usage/`, `drafts/`, `facts/`,
   `memory/`, `feedback/`, `events/`, `shadow/`, `data/`, `mirrors/`), `compose/` and `deploys.log`. Anything
   else is a leftover of an earlier tar deploy and can go by hand, as can the Node.js the box no longer needs.

## Releases (CI/CD)

Two repositories, two jobs:

- **This repo releases.** Pushing a `vX.Y.Z` tag runs
  [`.github/workflows/release.yml`](../../.github/workflows/release.yml): typecheck, tests and
  the two guards, then the image `vX.Y.Z` (*Images*, below), then a GitHub Release whose notes are
  generated from the merged PR titles.
  Then, if the operator configured it, one `repository_dispatch` (`coach-aven-release`,
  payload `{tag}`) to the operator's ops repo. This repo holds **no deploy key, no deploy
  target, no environment** — a fork cuts releases just the same, the dispatch is skipped.
- **Your ops repo deploys.** [`ops.example/workflows/deploy.yml`](ops.example/workflows/deploy.yml)
  is the whole deploy workflow: by hand with a version (`workflow_dispatch`) — the normal path — or
  on that dispatch, it checks out itself and this repo at the version beside it, installs its own deployer
  key and runs `deploy.sh <slug> deploy <version>`, reading the target from its own
  `deploy.env`. `vX.Y.Z` only, plus `sha-<commit>` on the installation whose `deploy.env` says `CANARY=1`
  — a branch or `latest` is refused. Deploys are queued, never overlapped. Rollback = deploy the previous
  version.

Cut a release (no changelog or version edits — the tag is the version of record):

```bash
npm run release -- vX.Y.Z     # = git tag + push (→ GitHub Release) + `gh workflow run deploy.yml` in your ops repo
```

`scripts/release.sh` does the two steps by hand-equivalent commands and prints the ops run
URL; `OPS_REPO` names the ops repo. We deliberately keep
**no credential in this repo** for the hand-off: the person who tags starts the deploy.
The `repository_dispatch` step in `release.yml` stays as an opt-in for operators who prefer
the automatic path (set `OPS_APP_ID`/`OPS_APP_PRIVATE_KEY`; it is skipped otherwise).

The manual path, `npm run ops -- <slug> deploy` from a machine with the ops checkout, is
unchanged and always available.

**Secrets** (none in this repo for a plain fork):

| Where | Secret | Value |
| --- | --- | --- |
| ops repo | `DEPLOY_SSH_KEY` | passphrase-less private key for `deployer@<host>` |
| ops repo | variable `OPS_SLUG` | the installation's slug (not a secret) — the target itself is the tracked `deploy.env` |
| ops repo | `APP_ID`, `APP_PRIVATE_KEY` | optional — a GitHub App that can read the product repo; only while it is private to you |
| product repo | `OPS_APP_ID`, `OPS_APP_PRIVATE_KEY` | optional, **not set upstream** — a GitHub App installed on your ops repo enables the automatic hand-off instead of `npm run release`. A token scoped to that one repo and `contents: write` is minted per run |

Why a GitHub App and not a personal token: it is scoped at mint time, lives an hour, and
is revoked by rotating one key — nobody's account, nothing that expires in a year.

## Images

Every commit on `main` that passes verification is built once into an image,
`ghcr.io/<owner>/coach-aven`, for `linux/amd64` and `linux/arm64` on native runners
([`.github/workflows/image.yml`](../../.github/workflows/image.yml), called from `ci.yml`). The image holds
the commit's tracked files, the dependencies of its lockfile, Node 24 and the host tools the bot starts
(git, the OpenSSH client, the Docker CLI, age, gitleaks) — and nothing of any installation: no user, path,
address or key of a box. Three names, three readers:

| Tag | Who it is for |
| --- | --- |
| `sha-<commit>` (the full commit id) | the canary installation, and the promotion below |
| `vX.Y.Z` | a release installation — the **same digest** the commit's `sha-` image had, never a rebuild |
| `latest` | someone outside who wants the current release: the highest `vX.Y.Z`; a patch of an older line leaves it alone |

A tag's run (`release.yml`) promotes the commit's image with `docker buildx imagetools create` and builds
it first only when the commit has none. The package is public, so a box pulls anonymously and holds no
registry token:

```bash
docker pull ghcr.io/<owner>/coach-aven:v1.4.0
docker run --rm ghcr.io/<owner>/coach-aven:v1.4.0 --help     # the CLI, from any working directory
docker buildx imagetools inspect ghcr.io/<owner>/coach-aven:v1.4.0   # both architectures, the digest
```

A pull request that changes the image's inputs (the `Dockerfile`, `.dockerignore`, `package.json` or the
lockfile) builds both architectures without publishing, so a dependency that does not install — or
installs on one architecture only — fails before the merge. A local build from a working tree,
`git archive HEAD | docker build -t coach-aven:dev -`, sees tracked files only, like CI.

## Runtime credit note

The app takes its Claude Code credit from the installation's runtime `.env`
(`infra/<slug>/.env`, uploaded by `export`): **exactly one** of
`CLAUDE_CODE_OAUTH_TOKEN` (a stable `claude setup-token` value) and `ANTHROPIC_API_KEY`
(an Anthropic API key — the credit for an installation that serves a team or clients).
Both set stops the boot, and so does a value in the other credit's variable. The sandbox can
read the credit, so a key should be a dedicated one in its own Anthropic workspace with a
monthly spend limit. The boot line in the journal names the credit and its variable, never
the value. A switch applies to new conversations; a running one keeps its credit until its
process ends (`docker rm -f` of the project's container applies it at once — the next turn
creates the container again). The `~/.claude` credentials fallback is for dev boxes only;
don't rely on it here (the compose file mounts the file read-only when the box has it).

## What this is NOT (yet)

- No public URL by default — Socket Mode only; the bot is reachable from Slack, not
  the web (OAuth installs, Teams, the web chat and `sources serve` are the opt-in exceptions, behind
  the host's proxy).
- State is a JSON file on the box (`REMOTE_DIR/state.json`) — snapshot it
  if you need a backup.
- No isolation of the bot from its box: the containers run as the deployer with host networking and the
  deployer's home, as the service did. Hardening is a later change.
