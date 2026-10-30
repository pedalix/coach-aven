# Local dev setup

How to run CoachAven on your machine **without colliding with prod**. Prod runs as
a systemd service on the bot host (see [`../infra/deploy/README.md`](../infra/deploy/README.md));
your laptop and prod could hit the **same Slack app** and, if you point your dev bot at
prod's sandbox host, the **same Docker host**, so the whole point of this guide is
isolating those two.

## Why isolation matters (read this first)

Two shared resources will bite you if you don't isolate them:

1. **Slack (Socket Mode).** Slack delivers each event to **only one** connected
   socket. If your local bot uses prod's Slack app, it steals ~half of prod's
   events — prod silently half-breaks. → **Use a separate dev Slack app.**
2. **Sandbox containers.** Sandboxes are containers named `proj-<slug>` on the Docker
   host `SSHDOCKER_HOST` names. They collide only when your dev bot and prod share that
   host: there, the same slug is the **same container**, so local and prod would trample
   each other's worktrees, and one bot's idle stop could end the other's sessions (the
   idle stop and a wake's cleanup assume one bot per container). → **Keep dev sandboxes
   on a Docker host no other installation uses** (`SSHDOCKER_HOST=local` on your machine,
   the template's value); **on a host another installation also uses, set a distinct
   name prefix** (`dev-proj-`).
   `SANDBOX_MANAGED_BY` — the label your bot's containers carry and its `/aven status`
   listing filter — may differ too (say `coach-aven-dev`), but it does not keep the two
   apart on its own: containers are chosen by name, so the prefix does.

Everything else (Claude token, the GitHub App, the Grafana token) is fine to share with
prod for dev.

## Prerequisites

- **Node 22+** and **git**.
- **Claude Code** installed and logged in (`claude` on your PATH) — or a
  `claude setup-token` value. The orchestrator falls back to your `~/.claude`
  credentials if `CLAUDE_CODE_OAUTH_TOKEN` is blank.
- **Docker** on your machine, for the sandboxes (`SSHDOCKER_HOST=local`) — or key-based
  SSH to a Docker host (`docs/sandbox-drivers.md`, *Host prerequisites*). The image
  `SNAPSHOT_IMAGE` names must be one that host can pull (`snapshot/README.md`).
- The **GitHub App private key** (`github-app-private-key.pem`) at the repo root.

`.env`, `projects.config.json` and the state the bot writes (`state.json`, `queue.jsonl`, `usage/`, …) live
in the checkout unless `AVEN_DIR` names another directory (`docs/runtime-config.md` → *Installation
directory*); the working directory you start from never matters.

## Tools to create BEFORE the first run

### 1. A dedicated dev Slack app (required for `orch slack`)

1. https://api.slack.com/apps → **Create New App** → **From an app manifest**.
2. Pick the workspace, paste [`../slack-app-manifest.json`](../slack-app-manifest.json),
   create. Name it so it's obviously dev (e.g. `CoachAven (dev)`).
3. **Install to Workspace** → copy the **Bot User OAuth Token** (`xoxb-…`).
4. **Basic Information → App-Level Tokens** → generate one with the
   `connections:write` scope → copy it (`xapp-…`). (Socket Mode needs this.)
5. **Socket Mode** → enable.

### 2. Dev Slack channels

Create one channel per project you want to test, named **`dev-aven-<slug>`**
(e.g. `dev-aven-caldora`), and invite the dev bot. Channels auto-bind to the
project by name via `SLACK_CHANNEL_PREFIX` — no channel IDs to wire.

### 3. (Recommended) a throwaway repo for `projects.config.json`

Dev tasks open **real PRs** against whatever repos a project lists. Point your dev
`projects.config.json` at a sandbox/test repo so you don't open PRs against
production repositories.

## Configure

```bash
npm install
cp .env.example .env                                   # then edit, see below
cp projects.config.example.json projects.config.json   # your dev projects
```

Set these in your local `.env` (the rest can mirror prod):

| Var | Dev value | Why |
|---|---|---|
| `SLACK_BOT_TOKEN` | your **dev** app `xoxb-…` | separate Slack app |
| `SLACK_APP_TOKEN` | your **dev** app `xapp-…` | separate Slack app |
| `SLACK_CHANNEL_PREFIX` | `dev-aven-` | bot only answers in dev channels |
| `SANDBOX_DRIVER` | `ssh-docker` | the only driver; keep the line written out (`docs/sandbox-drivers.md`) |
| `SSHDOCKER_HOST` | `local` | dev sandboxes on your own Docker, apart from prod's |
| `SANDBOX_NAME_PREFIX` | `dev-proj-` | required when another installation uses the same Docker host: dev containers never collide with its `proj-<slug>` |
| `CLAUDE_CODE_OAUTH_TOKEN` | blank (uses `~/.claude`) or a `setup-token` | — |
| `GITHUB_APP_ID` / `GITHUB_APP_PRIVATE_KEY_PATH` | same as prod | shared App |

> `SLACK_*` are left **blank** in the committed-example/dev `.env` on purpose, so
> `orch slack` refuses to run until you've created the dev app. Fill them in last.

## Run

```bash
npm run orch -- slack                  # start the dev bot (Socket Mode)
# you should see: "Slack bot running (Socket Mode) — N project(s)"
```

Then post in a `dev-aven-<slug>` channel. Sandboxes are created/warmed on demand
(first message per project); the first one pulls `SNAPSHOT_IMAGE` onto the Docker host,
which can take minutes.

## State

`state.json` (gitignored) is your **local** runtime journal (sandboxes, thread→
session bindings) — completely separate from prod's copy on the box. If it ever
gets weird, just delete it; the bot re-derives everything (you only lose
thread→session resume history). Starting fresh is the default for a new clone.

## Gotchas

- **Never run local with prod's Slack tokens** while prod is up — see the Socket
  Mode warning above.
- **Don't ship `state.json` to prod.** `infra/deploy/deploy.sh` deliberately never
  uploads it; prod owns its own.
- A dev sandbox is a *real* container, and on a shared host it counts against prod's
  memory and disk. The idle stop stops it after `SANDBOX_AUTOSTOP_MINUTES`; remove the
  ones you're done with on their Docker host: `docker rm -f dev-proj-<slug>` (or
  `proj-<slug>` on your own machine). Nothing in the bot deletes a sandbox.
