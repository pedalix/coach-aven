# Try it on one machine

CoachAven on one machine with Docker: the agent answers in a web chat on `localhost` and works on one of your GitHub
repositories in an unprivileged sandbox container. You need no Slack app, no identity provider, no registry or image build of
your own, no privileged container and no one else's approval. This is the trial path (OpenSpec `quickstart`): the same installation
layout as an operated one, with the safe settings. When you want more, see [Going on](#going-on).

**Measured:** a rehearsal on 2026-10-30, on a fresh Linux machine (a `docker:dind` container standing in for a clean
VM, on a laptop's network) and on Docker Desktop under WSL. About **3 minutes of machine time** from clone to the first
answer, most of it downloading the two images; the rest is your own time for the three steps marked *(you)* — signing in to Claude, making the GitHub token and
editing two files, about 10 minutes the first time. A timed run on a clean cloud VM replaces these numbers after the next
release.

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
| 2 | `./init.sh` (pulls the bot image and the sandbox image) | 2 min |
| 3 | A Claude subscription token *(you)* | your sign-in |
| 4 | A GitHub token for one repository *(you)* | a few minutes |
| 5 | Fill three values *(you)* | a minute |
| 6 | `docker compose up -d` | 3 s |
| 7 | Open the sign-in link | seconds |
| 8 | Ask in the project's room: the first answer (sandbox created, repository cloned) | 22 s |
| – | Ask for a change: the agent's pull request | 25 s |

**1. Clone at the latest release.**

```sh
git clone https://github.com/pedalix/coach-aven.git && cd coach-aven
git checkout "$(git describe --tags --abbrev=0)"
```

No `quickstart/` after the checkout? The latest release predates it: stay on `main` (`git checkout main`). `init.sh`
then runs the image of that `main` commit, a canary build.

**2. Set up the directory.** `quickstart/` is the installation directory: its settings, its state and the bot's home
live there, and git ignores all of them.

```sh
cd quickstart && ./init.sh
```

It copies `.env` and `projects.config.json` from their examples (only when they are missing) and writes
`compose/.env` from this machine: the bot image of this clone's commit, your user and group, the Docker socket's group
and the web port (`AVEN_WEB_PORT=8790 ./init.sh` for another one than 8787). It never touches a token. Rerun it after
moving the clone to another release.

**3. A Claude subscription token.** Either on any machine with Claude Code:

```sh
claude setup-token
```

or without installing anything, from the sandbox image `init.sh` pulled:

```sh
cd compose && docker compose run --rm setup-token; cd ..
```

Either one opens a sign-in URL, asks you to paste back a code, and prints a token starting with `sk-ant-oat`. For a
team or clients, use an Anthropic API key instead (`ANTHROPIC_API_KEY`, commented out in `.env`): the sandbox can read
the credit, so make it a dedicated key in its own Anthropic workspace with a monthly spend limit.

**4. A GitHub token for one repository.** github.com → Settings → Developer settings → Fine-grained tokens → Generate:
repository access *Only select repositories* (the one the agent works on); permissions *Contents: Read and write* and
*Pull requests: Read and write*; an expiry. The sandbox can read this token too, which is why it reaches one repository.

**5. Fill three values.** In `quickstart/.env`: `CLAUDE_CODE_OAUTH_TOKEN` and `GITHUB_TOKEN`. In
`quickstart/projects.config.json`: your repository in place of `your-org/your-repo`.

**6. Start it.**

```sh
cd compose && docker compose up -d
```

Nothing is built or downloaded here: `init.sh` pulled both images.

**7. Sign in.**

```sh
docker compose logs bot | grep sign-in | tail -n 1
```

The line comes a few seconds after the start; run it again if it shows nothing. Open the
`http://localhost:8787/login?key=…` link it shows — the last one: the log keeps every earlier start's line, and only the
newest key signs in. The key changes at every start of the bot; you stay signed
in across restarts, and need a new link only for a new browser.

**8. Ask.** Open the room `demo` and post a question about the repository — "what does this repository do, and how is
it tested?". The first answer takes longer: the bot creates the sandbox and clones the repository. Ask for a small
change and the agent opens a pull request.

## What runs where

- **The bot** (container `coach-aven-quickstart-bot-1`): the published image, the web chat on `127.0.0.1` only, the
  Docker socket to create the sandboxes. The socket is root-equivalent on this machine, which is why the agent never
  runs in this container.
- **The sandbox** (container `qs-demo`): unprivileged, no Docker socket, no Docker of its own; the repository, the
  Claude Code process, your two tokens. What an agent in a sandbox can and cannot reach: [`SECURITY.md`](../SECURITY.md).
- **The images:** both published by this repository's CI for every `main` commit and release, under one version name —
  `ghcr.io/pedalix/coach-aven` (the bot) and `ghcr.io/pedalix/coach-aven-sandbox-plain` (the sandbox: Claude Code, git,
  `gh`, Node, Python and the usual shell tools; no Docker). A project that needs more tools needs its own sandbox image:
  build one from `snapshot/plain` and name it with `SANDBOX_IMAGE=<image> ./init.sh`.
- **The state:** `quickstart/` — `.env`, `projects.config.json`, `state.json`, the journals, `data/` (the chat's
  history), `home/`, `web-session.secret`.

Logs: `docker compose logs -f bot` in `quickstart/compose/`. After an edit of `.env` or `projects.config.json`:
`docker compose up -d --force-recreate`.

## Uninstall

The sandbox is not a compose service, so `down` leaves it — and it holds your tokens. From the clone's root:

```sh
(cd quickstart/compose && docker compose down)
docker ps -aq --filter label=managedBy=coach-aven-quickstart | xargs -r docker rm -f
docker images -q 'ghcr.io/pedalix/coach-aven*' | xargs -r docker image rm -f
```

Then delete the clone, or only `quickstart/`'s untracked files: `git clean -fdX quickstart/` (your `.env`, the state
and the chat's history go with them).

## Going on

- **Slack or Teams** instead of, or beside, the web chat: [`../README.md#self-host-with-slack-or-teams`](../README.md#self-host-with-slack-or-teams),
  [`teams.md`](teams.md).
- **More than one person** in the web chat: an identity provider, `WEB_AUTH=oidc` ([`web.md`](web.md)).
- **Sandboxes on another host**: `SSHDOCKER_HOST=user@host` ([`sandbox-drivers.md`](sandbox-drivers.md)).
- **A server you operate**: the ops tooling ([`../infra/README.md`](../infra/README.md)). Copy `.env`,
  `projects.config.json` and `projects.d/` into the installation's ops repository; the state and `home/` stay out of it.
