# CoachAven — deploy an installation onto a plain Linux host

A **manual, scripted** deployment of the CoachAven orchestrator onto one Linux box with
systemd and ssh (any small VM does; it shares fine with other services). CoachAven runs as a
**systemd service**, not in Docker. One installation = one **ops repo** checked out at
`infra/<slug>/` (below); every command here names that slug. Where *your* box is, who runs on
it and what it talks to belongs in that repo, not in this file.

## Why systemd and not Docker / nginx

CoachAven is just the **control plane**: one long-lived Node process that holds a
Slack **Socket-Mode** connection and drives sandboxes (Daytona over HTTPS, or ssh-docker
over SSH — `docs/sandbox-drivers.md`). All the heavy work (Claude Code, Sail stacks, builds)
happens **inside the sandboxes**, not on this box — so the footprint here is tiny.

- **No nginx, no ports, no TLS.** Socket Mode dials *out* to Slack, so nothing
  touches the host's `80/443`. (The optional multi-workspace OAuth callback and
  `orch sources serve` do need a reverse proxy — `README.md` → *Multi-workspace installs*,
  `nginx-sources.conf.example`.)
- **No Docker.** A plain systemd unit (`Restart=always`) is the whole runtime.
  `tsx` runs as a Node `--import` loader, so the service's main PID is `node` and
  systemd's SIGTERM reaches the app directly.

```
   Slack  ⇄ (outbound WebSocket, Socket Mode)
              │
   systemd: coach-aven.service   (User=deployer, WorkingDirectory=REMOTE_DIR)
     node --import tsx src/cli.ts slack
              │  HTTPS / SSH
              ▼
   sandbox host(s) ── one warm sandbox per project, worktree per task
```

## Files

| Path | Role |
| --- | --- |
| `deploy.sh` | `<slug> <command>`: install / export·import / deploy / logs / status / start·stop·restart / ssh / down |
| `coach-aven.service.tmpl` | systemd unit template (placeholders rendered at install) |
| `coach-aven-sources.service.tmpl`, `nginx-sources.conf.example` | optional: `orch sources serve` as a second unit behind nginx |
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

- SSH access to **both** `deployer@<host>` and `root@<host>`
  (`root` to install the unit + sudoers; `deployer` runs the service + owns files).
  Uses your default SSH keys/agent.
- Your ops repo cloned at `infra/<slug>/` with `deploy.env`, `.env`, `github-app-private-key.pem`,
  `projects.config.json` present (from `ops.example/`, or pull a running box with
  `npm run ops -- <slug> import`).
- Node 22 + git on the box.

## Deploy (first time)

```bash
npm run ops -- <slug> install   # root: REMOTE_DIR + systemd unit (enabled, not started)
                                #       + narrow sudoers for deployer + journal-read group
npm run ops -- <slug> export    # push ops repo, upload → .env, GitHub App key, projects.config.json, projects.d/
npm run ops -- <slug> deploy    # upload code, npm ci, restart, health-check Socket Mode
```

## Updates

```bash
npm run ops -- <slug> deploy    # re-upload code → npm ci → restart → health-check
```

`deploy` ships **code only**. It never overwrites the server's `.env`, GitHub key,
`projects.config.json`, or the orchestrator's `state.json` (server-owned, survives
releases).

Change a secret or the project list in the ops checkout → commit → `export` → `restart`
(`.env` is read at boot; the project list is read at boot and re-read by `/aven reload` for
new sessions only).

## Day-2 commands

All take the slug first: `npm run ops -- <slug> <command>` (no slug → the help and the slugs found).

| Command | What it does |
| --- | --- |
| `deploy` | Release: upload → `npm ci` → restart → health-check |
| `export` | Push the ops repo, upload `infra/<slug>/` → the box |
| `import` | Pull the box's runtime back into the ops checkout, show the drift |
| `status` | `systemctl status` + `is-active` |
| `logs` | Tail the service journal (`journalctl -u <service> -f`) |
| `restart` | Restart the service (deployer, via scoped sudoers) |
| `start` / `stop` | Start / stop the service |
| `ssh` | Interactive shell on the box (deployer) |
| `down` | Stop **and disable** the service (root) |

## Releases (CI/CD)

Two repositories, two jobs:

- **This repo releases.** Pushing a `vX.Y.Z` tag runs
  [`.github/workflows/release.yml`](../../.github/workflows/release.yml): typecheck, tests and
  the two guards, then a GitHub Release whose notes are generated from the merged PR titles.
  Then, if the operator configured it, one `repository_dispatch` (`coach-aven-release`,
  payload `{tag}`) to the operator's ops repo. This repo holds **no deploy key, no deploy
  target, no environment** — a fork cuts releases just the same, the dispatch is skipped.
- **Your ops repo deploys.** [`ops.example/workflows/deploy.yml`](ops.example/workflows/deploy.yml)
  is the whole deploy workflow: by hand with a tag (`workflow_dispatch`) — the normal path — or
  on that dispatch, it checks out this repo at the tag and itself at `infra/<slug>/` beside it,
  installs its own deployer key and runs `deploy.sh <slug> deploy` (upload → `npm ci` → restart →
  health-check), reading the target from its own `deploy.env`. Tags only — a branch or a sha is
  refused. Deploys are queued, never overlapped. Rollback = deploy the previous tag.

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

## Runtime token note

The app resolves its Claude token from `CLAUDE_CODE_OAUTH_TOKEN` in the installation's runtime
`.env` (`infra/<slug>/.env`, uploaded by `export`) — a stable `claude setup-token`
value, recommended for an unattended service. The `~/.claude` credentials fallback is
for dev boxes only; don't rely on it here.

## What this is NOT (yet)

- No public URL by default — Socket Mode only; the bot is reachable from Slack, not
  the web (OAuth installs and `sources serve` are the opt-in exceptions).
- State is a JSON file on the box (`REMOTE_DIR/state.json`) — snapshot it
  if you need a backup.
