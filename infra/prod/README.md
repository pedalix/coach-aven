# CoachAven prod — deploy onto the shared `lumora-one` VM

A **manual, scripted** deployment of the CoachAven orchestrator onto the existing
Hetzner VM **`lumora-one` (<sandbox-host>)** — the same box that hosts Lumora and
`aven.guru`. CoachAven runs as a **systemd service**, not in Docker.

## Why systemd and not Docker / nginx

CoachAven is just the **control plane**: one long-lived Node process that holds a
Slack **Socket-Mode** connection and drives **Daytona** sandboxes over HTTPS. All
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
| `deploy.sh` | install / push-secrets / deploy / logs / status / start·stop·restart / ssh / down |
| `coach-aven.service.tmpl` | systemd unit template (placeholders rendered at install) |
| `.env.example` | deploy-target config (host, users, remote dir, service name) |
| `.env` | filled-in target config (gitignored; copy from `.env.example`) |

The app's **runtime** secrets/config are NOT here — they live at the repo root
(`.env`, `github-app-private-key.pem`, `projects.config.json`) and are uploaded
by `push-secrets`.

## Prerequisites

- SSH access to **both** `deployer@<sandbox-host>` and `root@<sandbox-host>`
  (`root` to install the unit + sudoers; `deployer` runs the service + owns files).
  Uses your default SSH keys/agent.
- `infra/prod/.env` filled in (`cp .env.example .env`).
- The repo-root runtime files present and filled in: `.env`,
  `github-app-private-key.pem`, `projects.config.json`.

The box already has system Node 22 + git, so nothing to provision.

## Deploy (first time)

```bash
npm run prod:install         # root: REMOTE_DIR + systemd unit (enabled, not started)
                             #       + narrow sudoers for deployer + journal-read group
npm run prod:push-secrets    # upload .env, the GitHub App key, projects.config.json
npm run prod:deploy          # upload code, npm ci, restart, health-check Socket Mode
```

## Updates

```bash
npm run prod:deploy          # re-upload code → npm ci → restart → health-check
```

`deploy` ships **code only**. It never overwrites the server's `.env`, GitHub key,
`projects.config.json`, or the orchestrator's `state.json` (server-owned, survives
releases). Rotate secrets with `push-secrets` then `restart`.

## Day-2 commands

| Command | What it does |
| --- | --- |
| `npm run prod:deploy` | Release: upload → `npm ci` → restart → health-check |
| `npm run prod:status` | `systemctl status` + `is-active` |
| `npm run prod:logs` | Tail the service journal (`journalctl -u coach-aven -f`) |
| `npm run prod:restart` | Restart the service (deployer, via scoped sudoers) |
| `npm run prod:start` / `prod:stop` | Start / stop the service |
| `npm run prod:ssh` | Interactive shell on the VM (deployer) |
| `npm run prod:down` | Stop **and disable** the service (root) |

## Runtime token note

The app resolves its Claude token from `CLAUDE_CODE_OAUTH_TOKEN` in the repo-root
`.env` (a stable `claude setup-token` value — recommended for an unattended
service). The `~/.claude` credentials fallback is for dev boxes only; don't rely
on it here.

## What this is NOT (yet)

- No CI/CD — releases are manual (`npm run prod:deploy`), by design.
- No nginx / public URL — Socket Mode only; the bot is reachable from Slack, not
  the web.
- State is a JSON file on the box (`/var/www/coach-aven/state.json`) — snapshot it
  if you need a backup.
