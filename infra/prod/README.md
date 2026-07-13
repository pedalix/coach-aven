# CoachAven prod — deploy onto the shared `aven-prod` VM

A **manual, scripted** deployment of the CoachAven orchestrator onto the existing
Hetzner VM **`aven-prod` (<bot-host>)** — the same box that hosts Lumora and
`aven.guru`. CoachAven runs as a **systemd service**, not in Docker.

## Why systemd and not Docker / nginx

CoachAven is just the **control plane**: one long-lived Node process that holds a
Slack **Socket-Mode** connection and drives sandboxes (Daytona over HTTPS; ssh-docker on lumora-one via SSH). All
the heavy work (Claude Code, Sail stacks, builds) happens **inside Daytona**, not
on this box — so the footprint here is tiny.

- **No nginx, no ports, no TLS.** Socket Mode dials *out* to Slack, so nothing
  touches the host's shared `80/443` (owned by Lumora + `aven.guru`).
- **No Docker.** A plain systemd unit (`Restart=always`) is the whole runtime.
  `tsx` runs as a Node `--import` loader, so the service's main PID is `node` and
  systemd's SIGTERM reaches the app directly.

```
   Slack  ⇄ (outbound WebSocket, Socket Mode)
              │
   systemd: coach-aven.service   (User=deployer, WorkingDirectory=/var/www/coach-aven)
     node --import tsx src/cli.ts slack
              │  HTTPS
              ▼
   Daytona (<daytona-host>) ── one warm sandbox per project, worktree per task
```

## Files

| Path | Role |
| --- | --- |
| `deploy.sh` | install / export·import / deploy / logs / status / start·stop·restart / ssh / down |
| `coach-aven.service.tmpl` | systemd unit template (placeholders rendered at install) |
| `.env.example` | deploy-target config (host, users, remote dir, service name) |
| `.env` | filled-in target config (gitignored; copy from `.env.example`) |
| `runtime/` | **prod's** runtime secrets/config (gitignored) — see below |

The app's **runtime** secrets/config live in **`infra/prod/runtime/`** — a separate,
gitignored copy of `.env`, `github-app-private-key.pem`, `projects.config.json` that
is the **prod truth**, deliberately kept apart from the repo-root files (those are
your **local-dev** runtime, per [`../../docs/local-dev.md`](../../docs/local-dev.md)).
`export` uploads `runtime/` to the box; `import` pulls the box's live copies back into
it. To populate it from a running prod, just `npm run prod:import`.

## Prerequisites

- SSH access to **both** `deployer@<bot-host>` and `root@<bot-host>`
  (`root` to install the unit + sudoers; `deployer` runs the service + owns files).
  Uses your default SSH keys/agent.
- `infra/prod/.env` filled in (`cp .env.example .env`).
- The prod runtime files present in `infra/prod/runtime/`: `.env`,
  `github-app-private-key.pem`, `projects.config.json` (copy from
  `runtime/.env.example`, or pull a running prod with `npm run prod:import`).

The box already has system Node 22 + git, so nothing to provision.

## Deploy (first time)

```bash
npm run prod:install         # root: REMOTE_DIR + systemd unit (enabled, not started)
                             #       + narrow sudoers for deployer + journal-read group
npm run prod:export          # upload infra/prod/runtime/ → .env, GitHub App key, projects.config.json
npm run prod:deploy          # upload code, npm ci, restart, health-check Socket Mode
```

## Updates

```bash
npm run prod:deploy          # re-upload code → npm ci → restart → health-check
```

`deploy` ships **code only**. It never overwrites the server's `.env`, GitHub key,
`projects.config.json`, or the orchestrator's `state.json` (server-owned, survives
releases).

Change a secret or the project list (`infra/prod/runtime/`) then `export` → `restart`.
Note: `projects.config.json` is read **once at boot** — editing the project list always
needs a `restart` to take effect, even when no env var changed. `import` is the reverse
of `export`: pull the box's live runtime back into `infra/prod/runtime/` (e.g. to capture
a change made directly on the box, or to seed the dir on a fresh clone).

## Day-2 commands

| Command | What it does |
| --- | --- |
| `npm run prod:deploy` | Release: upload → `npm ci` → restart → health-check |
| `npm run prod:export` | Upload `infra/prod/runtime/` → the box (alias: `prod:push-secrets`) |
| `npm run prod:import` | Pull the box's runtime back into `infra/prod/runtime/` |
| `npm run prod:status` | `systemctl status` + `is-active` |
| `npm run prod:logs` | Tail the service journal (`journalctl -u coach-aven -f`) |
| `npm run prod:restart` | Restart the service (deployer, via scoped sudoers) |
| `npm run prod:start` / `prod:stop` | Start / stop the service |
| `npm run prod:ssh` | Interactive shell on the VM (deployer) |
| `npm run prod:down` | Stop **and disable** the service (root) |

## Releases (CI/CD)

Deploys also run automatically from GitHub Actions
([`.github/workflows/release.yml`](../../.github/workflows/release.yml)) — the manual
`npm run prod:deploy` above still works and is unchanged. The pipeline is
**tag-triggered**: pushing a `vX.Y.Z` tag typechecks the code, publishes a GitHub Release
from the matching [`CHANGELOG.md`](../../CHANGELOG.md) section, then SSHes into the box and
runs `deploy.sh deploy` (upload → `npm ci` → restart → health-check). It uses only the
**deployer** key — never root — so `deploy.sh`'s preflight is split accordingly.

Cut a release:

```bash
# 1. Move the CHANGELOG "Unreleased" notes under "## [X.Y.Z] - YYYY-MM-DD"
# 2. Bump "version" in package.json to X.Y.Z; commit; merge to main
git tag vX.Y.Z && git push origin vX.Y.Z      # tag push → release + deploy
```

`workflow_dispatch` can also deploy an arbitrary ref by hand (no release is cut).

**One-time setup** (GitHub → Settings → Environments → **production**):

| Secret | Value |
| --- | --- |
| `DEPLOY_SSH_KEY` | Passphrase-less private key for `deployer@<box>` |
| `DEPLOY_ENV` | The full contents of `infra/prod/.env` (host, users, remote dir, service name) |

CI deploys **code only**, exactly like the manual path — it never touches the box's
runtime secrets, `projects.config.json`, or `state.json`. Changing the project list or a
secret is still `npm run prod:export` → `restart`.

## Runtime token note

The app resolves its Claude token from `CLAUDE_CODE_OAUTH_TOKEN` in the prod runtime
`.env` (`infra/prod/runtime/.env`, uploaded by `export`) — a stable `claude setup-token`
value, recommended for an unattended service. The `~/.claude` credentials fallback is
for dev boxes only; don't rely on it here.

## What this is NOT (yet)

- No nginx / public URL — Socket Mode only; the bot is reachable from Slack, not
  the web.
- State is a JSON file on the box (`/var/www/coach-aven/state.json`) — snapshot it
  if you need a backup.
