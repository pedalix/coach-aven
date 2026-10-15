# CoachAven prod — deploy onto a plain Linux host

A **manual, scripted** deployment of the CoachAven orchestrator onto one Linux box with
systemd and ssh (any small VM does; it shares fine with other services). CoachAven runs as a
**systemd service**, not in Docker. Where *your* box is, who runs on it and what it talks to
belongs in **your ops repo** (below), not in this file.

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
| `deploy.sh` | install / export·import / deploy / logs / status / start·stop·restart / ssh / down |
| `coach-aven.service.tmpl` | systemd unit template (placeholders rendered at install) |
| `coach-aven-sources.service.tmpl`, `nginx-sources.conf.example` | optional: `orch sources serve` as a second unit behind nginx |
| `.env.example` | deploy-target config (host, users, remote dir, service name) |
| `.env` | filled-in target config (gitignored; copy from `.env.example`) |
| `runtime/` | **your ops repo**, checked out here (gitignored) — see below |
| `runtime.example/` | template for starting that repo |

## `runtime/` is your ops repo

The app's runtime config — `projects.config.json`, `projects.d/<slug>.md` prompts — plus the
two secret files `.env` and `github-app-private-key.pem` live in **`infra/prod/runtime/`**,
deliberately apart from the repo-root files (those are your **local-dev** runtime, per
[`../../docs/local-dev.md`](../../docs/local-dev.md)).

That directory is a **git checkout of a private repository of yours** — the *ops overlay*:
the place for everything that describes your installation and must never enter this public
repo (project list, prompts, host topology, operator notes, customer specifics). The two
secret files sit in the checkout but are ignored by its `.gitignore`; they travel by scp only.
Start one from [`runtime.example/`](runtime.example/README.md).

- `npm run prod:export` — refuses while the checkout is dirty, **pushes it**, then uploads the
  runtime files to the box. The ops repo, not a laptop, is the record of what prod runs.
- `npm run prod:import` — pulls the box's live copies back into the checkout and shows the
  drift as `git status`, for you to commit (a change made directly on the box, or seeding a
  fresh clone).

The pattern is the usual app-repo / ops-repo split: this repo documents the mechanism, yours
holds the instance. The rule of thumb for what goes where: a line a stranger self-hosting
would need is public; a line naming your host, customer or a person is ops.

## Prerequisites

- SSH access to **both** `deployer@<host>` and `root@<host>`
  (`root` to install the unit + sudoers; `deployer` runs the service + owns files).
  Uses your default SSH keys/agent.
- `infra/prod/.env` filled in (`cp .env.example .env`).
- Your ops repo cloned at `infra/prod/runtime/` with `.env`, `github-app-private-key.pem`,
  `projects.config.json` present (from `runtime.example/`, or pull a running prod with
  `npm run prod:import`).
- Node 22 + git on the box.

## Deploy (first time)

```bash
npm run prod:install         # root: REMOTE_DIR + systemd unit (enabled, not started)
                             #       + narrow sudoers for deployer + journal-read group
npm run prod:export          # push ops repo, upload runtime/ → .env, GitHub App key, projects.config.json, projects.d/
npm run prod:deploy          # upload code, npm ci, restart, health-check Socket Mode
```

## Updates

```bash
npm run prod:deploy          # re-upload code → npm ci → restart → health-check
```

`deploy` ships **code only**. It never overwrites the server's `.env`, GitHub key,
`projects.config.json`, or the orchestrator's `state.json` (server-owned, survives
releases).

Change a secret or the project list in the ops checkout → commit → `export` → `restart`
(`.env` is read at boot; the project list is read at boot and re-read by `/aven reload` for
new sessions only).

## Day-2 commands

| Command | What it does |
| --- | --- |
| `npm run prod:deploy` | Release: upload → `npm ci` → restart → health-check |
| `npm run prod:export` | Push the ops repo, upload `infra/prod/runtime/` → the box |
| `npm run prod:import` | Pull the box's runtime back into the ops checkout, show the drift |
| `npm run prod:status` | `systemctl status` + `is-active` |
| `npm run prod:logs` | Tail the service journal (`journalctl -u coach-aven -f`) |
| `npm run prod:restart` | Restart the service (deployer, via scoped sudoers) |
| `npm run prod:start` / `prod:stop` | Start / stop the service |
| `npm run prod:ssh` | Interactive shell on the box (deployer) |
| `npm run prod:down` | Stop **and disable** the service (root) |

## Releases (CI/CD)

Deploys also run automatically from GitHub Actions
([`.github/workflows/release.yml`](../../.github/workflows/release.yml)) — the manual
`npm run prod:deploy` above still works and is unchanged. The pipeline is
**tag-triggered**: pushing a `vX.Y.Z` tag typechecks and tests the code, publishes a GitHub
Release whose notes are generated from the merged PR titles, then SSHes into the box and
runs `deploy.sh deploy` (upload → `npm ci` → restart → health-check). It uses only the
**deployer** key — never root — so `deploy.sh`'s preflight is split accordingly.

Cut a release (no changelog or version edits — the tag is the version of record):

```bash
git tag vX.Y.Z && git push origin vX.Y.Z      # tag push → release + deploy
```

`workflow_dispatch` can also deploy by hand (no release is cut) — run it from a `v*` tag; the environment policy refuses branch refs.

**One-time setup** (GitHub → Settings → Environments → **production**). Protect the
environment: a required reviewer and a deployment branch policy that allows **tags `v*`
only**, so no branch or fork can reach these secrets.

| Secret | Value |
| --- | --- |
| `DEPLOY_SSH_KEY` | Passphrase-less private key for `deployer@<host>` |
| `DEPLOY_ENV` | The full contents of `infra/prod/.env` (host, users, remote dir, service name) |

CI deploys **code only**, exactly like the manual path — it never touches the box's
runtime secrets, `projects.config.json`, or `state.json`. Changing the project list or a
secret is still `export` → `restart`.

## Runtime token note

The app resolves its Claude token from `CLAUDE_CODE_OAUTH_TOKEN` in the prod runtime
`.env` (`infra/prod/runtime/.env`, uploaded by `export`) — a stable `claude setup-token`
value, recommended for an unattended service. The `~/.claude` credentials fallback is
for dev boxes only; don't rely on it here.

## What this is NOT (yet)

- No public URL by default — Socket Mode only; the bot is reachable from Slack, not
  the web (OAuth installs and `sources serve` are the opt-in exceptions).
- State is a JSON file on the box (`REMOTE_DIR/state.json`) — snapshot it
  if you need a backup.
