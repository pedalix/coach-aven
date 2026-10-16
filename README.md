# CoachAven

A coding agent that lives in Slack. One bot, many channels; each channel is bound to a project,
and each project gets its own warm, isolated sandbox running a persistent **Claude Code**
process. The agent reads the repos, answers questions, runs builds and tests, and opens pull
requests — your team reviews and merges. The bot itself is a small TypeScript control plane
with no model calls of its own: all the thinking happens inside the sandboxes.

Website: [coachaven.com](https://coachaven.com). Status: a single-operator project that runs
two installations for real users; self-hosting is supported and documented, support is
best-effort (see [`CONTRIBUTING.md`](CONTRIBUTING.md), [`SECURITY.md`](SECURITY.md)).
Licence: Apache-2.0.

## How it works

```
 Slack ⇄ (Socket Mode, outbound)
   │
 orchestrator  (Node, one process; state.json; pollers for routines / PR review / tickets)
   │  sandbox driver: Daytona over HTTPS, or containers on your own host over SSH
   ▼
 proj-<slug> sandbox  ── git clone of the project's repos, one worktree per task,
                         a persistent `claude` process per Slack thread (stream-json),
                         MCP servers the project declares (Grafana, Sentry, trackers, …)
```

- **One sandbox per project, one worktree per task.** Tasks are branches; Sail/DinD stacks
  get their own `COMPOSE_PROJECT_NAME`, so parallel tasks do not collide.
- **Three-layer system prompt**: orchestrator base → the project's `projects.d/<slug>.md` →
  the repo's own `CLAUDE.md` (`src/prompt.ts`, golden-tested).
- **Secrets never reach the model**: the GitHub App token is scoped per project and
  re-minted every turn; every user turn and every ingested document is scrubbed
  (`src/scrub.ts`) before it is sent.
- **Git flow per project**: `pr` (default — the agent never pushes to the default branch)
  or `direct`.
- Optional: scheduled routines and reports, auto PR review and autofix, ticket investigations
  (YouTrack/Jira/Asana), per-project ingestion of mail/chat/calendar into a searchable,
  scrubbed store the agent can query (`docs/sources.md`) with an attribution layer that learns from
  people's answers (`docs/attribution.md`), multi-workspace installs over OAuth.

The App Home tab of the bot is the user-facing cheat-sheet for every command and button.

## Self-host quickstart

You need: Node 24 (22.12+ works), a Slack workspace where you can create apps, a GitHub App (or token) for
the repos, a Claude Code token, and a place to run sandboxes.

1. **Slack app** — create it from [`slack-app-manifest.json`](slack-app-manifest.json)
   (Socket Mode on). Note the bot token (`xoxb-…`) and the app-level token (`xapp-…`).
2. **Sandboxes** — pick a driver (`docs/sandbox-drivers.md`):
   - `SANDBOX_DRIVER=sshdocker`: containers on a Docker host you own (also `local`).
   - `SANDBOX_DRIVER=daytona`: a self-hosted [Daytona](https://www.daytona.io) with the image
     from [`snapshot/`](snapshot/) (build with `IMAGE=ghcr.io/<your-org>/coach-aven-sandbox-laravel snapshot/build-and-push.sh`; the `plain` variant
     needs no privileged containers and runs on arm64).
3. **GitHub** — a GitHub App installed on the org/repos with *Contents* + *Pull requests*
   read & write and *Metadata* read; set `GITHUB_APP_ID` + the private key path. (A plain
   `GITHUB_TOKEN` works for a quick trial.)
4. **Claude Code** — `claude setup-token` → `CLAUDE_CODE_OAUTH_TOKEN`.
5. **Config**
   ```bash
   cp .env.example .env                                  # secrets + infra endpoints
   cp projects.config.example.json projects.config.json  # projects: slug, repos[], mcp[], git flow
   npm install && npm run orch -- slack
   ```
6. **A channel per project** named `bluefin-aven-<slug>` (prefix configurable with
   `SLACK_CHANNEL_PREFIX`) auto-binds to the project; `@mention` the bot there. Project
   prompts go in `projects.d/<slug>.md` beside the config (`docs/runtime-config.md`).

Microsoft Teams instead of Slack: the same bot with `orch teams` — [`docs/teams.md`](docs/teams.md)
(one chat driver per installation; the bot identity comes from the `infra/teams/` Terraform module).

Production: a systemd unit on any Linux box, deployed by `npm run ops -- <slug> deploy` or by
your ops repo's GitHub Action; each installation's config lives in a private **ops repo**
checked out at `infra/<slug>/` — [`infra/README.md`](infra/README.md), [`infra/deploy/README.md`](infra/deploy/README.md).
Local dev beside a prod bot: [`docs/local-dev.md`](docs/local-dev.md).

## What goes where

| File | Who writes | Holds |
|---|---|---|
| `.env` | you | secrets + infra endpoints: sandbox driver, Slack tokens, GitHub App, Claude token, optional OAuth / MCP gateway / observability |
| `projects.config.json` | you | the project registry: `slug`, `repos[]`, `mcp[]`, `gitFlow`, `youtrackProjects[]`, `sources`, optional `workspaces` (tenant → slugs) |
| `projects.d/<slug>.md` | you | the project's system prompt (wins over the JSON `systemPrompt` field) |
| `state.json` | the bot | sandboxes, tasks, thread → session bindings, installations, routines — never hand-edited |
| `queue.jsonl`, `drafts/`, `usage/`, `feedback/`, `facts/`, `memory/`, `data/` | the bot | journals and derived state beside `state.json` (`docs/`) |

Rule of thumb: a **secret or endpoint** → `.env`; a **description of a project** →
`projects.config.json` + `projects.d/`; everything else the bot derives and you may delete.
`/aven reload` re-reads the project config at runtime (new sessions only).

## Layout

```
src/
  cli.ts            # commander CLI (`slack`, `sources …`, `routines list|run`)
  turn.ts           # turn engine: queues, live status, agent questions, restart recovery
  pollers.ts        # scheduler + auto-review / autofix / ticket pollers
  chat/             # chat driver interface + view models
    core/           #   platform-neutral: messages, the /aven router, buttons/dialogs/home, gates
    slack/          #   the Slack driver: app.ts (composition root), rendering, Bolt wiring, blocks.ts
  tasks.ts          # chat session over a sandbox
  prompt.ts         # the 3-layer system prompt, golden-tested (src/fixtures/prompt/)
  scrub.ts          # secrets redaction at the model boundary and at ingest
  driver.ts         # the sandbox driver interface; daytona.ts / sshdocker.ts implement it
  project.ts        # clone, worktrees, auth/MCP seeding into the sandbox
  claudeSession.ts  # the persistent claude process (stream-json protocol)
  github.ts         # GitHub App tokens + PR/CI reads
  state.ts          # single-file state.json store
  sources/          # ingestion of mail/chat/calendar/files + trackers into a per-project store
  …plus pure logic modules with tests beside them
snapshot/           # sandbox images: `laravel` (dind + Sail shims) and `plain` (multi-arch)
infra/              # deploy/ (deploy.sh, unit templates, ops.example/), teams/ (Terraform module), <slug>/ = your ops repos (ignored)
docs/               # runtime config, sandbox drivers, sources, rollout ledger, …
openspec/           # change proposals (specs, design, tasks) — how work is planned here
```

## Sandbox image

The tooling (git, gh, node, Claude Code, Sail shims, imagemagick) is baked into the image
(`snapshot/Dockerfile`); `provisionTooling()` only tops up additions newer than the fleet's
image. `laravel` is `docker:28-dind` + Sail shims (needs sysbox or `--privileged`); `plain`
drops dockerd, builds amd64 + arm64 and runs unprivileged. Point `SNAPSHOT_IMAGE` at the
`:<gitsha>` tag the build prints. The Claude Code CLI inside sandboxes is pinned by
`CLAUDE_CLI_VERSION` (warm sandboxes converge in place; `"cliVersion"` per project is the
canary) — see `src/cliversion.ts`.

Why no PHP/Composer in the image: with Sail, the Laravel runtime lives in the project's own
containers at the project's own versions; bare `php`/`composer`/`artisan` are shimmed into
the Sail container.

## Multi-workspace installs (optional)

Set `SLACK_CLIENT_ID` + `SLACK_CLIENT_SECRET` + `SLACK_STATE_SECRET` and the bot serves
`/slack/install` on `SLACK_OAUTH_PORT`; other workspaces install from that link (enable
Public Distribution in the Slack app admin, register your `https://<host>/slack/oauth_redirect`).
Per-workspace tokens land in `state.json`; events still ride the one Socket Mode connection.
The `workspaces` block in `projects.config.json` maps each team id to the slugs it may see:

```jsonc
"workspaces": { "T0YOURHOME1": ["shop", "monitoring"], "T0CLIENT001": ["monitoring"] }
```

No block = single-tenant. With it, membership is explicit-only and every record carries
the owning team — admit a client workspace only after this version runs
(`docs/multitenancy.md`).

## Development

- `npm run typecheck` and `npm test` must pass; pure logic lives in its own module with a
  `*.test.ts` beside it. `scripts/public-guard.sh` keeps installation identifiers out.
- `main` is the canary (one real installation follows it); production runs the last tag.
  Nothing may change for production users as a side effect of a merge — every behaviour
  change is a bug fix, default-preserving with a test, or behind a flag canaried first
  (`docs/rollout.md`).
- Work is planned as OpenSpec changes (`openspec/`); PR titles become the release notes.
- Releases: `git tag vX.Y.Z && git push origin vX.Y.Z` — CI typechecks, tests, publishes
  the GitHub Release and deploys.

## Gotchas

- **GitHub token lifetime** ≈ 1h; every chat prep re-mints and re-seeds it. A single turn
  longer than an hour may see a stale token — send another message.
- **Resources**: DinD wants ≥2 vCPU / 4 GiB per warm sandbox running a Sail stack.
- **State** is one `state.json`; single process per installation. Socket Mode delivers each
  event to one socket only, so a dev bot must be a separate Slack app (`docs/local-dev.md`).
