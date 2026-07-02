# Local dev setup

How to run CoachAven on your machine **without colliding with prod**. Prod runs as
a systemd service on the shared `lumora-one` VM (see [`../infra/prod/README.md`](../infra/prod/README.md));
your laptop and prod hit the **same Daytona** and could hit the **same Slack app**,
so the whole point of this guide is isolating those two.

## Why isolation matters (read this first)

Two shared resources will bite you if you don't isolate them:

1. **Slack (Socket Mode).** Slack delivers each event to **only one** connected
   socket. If your local bot uses prod's Slack app, it steals ~half of prod's
   events — prod silently half-breaks. → **Use a separate dev Slack app.**
2. **Daytona sandboxes.** Sandboxes are named `proj-<slug>`. Same slug on the same
   Daytona = the **same warm sandbox**, so local and prod would trample each
   other's worktrees. → **Use a sandbox name prefix** (`dev-proj-`).

Everything else (Daytona creds, Claude token, the GitHub App, the Grafana token)
is fine to share with prod for dev.

## Prerequisites

- **Node 22+** and **git**.
- **Claude Code** installed and logged in (`claude` on your PATH) — or a
  `claude setup-token` value. The orchestrator falls back to your `~/.claude`
  credentials if `CLAUDE_CODE_OAUTH_TOKEN` is blank.
- Access to the shared **Daytona** (`<daytona-host>`) — API key + org id.
- The **GitHub App private key** (`github-app-private-key.pem`) at the repo root.

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

Create one channel per project you want to test, named **`dev-bluefin-aven-<slug>`**
(e.g. `dev-bluefin-aven-caldora`), and invite the dev bot. Channels auto-bind to the
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
| `SLACK_CHANNEL_PREFIX` | `dev-bluefin-aven-` | bot only answers in dev channels |
| `SANDBOX_NAME_PREFIX` | `dev-proj-` | dev sandboxes never collide with prod's `proj-<slug>` |
| `DAYTONA_*` | same as prod | shared Daytona |
| `CLAUDE_CODE_OAUTH_TOKEN` | blank (uses `~/.claude`) or a `setup-token` | — |
| `GITHUB_APP_ID` / `GITHUB_APP_PRIVATE_KEY_PATH` | same as prod | shared App |

> `SLACK_*` are left **blank** in the committed-example/dev `.env` on purpose, so
> `orch slack` refuses to run until you've created the dev app. Fill them in last.

## Run

```bash
npm run orch -- slack                  # start the dev bot (Socket Mode)
# you should see: "Slack bot running (Socket Mode) — N project(s)"
```

Then post in a `dev-bluefin-aven-<slug>` channel. Sandboxes are created/warmed on demand
(first message per project); the Daytona snapshot is ensured on first use too.

## State

`state.json` (gitignored) is your **local** runtime journal (sandboxes, thread→
session bindings) — completely separate from prod's copy on the box. If it ever
gets weird, just delete it; the bot re-derives everything (you only lose
thread→session resume history). Starting fresh is the default for a new clone.

## Gotchas

- **Never run local with prod's Slack tokens** while prod is up — see the Socket
  Mode warning above.
- **Don't ship `state.json` to prod.** `infra/prod/deploy.sh` deliberately never
  uploads it; prod owns its own.
- A `dev-proj-<slug>` sandbox is a *real* sandbox on the shared Daytona — it counts
  against the same resources. Stop/remove dev sandboxes you're done with via the
  Daytona dashboard.
