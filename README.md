# CoachAven

A Slack coding agent that runs per-project, isolated **Claude Code** sandboxes on our
self-hosted **Daytona**, driven by a small TypeScript control program. One warm sandbox per
project; the agent reads and edits the repo and opens PRs, reachable from a Slack channel.
No AgentBox, no S3, no SSH gateway.

> Extracted from `bluefin-infra/daytona/orchestrator` into its own repo. Run with
> `npm install && npm run orch -- slack` (see `.env.example` + `projects.config.example.json`).

**Model:** one warm **sandbox per project** (a `docker:28-dind`-based image with git/gh/Node +
Claude Code), N parallel **tasks per project via `git worktree`** (each task = own branch +
own `COMPOSE_PROJECT_NAME`, so Sail stacks don't collide). The repo is `git clone`d *inside*
the box (no upload), Claude Code runs via the Daytona toolbox (exec for headless, PTY for
mid-session), then the agent pushes and opens a PR.

## Decisions (locked 2026-06-17)

| Area | Choice |
|---|---|
| Language / API | **TypeScript** + `@daytonaio/sdk` (v0.187.0) |
| Claude Code auth | **`CLAUDE_CODE_OAUTH_TOKEN`** (Claude Max subscription) |
| GitHub auth in-box | **GitHub App** installation tokens (short-lived, re-minted per task) |
| Sandbox lifecycle | **Persistent (warm) per project**; worktree per task |
| Snapshot image | `docker:28-dind` + git + gh + Node + Claude Code (NO PHP/Composer — Sail provides them) → **GHCR** |

## Layout

```
snapshot/
  Dockerfile            # the project sandbox image
  shims/sail-shim.sh    # bare php/composer/artisan → ./vendor/bin/sail
  build-and-push.sh     # build + push to GHCR
src/
  config.ts   # env loading
  state.ts    # JSON state store (projects ↔ sandboxes ↔ tasks)
  github.ts   # mint GitHub App installation token
  daytona.ts  # SDK client: ensureSnapshot / ensureSandbox / exec
  project.ts  # clone, worktree, seed GitHub auth (token written via fs, never echoed)
  agent.ts    # Claude Code: runHeadless (stream-json) + startInteractive (PTY)
  tasks.ts    # runTask end-to-end; attachTask for mid-session messaging
  cli.ts      # commander CLI
```

## Why no PHP/Composer in the image

With DinD + Laravel **Sail**, the Laravel runtime lives in the *project's own* containers at
the project's own versions. Host PHP/Composer would be the wrong version and never used.
**Node stays** — only because Claude Code is an npm package (the app's JS still runs via
`sail npm`). Bare `php`/`composer`/`artisan` are shimmed to forward into the Sail container
(and `composer` bootstraps via a throwaway container when `vendor/` doesn't exist yet).

## Setup

### Snapshot: two modes

- **Now (boot-provisioning):** `SNAPSHOT_NAME=dind-test` (the existing `docker:28-dind`
  snapshot). On first task per sandbox, `provisionTooling()` installs git/gh/node/Claude Code +
  the sail shims at runtime (mirrors the Dockerfile). Zero registry needed — works today.
- **Later (baked image, faster cold-start):** build + push the custom image, point
  `SNAPSHOT_NAME`/`SNAPSHOT_IMAGE` at it, and `provisionTooling()` becomes a no-op:
  ```bash
  echo "$GHCR_PAT" | docker login ghcr.io -u <you> --password-stdin   # needs write:packages
  cd snapshot && IMAGE=ghcr.io/bluefinorg/bluefin-sandbox-laravel ./build-and-push.sh
  npm run orch -- snapshot:ensure
  ```
  (If the GHCR package is private, the Daytona runner needs pull creds — make it public or add
  a registry pull secret to the runner.)

### GitHub auth

The orchestrator clones/pushes/opens PRs as a **GitHub App installation** (preferred) or a
plain token. We reuse the existing **`pedalix-factory`** App (App ID `3215982`, shared with
`agentic-factory-core`) — it has Contents + Pull requests write across the `BluefinOrg` org,
and the installation id is **auto-discovered** from the repo owner. Just set `GITHUB_APP_ID` +
the `.pem` path. (To use a plain token instead, set `GITHUB_TOKEN=$(gh auth token)`.)

Creating a *new* App from scratch (if you ever need one): Org → Settings → Developer settings →
GitHub Apps → New; repository permissions Contents + Pull requests = Read & write, Metadata =
Read; no webhook; generate a private key; install on the org.

### Claude Code token

`claude setup-token` on a Claude Max machine → `CLAUDE_CODE_OAUTH_TOKEN`. (For a quick local
test you can reuse the `accessToken` from `~/.claude/.credentials.json`, but it expires.)

### Config

```bash
cp .env.example .env                                  # secrets + infra (see table below)
cp projects.config.example.json projects.config.json  # the channel→project registry
npm install
```

#### What goes where

Two are **input you edit**; one is **state the orchestrator writes itself**. All three are gitignored.

| File | Who writes | What it is | Holds |
|---|---|---|---|
| `.env` | you | secrets + infra (access) | `DAYTONA_*`, `SNAPSHOT_*`, `SANDBOX_*`, `CLAUDE_CODE_OAUTH_TOKEN`, `GITHUB_APP_*` / `GITHUB_TOKEN`, `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`, `PROJECTS_CONFIG_PATH` |
| `projects.config.json` | you | the channel→project registry | per project: `slug`, `repos[]`, `slackChannel`, `mcp[]`, `env{}` |
| `state.json` | the orchestrator | runtime journal/memory | created sandbox name, default branch, tasks (branch/worktree/status/PR), and Slack `thread/dm → {slug, Claude sessionId}` mappings (for `--resume`) |

Rule of thumb: a **secret or infra endpoint** → `.env`; a **description of a project** (repos, MCP
servers, project env, its bound channel) → `projects.config.json`. You never hand-edit `state.json`
— deleting it just makes the bot re-derive everything (you only lose thread→session history).
One bot serves many channels; **each channel is bound to a project, and each project gets its own
isolated sandbox** (`proj-<slug>`). Channels **auto-bind by name** via the wildcard
`bluefin-aven-{project}` (the `{project}` part is the slug) — no channel ids to wire (an explicit
`slackChannel` id still overrides). Override the prefix with `SLACK_CHANNEL_PREFIX`.

## Usage

```bash
# one-time: create/activate the Daytona snapshot from the GHCR image
npm run orch -- snapshot:ensure

# warm a project sandbox + clone the repo (idempotent)
npm run orch -- project:prepare holidayshop BluefinOrg/holidayshop-dorfberg

# run a task end-to-end (worktree → agent → push → draft PR)
npm run orch -- task:run holidayshop BluefinOrg/holidayshop-dorfberg \
  --prompt "Bring up Sail, run php artisan test, fix any failing tests, open a PR." --draft

# send follow-up messages to a live agent (mid-session)
npm run orch -- task:attach holidayshop <taskId>

# run the Slack bot (one bot, many channels; channel→project) — see ../chat-agent-v1.md
cp projects.config.example.json projects.config.json   # list projects (slug + repos)
# create a Slack channel `bluefin-aven-<slug>` per project — it auto-binds by name
npm run orch -- slack

# inspect state
npm run orch -- project:list
```

### GitHub token scoping

`getGitHubToken()` mints an installation token **scoped to only the project's repo(s)**
(`repositoryNames`) + least-privilege permissions (contents + pull_requests write, metadata read),
so the org-wide App still yields a per-sandbox token limited to that project. See
[`../chat-agent-v1.md`](../chat-agent-v1.md) for the full token model.

## Hosting (production)

Deployed as a **systemd service** on the shared Hetzner VM `lumora-one`, alongside Lumora and
`aven.guru`. It's just the control plane — one long-lived Node process holding a Slack
**Socket-Mode** connection and driving Daytona over HTTPS — so it's tiny, needs **no nginx,
no ports, no TLS** (Socket Mode dials *out*), and never touches the host's shared `80/443`. All
heavy work runs inside Daytona, not on the box.

Manual, scripted deploy (mirrors the `aven` prod pattern). See [`infra/prod/README.md`](infra/prod/README.md).

```bash
cp infra/prod/.env.example infra/prod/.env   # deploy target (host/users/remote dir)
npm run prod:install        # root: REMOTE_DIR + systemd unit (enabled) + scoped sudoers + journal group
npm run prod:push-secrets   # upload .env, github-app-private-key.pem, projects.config.json
npm run prod:deploy         # upload code, npm ci, restart, health-check Socket Mode

npm run prod:logs           # journalctl -u coach-aven -f
npm run prod:status         # systemctl status + is-active
npm run prod:restart        # / prod:stop / prod:start / prod:down
```

`deploy` ships **code only** — it never overwrites the server's `.env`, GitHub key,
`projects.config.json`, or `state.json` (server-owned, survives releases). Rotate secrets with
`push-secrets` then `restart`.

### Local dev vs prod

**Setting up a dev box?** See [`docs/local-dev.md`](docs/local-dev.md) for the full step-by-step.

Both read their own files (dev: local `.env`/`state.json`/`projects.config.json`; prod: the
copies on the box), so most config is already separate **by location**. The only shared external
resources are Slack and Daytona — isolate those in your **local** `.env`:

- **Slack** — use a **separate Slack app** for dev. Socket Mode delivers each event to only one
  connected socket, so a dev bot sharing prod's app would steal ~half of prod's events. Give the
  dev app its own `SLACK_BOT_TOKEN`/`SLACK_APP_TOKEN`, and set `SLACK_CHANNEL_PREFIX=dev-bluefin-aven-`
  so it only answers in dev channels (prod keeps the default `bluefin-aven-`).
- **Daytona** — both hit the same server, so set `SANDBOX_NAME_PREFIX=dev-proj-` locally. Dev
  sandboxes become `dev-proj-<slug>` and never collide with prod's `proj-<slug>` warm sandboxes.
- **Repos** — point dev's `projects.config.json` at a throwaway/test repo so dev tasks don't open
  PRs against real project repos.

Prod (the box) just keeps the defaults — no extra env needed.

## Notes / gotchas

- **GitHub token lifetime** ≈ 1h. `runTask`/`attachTask` re-mint and re-seed it; a single agent
  run that exceeds an hour could see a stale token. Re-seed (`task:attach` re-seeds on connect)
  or shorten tasks if that bites.
- **Resources**: DinD wants ≥2 vCPU / 4 GiB. ~10 warm project sandboxes each running Sail is
  heavy and the box also runs observability + Archestra — run a few concurrently, not all.
- **Auth seeding** writes the token to `/root/.gh-token` via the toolbox file API (not `echo`),
  so it never lands in command logs. A git credential helper + `gh auth login --with-token`
  read it.
- **State** is a single `state.json` (gitignored). Single-process only for now.
- The orchestrator runs as a systemd service on `lumora-one` (see [Hosting](#hosting-production));
  the eventual PM-trigger flow wraps `runTask`.
