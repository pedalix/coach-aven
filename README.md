# CoachAven

A coding agent that lives in Slack (Microsoft Teams in canary). One bot, many channels; each channel is bound to a project,
and each project gets its own warm, isolated sandbox running a persistent **Claude Code**
process. The agent reads the repos, answers questions, runs builds and tests, and opens pull
requests; your team reviews and merges. Optional, per project: it reviews pull requests as they
open, runs routines on a schedule, investigates YouTrack tickets, and queries a scrubbed store of
the project's mail, chat, calendar and ticket trackers. The bot itself is a small TypeScript
control plane with no model calls of its own: all the thinking happens inside the sandboxes.

Website: [coachaven.com](https://coachaven.com). Status: a single-operator project that runs
installations for real users; self-hosting is supported and documented, support is best-effort
(see [`SUPPORT.md`](SUPPORT.md), [`CONTRIBUTING.md`](CONTRIBUTING.md), [`SECURITY.md`](SECURITY.md)).
Rather not run it yourself? We can run it for you: [coachaven.com](https://coachaven.com).
Model credit: a Claude subscription token to try it (`claude setup-token`, one command), an
Anthropic API key for an installation that serves a team or clients (billed and metered per key).
Licence: Apache-2.0.

Start here:

- [**Why CoachAven**](docs/why.md): who it is for, what it does differently, what it is not.
- [**How it is built and run**](docs/how-we-work.md): invariants, specs first, canary then tag,
  who does what.
- [**All docs**](docs/README.md): running an installation, what the agent can do, under the hood.

## How it works

```
 Slack ⇄ Socket Mode (the bot dials out: no public endpoint needed)
 Teams ⇄ HTTPS (Microsoft dials in: a public endpoint behind your reverse proxy)
   │       one chat driver per installation
 orchestrator  (Node, one process; state.json; pollers for routines / PR review / tickets)
   │  sandbox driver: containers on a Docker host you own, over SSH (or this host's own Docker)
   ▼
 proj-<slug> sandbox  ── git clone of the project's repos, one worktree per task,
                         a persistent `claude` process per conversation (stream-json),
                         MCP servers the project declares (Grafana, Sentry, trackers, …)
```

## Self-host quickstart

You need: Node 24, a Slack workspace where you can create apps, a GitHub App (or token) for
the repos, a model credit (a Claude subscription token or an Anthropic API key, step 4), and a
place to run sandboxes.

1. **Slack app** — create it from [`slack-app-manifest.json`](slack-app-manifest.json)
   (Socket Mode on). Note the bot token (`xoxb-…`) and the app-level token (`xapp-…`).
2. **Sandboxes** — containers on a Docker host you own (`docs/sandbox-drivers.md`): over SSH
   (`SSHDOCKER_HOST=user@host`), or on this very machine (`SSHDOCKER_HOST=local`). Keep
   `SANDBOX_DRIVER=ssh-docker` as the template writes it. The containers run the sandbox image
   from [`snapshot/`](snapshot/README.md): build it and push it to your own registry (none is
   published), then point `SNAPSHOT_IMAGE` at the `:<gitsha>` tag the build prints. The `plain`
   variant needs no privileged containers and runs on arm64.
3. **GitHub** — a GitHub App installed on the org/repos with *Contents* + *Pull requests*
   read & write, *Checks* read and *Metadata* read; set `GITHUB_APP_ID` + the private key path. (A plain
   `GITHUB_TOKEN` works for a quick trial.)
4. **Claude Code credit** — exactly one of:
   - to try it: `claude setup-token` → `CLAUDE_CODE_OAUTH_TOKEN`;
   - for a team or clients: a key from the [Anthropic console](https://console.anthropic.com/) →
     `ANTHROPIC_API_KEY`. The sandbox can read it, so make it a dedicated key in its own workspace
     with a monthly spend limit.

   Both set stops the boot. A switch applies to new conversations ([`docs/runtime-config.md`](docs/runtime-config.md)).
5. **Config**
   ```bash
   cp .env.example .env                                  # secrets + infra endpoints
   cp projects.config.example.json projects.config.json  # projects: slug, repos[], mcp[], git flow
   npm install && npm run orch -- slack
   ```
6. **A channel per project** named `aven-<slug>` (prefix configurable with
   `SLACK_CHANNEL_PREFIX`) auto-binds to the project; `@mention` the bot there. Project
   prompts go in `projects.d/<slug>.md` beside the config (`docs/runtime-config.md`).

The bot's App Home tab lists every command and button.

Microsoft Teams instead of Slack: the same bot with `orch teams` — [`docs/teams.md`](docs/teams.md)

A web chat the installation serves itself (OIDC login, rooms per project): `orch web` — [`docs/web.md`](docs/web.md) (canary)

Both at once: `CHAT_SURFACES=teams` (or `slack`, `web`) in `.env` runs a second chat driver beside the run mode's, over the same
projects and sandboxes — [`docs/runtime-config.md`](docs/runtime-config.md) → *Chat surfaces*.
(one chat driver per installation; the bot identity comes from the `infra/teams/` Terraform module).

Production: a systemd unit on any Linux box, deployed by `npm run ops -- <slug> deploy` or by
your ops repo's GitHub Action; each installation's config lives in a private **ops repo**
checked out at `infra/<slug>/` — [`infra/README.md`](infra/README.md), [`infra/deploy/README.md`](infra/deploy/README.md).
Several Slack workspaces on one bot: [`docs/multitenancy.md`](docs/multitenancy.md#enabling-multi-workspace-installs-operator-steps).
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

## Gotchas

- **GitHub token lifetime** ≈ 1h; it is minted and seeded again before every turn. A single turn
  longer than an hour may see a stale token — send another message.
- **Branch protection**: the project's token can push; the `pr` git flow is a rule in the prompt,
  so require reviews on the default branch and let GitHub enforce "people merge".
- **Resources**: DinD wants ≥2 vCPU / 4 GiB per warm sandbox running a Sail stack.
- **State** is one `state.json`; single process per installation. Socket Mode delivers each
  event to one socket only, so a dev bot must be a separate Slack app (`docs/local-dev.md`).

## Contributing

The rules for a PR: [`CONTRIBUTING.md`](CONTRIBUTING.md). Commands, conventions and where things
live in `src/`: the contributor guide [`CLAUDE.md`](CLAUDE.md). How a change ships (`main` is the
canary, production runs the last tag): [`docs/how-we-work.md`](docs/how-we-work.md) and the flag
ledger [`docs/rollout.md`](docs/rollout.md).
