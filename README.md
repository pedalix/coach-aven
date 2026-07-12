# CoachAven

A Slack coding agent that runs per-project, isolated **Claude Code** sandboxes on our
self-hosted **Daytona**, driven by a small TypeScript control program. One warm sandbox per
project; the agent reads and edits the repo and opens PRs, reachable from a Slack channel.
No AgentBox, no S3, no SSH gateway.

> Extracted from `bluefin-infra/daytona/orchestrator` into its own repo. Run with
> `npm install && npm run orch -- slack` (see `.env.example` + `projects.config.example.json`).

**Model:** one warm **sandbox per project** (a `docker:28-dind`-based image with git/gh/Node +
Claude Code), N parallel **tasks per project via `git worktree`** (each task = own branch +
own `COMPOSE_PROJECT_NAME`, so Sail stacks don't collide). The repos are `git clone`d *inside*
the box (no upload); each Slack thread/DM drives a persistent Claude Code process over the
Daytona toolbox (stream-json), and the agent pushes and opens a PR.

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
  cli.ts            # commander CLI (the `slack` command)
  slack.ts          # composition root: engine + resolvers + handlers + pollers
  turn.ts           # turn engine: queues, live status, agent questions, restart recovery
  events.ts         # @mentions, thread replies, DMs, buttons, App Home
  commands.ts       # the /aven router + subcommands
  pollers.ts        # scheduler + auto-review / autofix / YouTrack pollers
  blocks.ts         # every Block Kit renderer + user-facing text helpers
  channels.ts       # channel ↔ project resolution
  tasks.ts          # chat session over a sandbox; the 3-layer system prompt
  claudeSession.ts  # the persistent claude process (stream-json protocol)
  project.ts        # clone, worktrees, auth/MCP seeding into the sandbox
  daytona.ts        # SDK client: ensureSnapshot / ensureSandbox / exec
  github.ts         # GitHub App tokens + PR/CI reads
  state.ts          # single-file state.json store
  config.ts         # env loading
  …plus pure logic modules with tests beside them (schedule, pr, youtrack, dream,
  format, attachments, memory, memjournal, mcp, prompts)
```

## Why no PHP/Composer in the image

With DinD + Laravel **Sail**, the Laravel runtime lives in the *project's own* containers at
the project's own versions. Host PHP/Composer would be the wrong version and never used.
**Node stays** — only because Claude Code is an npm package (the app's JS still runs via
`sail npm`). Bare `php`/`composer`/`artisan` are shimmed to forward into the Sail container
(and `composer` bootstraps via a throwaway container when `vendor/` doesn't exist yet).

## Setup

### Snapshot image

The sandbox tooling (git, gh, node, Claude Code, sail shims, imagemagick) is **baked into
the image** (`snapshot/Dockerfile`); `provisionTooling()` at chat-prep only tops up
additions newer than the running fleet's image. To rebuild and roll a new image:

```bash
echo "$GHCR_PAT" | docker login ghcr.io -u <you> --password-stdin   # needs write:packages
cd snapshot && ./build-and-push.sh        # pushes :<gitsha> and :latest
```

Point `SNAPSHOT_IMAGE` at the **`:<gitsha>` tag** the script prints (pin it — `:latest`
tells you nothing about what the fleet actually runs) and set a new `SNAPSHOT_NAME`; the
snapshot is created on next boot (`ensureSnapshot`). Existing warm sandboxes keep their
old image until recreated. (If the GHCR package is private, the Daytona runner needs pull
creds — make it public or add a registry pull secret to the runner.)

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
| `.env` | you | secrets + infra (access) | `DAYTONA_*`, `SNAPSHOT_*`, `SANDBOX_*`, `CLAUDE_CODE_OAUTH_TOKEN`, `GITHUB_APP_*` / `GITHUB_TOKEN`, `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`, `SLACK_CLIENT_ID`/`SECRET`/`STATE_SECRET` (multi-workspace OAuth, optional), `PROJECTS_CONFIG_PATH` |
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
# run the Slack bot (one bot, many channels; channel→project)
cp projects.config.example.json projects.config.json   # list projects (slug + repos)
# create a Slack channel `bluefin-aven-<slug>` per project — it auto-binds by name
npm run orch -- slack
```

### Multi-workspace installs (OAuth, optional)

Set `SLACK_CLIENT_ID` + `SLACK_CLIENT_SECRET` + `SLACK_STATE_SECRET` (see `.env.example`) and
the bot switches to OAuth mode: it serves `http://<host>:3000/slack/install` (override with
`SLACK_OAUTH_PORT`) and other workspaces can install it from that link — enable **Public
Distribution** in the Slack app admin and register your public
`https://<host>/slack/oauth_redirect` URL there (the manifest carries a placeholder; each
app — dev, prod — registers its own). Per-workspace bot tokens land in `state.json` →
`installations` (that's why it's written `0600`); events for all workspaces keep riding the
one Socket Mode connection, so the HTTP port is only for the install handshake. Our own
workspace is seeded from `SLACK_BOT_TOKEN` on first boot and stays the home of alerts and
operator commands. Local dev: a tunnel (e.g. `ngrok http 3000`) is the easiest redirect URL.

**Per-workspace projects (slice 2).** The optional top-level `workspaces` block in
`projects.config.json` maps each Slack team id to the project slugs it may see and drive:

```jsonc
"workspaces": { "T0YOURHOME1": ["caldora", "dorfberg-monitoring"], "T0CLIENT001": ["dorfberg-monitoring"] }
```

No block = single-tenant back-compat (the home workspace owns everything). With the block,
membership is explicit-only: every resolution (channels, DM picker, App Home, `/aven`,
PR refs) happens inside the calling workspace's subset; an installed-but-unmapped
workspace gets an onboarding App Home + one polite reply (`AVEN_CONTACT` names who to
contact). Session keys and every persisted record carry the owning team (bare/absent =
home), so pollers, routines and restart recovery post with the right workspace's token —
and per-tenant export/offboarding (`Store.exportTenant`/`purgeTenant`) is a field filter.
A slug may appear under several teams (the data model allows sharing; pollers then act
for the first team listing it — the "owner"). ⚠️ Admit a client team only AFTER this
version is deployed: earlier records are keyed without a team and would orphan.

Everything else — building, PR reviews, scheduled digests, memory, ticket
investigations — is driven from Slack; the bot's App Home tab is the user-facing
cheat-sheet.

### GitHub token scoping

`getGitHubToken()` mints an installation token **scoped to only the project's repo(s)**
(`repositoryNames`) + least-privilege permissions (contents + pull_requests write, metadata read),
so the org-wide App still yields a per-sandbox token limited to that project.

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
npm run prod:export         # upload infra/prod/runtime/ → .env, github-app-private-key.pem, projects.config.json
npm run prod:deploy         # upload code, npm ci, restart, health-check Socket Mode

npm run prod:import         # reverse of export: pull the box's runtime into infra/prod/runtime/
npm run prod:logs           # journalctl -u coach-aven -f
npm run prod:status         # systemctl status + is-active
npm run prod:restart        # / prod:stop / prod:start / prod:down
```

The app's runtime secrets/config live in **`infra/prod/runtime/`** (gitignored, prod truth) —
kept separate from the repo-root `.env`/`projects.config.json`, which are your **local dev**.
`deploy` ships **code only** — it never overwrites the server's `.env`, GitHub key,
`projects.config.json`, or `state.json` (server-owned, survives releases). Change a secret or
the project list in `infra/prod/runtime/`, then `export` → `restart` (the project list is read
once at boot, so a restart is always required for it to take effect).

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

- **GitHub token lifetime** ≈ 1h. Every chat prep re-mints and re-seeds it (and `cloneRepo`
  heals tokens baked into remote URLs); a single agent turn that exceeds an hour could still
  see a stale token — send another message to re-seed if that bites.
- **Resources**: DinD wants ≥2 vCPU / 4 GiB. ~10 warm project sandboxes each running Sail is
  heavy and the box also runs observability + Archestra — run a few concurrently, not all.
- **Auth seeding** writes the token to `/root/.gh-token` via the toolbox file API (not `echo`),
  so it never lands in command logs. A git credential helper + `gh auth login --with-token`
  read it.
- **State** is a single `state.json` (gitignored). Single-process only for now.
- The orchestrator runs as a systemd service on `lumora-one` (see [Hosting](#hosting-production)).
