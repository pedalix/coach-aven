# Try it on one machine

CoachAven on one machine with Docker: the agent answers in a web chat on `localhost` and works on one of your GitHub
repositories in an unprivileged sandbox container. You need no Slack app, no identity provider, no registry or image build of
your own, no privileged container and no one else's approval. This is the trial path (OpenSpec `quickstart`): the same installation
layout as an operated one, with the safe settings. When you want more, see [Going on](#going-on).

**Measured:** a rehearsal on 2026-10-30, on a fresh Linux machine (a `docker:dind` container standing in for a clean
VM, on a laptop's network) and on Docker Desktop under WSL. About **3 minutes of machine time** from clone to the first
answer, most of it downloading the two images; the rest is your own time for the two steps marked *(you)* — signing in
to Claude and making the GitHub token, each pasted into `.env` — about 10 minutes the first time. A timed run on a clean
cloud VM replaces these numbers after the next release.

## Before you start

| You need | For | Who |
|---|---|---|
| Docker: Docker Engine on Linux, or Docker Desktop (macOS, Windows with WSL) | the bot and the sandboxes | you |
| `git` | the clone | you |
| A GitHub account with a repository you may push to | the agent's work and its pull requests | you |
| A Claude subscription (Pro or Max) — or an Anthropic Console account for an API key | the model | you |

Run on: Docker Engine on Linux and Docker Desktop on Windows (WSL), 2026-10-30. macOS: not yet reported.

## The steps

| # | Step | Time |
|---|---|---|
| 1 | Clone at the latest release | 5 s |
| 2 | `./coach-aven init your-org/your-repo` (pulls the bot image and the sandbox image) | 2 min |
| 3 | A Claude subscription token into `.env` *(you)* | your sign-in |
| 4 | A GitHub token for that repository into `.env` *(you)* | a few minutes |
| 5 | `./coach-aven up`: it prints the sign-in link | seconds |
| 6 | Ask in the project's room: the first answer (sandbox created, repository cloned) | 22 s |
| – | Ask for a change: the agent's pull request | 25 s |

**1. Clone at the latest release.**

```sh
git clone https://github.com/pedalix/coach-aven.git && cd coach-aven
git checkout "$(git describe --tags --abbrev=0)"
```

No `quickstart/coach-aven` after the checkout? The latest release predates it: stay on `main` (`git checkout main`).
The script then runs the image of that `main` commit, a canary build.

**2. Set up the directory.** `quickstart/` is the installation directory: its settings, its state and the bot's home
live there, and git ignores all of them. Name the GitHub repository the agent works on:

```sh
cd quickstart && ./coach-aven init your-org/your-repo
```

It copies `.env` and `projects.config.json` from their examples (only when they are missing), writes your repository
into the project `demo`, and writes `compose/.env` from this machine: the bot image of this clone's commit, your user
and group, the Docker socket's group and the web port (`AVEN_WEB_PORT=8790 ./coach-aven init` for another one than
8787). It never touches a token. Rerun it after moving the clone to another release, or with another repository.

**3. A Claude subscription token.** Either on any machine with Claude Code:

```sh
claude setup-token
```

or without installing anything, from the sandbox image `init` pulled:

```sh
./coach-aven setup-token
```

Either one opens a sign-in URL, asks you to paste back a code, and prints a token starting with `sk-ant-oat`. Put it
in `quickstart/.env` as `CLAUDE_CODE_OAUTH_TOKEN`. For a team or clients, use an Anthropic API key instead
(`ANTHROPIC_API_KEY`, commented out in `.env`): the sandbox can read the credit, so make it a dedicated key in its own
Anthropic workspace with a monthly spend limit.

**4. A GitHub token for one repository.** github.com → Settings → Developer settings → Fine-grained tokens → Generate:
repository access *Only select repositories* (the one from step 2); permissions *Contents: Read and write* and
*Pull requests: Read and write*; an expiry. Put it in `quickstart/.env` as `GITHUB_TOKEN`. The sandbox can read this
token too, which is why it reaches one repository.

**5. Start it.**

```sh
./coach-aven up
```

Nothing is built or downloaded here: `init` pulled both images. A few seconds later it prints the
`http://localhost:8787/login?key=…` link: open it. The key changes at every start of the bot (`./coach-aven link`
prints the current one); you stay signed in across restarts, and need a new link only for a new browser.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="img/web-room-dark.png">
  <img alt="The demo room with two threads: a question about the tests and a change request answered with a pull request" src="img/web-room-light.png" width="800">
</picture>

**6. Ask.** Open the room `demo` and post a question about the repository — "what does this repository do, and how is
it tested?". The first answer takes longer: the bot creates the sandbox and clones the repository.

## What to ask next

| Try | What happens |
|---|---|
| "Add a section on running the tests to the README" | the agent works in its own branch and opens a pull request; you review and merge |
| `/review #12` (a pull request of the repository) | a read-only review in the room; `/review auto on` reviews every new pull request |
| `/schedule weekdays 9:00 \| open pull requests and what changed yesterday` | a recurring summary in the room |
| `/memory` | what the agent has learned about the project so far |
| `/status` | the sandbox, the sessions and the open pull requests |

Every command and button: the room's Home (`/help`), or [`commands.md`](commands.md). Projects beyond the trial —
several repositories, MCP servers, a Laravel Sail stack, a project prompt: the annotated
[`projects.config.example.json`](../projects.config.example.json) and [`configuration.md`](configuration.md).

## What runs where

- **The bot** (container `coach-aven-quickstart-bot-1`): the published image, the web chat on `127.0.0.1` only, the
  Docker socket to create the sandboxes. The socket is root-equivalent on this machine, which is why the agent never
  runs in this container.
- **The sandbox** (container `qs-demo`): unprivileged, no Docker socket, no Docker of its own; the repository, the
  Claude Code process, your two tokens. What an agent in a sandbox can and cannot reach: [`SECURITY.md`](../SECURITY.md).
- **The images:** both published by this repository's CI for every `main` commit and release, under one version name —
  `ghcr.io/pedalix/coach-aven` (the bot) and `ghcr.io/pedalix/coach-aven-sandbox-plain` (the sandbox: Claude Code, git,
  `gh`, Node, Python and the usual shell tools; no Docker). A project that needs more tools needs its own sandbox image:
  build one from `snapshot/plain` and name it with `SANDBOX_IMAGE=<image> ./coach-aven init`.
- **The state:** `quickstart/` — `.env`, `projects.config.json`, `state.json`, the journals, `data/` (the chat's
  history), `home/`, `web-session.secret`.

Logs: `./coach-aven logs`. After an edit of `.env` or `projects.config.json`: `./coach-aven up` (it always restarts
the bot, which reads both only when it starts). Stop: `./coach-aven down`.

## Uninstall

```sh
quickstart/coach-aven uninstall
```

It stops the bot, removes the sandbox containers (they are not compose services, and they hold your tokens) and the
two images of this version. Then delete the clone, or only `quickstart/`'s untracked files: `git clean -fdX
quickstart/` (your `.env`, the state and the chat's history go with them).

## Going on

- **Slack beside the web chat**, on this very installation: create a Slack app from
  [`slack-app-manifest.json`](../slack-app-manifest.json) (Socket Mode on), uncomment the three Slack lines at the end of
  `quickstart/.env` with its bot token (`xoxb-…`) and app token (`xapp-…`), and `./coach-aven up`. A channel named
  `aven-demo` drives the project `demo`: invite the bot and @mention it there.
- **Microsoft Teams** needs a public HTTPS endpoint and a bot identity: [`teams.md`](teams.md).
- **More than one person** in the web chat: an identity provider, `WEB_AUTH=oidc` ([`web.md`](web.md)).
- **Sandboxes on another host**: `SANDBOX_HOST=user@host` ([`sandbox-drivers.md`](sandbox-drivers.md)).
- **A server you operate**: the ops tooling ([`../infra/README.md`](../infra/README.md)). Copy `.env`,
  `projects.config.json` and `projects.d/` into the installation's ops repository; the state and `home/` stay out of it.
