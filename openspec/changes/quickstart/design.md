# Design

## Context

The motivation is in proposal.md, *Why*. What shapes the approach:

- **The bot image.** `ghcr.io/pedalix/coach-aven` is public and built for amd64 and arm64.
  - Tags: `sha-<commit>` for every `main` commit, `vX.Y.Z` on a release, and `latest` following the newest release (`container-deploy` D5, D6).
  - It runs under any uid. It writes only under `AVEN_DIR` and `HOME`.
  - It holds the Docker CLI, so with the socket mounted the sandboxes are the bot's siblings on the machine's Docker (`container-deploy` D4).
- **The installation directory.** `AVEN_DIR` holds `.env`, `projects.config.json` and the state, and a relative path in a setting resolves against it (`container-deploy` D1). On a box, the compose file lives in `<dir>/compose/` with its own two-line `.env` (`AVEN_VERSION`, `AVEN_RELEASE`). The ops overlay `infra/<slug>/` has the same layout.
- **The web chat** (`docs/web.md`). Every project is a room, so there is nothing to bind.
  - Login is OIDC.
  - `WEB_AUTH=none` signs every request in as a fixed local user, with no check. It is accepted only with a loopback bind and a localhost base URL (`src/config.ts`, `webConfigFrom`).
  - With `none`, the local user is an operator only if `WEB_OPERATORS` names it.
- **A container's loopback.** A port published by compose reaches the container's own network interface, never its `127.0.0.1`. So `none` in a compose service is unreachable unless the service uses host networking or a sidecar forwards into its namespace.
  - Host networking does not reach the host on Docker Desktop. The home bot found that on WSL on 2026-10-30.
  - The home bot runs the sidecar (`alpine/socat`).
- **Local sandboxes.** `SSHDOCKER_HOST=local` drives the machine's Docker with no sshd.
  - The image is used if present, pulled if not (`docker image inspect` before `docker pull`, `src/sshdocker.ts`).
  - The plain image (`snapshot/plain`) needs no privilege, but `snapshot/build-and-push.sh` pushes to the installation's own registry, and the repository publishes no sandbox image.
- **GitHub.** `GITHUB_TOKEN` is used as is, and it wins over an App (`src/config.ts`, `githubAuth`). A fine-grained token for one repository, with contents and pull requests write, is enough for clone, push and PR.
- **The credit.** `CLAUDE_CODE_OAUTH_TOKEN` comes from `claude setup-token`, which needs a Claude Code CLI on some machine. The plain sandbox image has one.
- **Projects.** A project needs a slug and at least one repository (`src/projects.ts`). A project without a `sandbox` block runs privileged docker-in-docker, today's fleet default.

## Goals / Non-Goals

**Goals:**
- Clone to first answer in under 60 minutes for the maintainer on a clean VM, and under 90 for one person from outside.
- The trial path needs no registry, no privileged container, no Slack, no identity provider, and no other person's approval.
- The quickstart directory is an installation directory of the same layout as an operated one, so going on means changing values, not moving files.
- Nothing changes for an installation that does not opt in.

**Non-Goals:**
- Defaults for operated installations (privileged opt-in, the default driver's image).
- Published sandbox images.
- An installer, a setup wizard, or `orch doctor`.
- Windows without WSL. Docker Desktop on Windows runs the quickstart inside WSL, as it does the home bot.

## Decisions

### D1. The quickstart is an installation directory in the repository
`quickstart/` holds `.env.example`, `projects.config.example.json`, `compose/compose.yaml` and `init.sh`. The person copies nothing out of it: `AVEN_DIR` is the `quickstart/` directory itself, mounted at `/aven`, and `HOME` is `/aven/home`. That is the one-directory shape `container-deploy` D5 built the image for. `init.sh` copies the two examples to `.env` and `projects.config.json` when they are missing, so no tracked file is edited. `.gitignore` ignores `/quickstart/*` except the tracked templates, so neither the person's settings nor the state ever show up in `git status`, and `git pull` never conflicts.

The one path outside the directory is the sandbox image's build context, `../../snapshot/plain` (D3).

*Why inside the clone rather than a generated directory?* The clone is needed anyway for that build context. A directory the person can read before running it is easier to trust than a script that writes one.

*Why the box's layout?* Going on to an operated installation means copying the configuration: `.env`, `projects.config.json` and `projects.d/` go into `infra/<slug>/` beside a `deploy.env`. The state, `home/` and the journals stay out of the ops repository. The docs list those files rather than saying `cp -r`.

### D2. `WEB_AUTH=link`: a sign-in link printed at boot
A third value beside `oidc` and `none`.
- **A new link per boot.** At boot the bot draws 32 random bytes as the login key. The link is valid until the next restart, so a link in an old log line is dead.
- **Sessions outlive the link.** The session cookie is signed with `WEB_SESSION_SECRET`. Under `link`, when the secret is unset, the bot generates one on first boot and keeps it in `AVEN_DIR/web-session.secret` (0600). So a restart or a reboot keeps the person signed in, and they need the log only for a new browser. This file is the installation's own, not a credential the person obtains (D4).
- **The boot line.** It follows `Web chat running`: `Web chat sign-in: <base URL>/login?key=<key>`. It is written to stdout directly, not through the logger, which can forward to the error tracker (`SENTRY_LOGS`). No other line names the key.
- **Signing in.** `/login?key=` with the right key, compared in constant time, sets the session of the fixed local user, who is also an operator.
- **Refusals.** A wrong or missing key answers 401 with a page that says where to find the link: `docker compose logs bot | grep sign-in`. Every other page without a session redirects to `/login`, as today.
- **Explicit branches.** The login and callback routes today sign in anyone when `auth === 'none' || !deps.oidc` (`src/chat/web/server.ts`). `link` has no OIDC client either, so each branch tests `cfg.auth` by name, and a test proves that `link` without a key never stores a user.
- **Settings.** `org` defaults to `local`, as under `none`; the `WEB_AUTH=none` warning at boot gets a `link` counterpart; a set `WEB_SESSION_SECRET` must have at least 32 characters, as under `oidc`.
- **Where it is accepted.** Any `WEB_BIND`, because inside a container the listener must bind `0.0.0.0` for the published port to reach it. `WEB_BASE_URL` must still be a localhost URL; the default is `http://localhost:<port>`.
- **`none` is unchanged.** It is still loopback-only, and stays the e2e harness's mode.

*Why not the sidecar the home bot runs?* It works, but it is a second container whose only job is to hide a rule from the bot. A person reading `compose.yaml` should see what runs and why.

*Why not `none` on any bind?* The bot cannot tell whether compose published the port on `127.0.0.1` or on every interface. A `ports: "8787:8787"` typo would then put a root-equivalent agent on the LAN without a login. On Docker before 28, a LAN host can also reach a container's address directly. With `link`, either way exposes a page that answers 401.

*Why the localhost base URL rule?* It keeps `link` a local mode. A public installation needs real identities in its audit trail; one shared operator does not give them.

Cookies on `localhost` are not scoped by port, so another local dev server on the same machine receives the session cookie. `docs/quickstart.md` says so in one line; the cookie's name stays as it is.

### D3. The sandbox image is built locally by compose
`compose/compose.yaml` has a service `sandbox-image`:
- `build: ../../snapshot/plain`, tagged `coach-aven-sandbox-plain:local`, with the Dockerfile's own CLI default;
- `command: ["true"]`, `restart: "no"`;
- the bot `depends_on` it with `condition: service_completed_successfully`.

`docker compose up` therefore builds the image once (a few minutes on a laptop, cached afterwards) before the bot starts. `.env.example` sets `SNAPSHOT_IMAGE=coach-aven-sandbox-plain:local`. The driver finds the image with `docker image inspect` and never pulls it.

The CLI pin is not passed to the build. `CLAUDE_CLI_VERSION` in `.env` already brings a sandbox's CLI to the pin in place when a conversation starts (`src/project.ts`, `src/cliversion.ts`), as on every installation. `src/cliprobe/gate.test.ts` checks the quickstart's pin against `PROBED_CLI_VERSIONS`, as it does the root `.env.example`'s.

*Why not a published image?* `snapshot/build-and-push.sh` says the image repository is the installation's, and publishing one from this repository is a supply-chain commitment: rebuilds for CVEs, a retention policy, multi-arch on every tag. A local build costs minutes once. If trial reports say the build is the slow or failing step, publishing becomes its own change.

### D4. `init.sh` writes the machine, never credentials
`./init.sh` is the first step after the clone:
- **The templates.** It copies `.env.example` and `projects.config.example.json` when their targets are missing, and says which.
- **`compose/.env`.** It writes, overwriting each time:
  - `AVEN_VERSION`: the tag `git describe --tags --exact-match` names, or `sha-<HEAD>` with a warning that a `main` commit's image is a canary build. The bot image and the sandbox's Dockerfile thus come from the same commit, and the version is always a name, as `container-deploy` requires; `latest` is never written;
  - `AVEN_UID` and `AVEN_GID`: `id -u` and `id -g`;
  - `DOCKER_GID`: the socket's group as a container sees it, asked from Docker itself with `docker run --rm -v /var/run/docker.sock:/s --entrypoint stat <bot image> -c %g /s`. On Docker Desktop the host's `stat` reads a symlink's group, not the group the container sees;
  - `AVEN_WEB_PORT`: 8787 unless set in the environment. Compose uses it for the published port and for `WEB_PORT` and `WEB_BASE_URL`, so the logged link names the port the browser uses.
- **The rest.** It creates `home/` and prints the next steps.

It is POSIX `sh` and safe to rerun. It never reads or prints a token.

`compose.yaml` writes every interpolated value as `${NAME:?run ./init.sh first}`, so a compose command before init fails with that sentence.

The bot runs as `${AVEN_UID}:${AVEN_GID}` with `group_add: ["${DOCKER_GID}"]`, so files in `quickstart/` stay the person's own on Linux.

*Why not run the bot as root?* The socket is root-equivalent either way. But state files owned by root in a directory the person owns make every later `rm` and `git clean` a `sudo`.

### D5. The project example is the safe shape, under its own names
`quickstart/projects.config.example.json` holds one project:
- `"slug": "demo"`, `"repos": ["your-org/your-repo"]`;
- `"sandbox": { "privileged": false, "dind": false }`;
- a two-sentence `systemPrompt`;
- no `driver`, `mcp`, `workspaces` or `youtrackProjects`.

`.env.example` sets `SANDBOX_NAME_PREFIX=qs-` and `SANDBOX_MANAGED_BY=coach-aven-quickstart`. A machine that already runs an installation, a developer's laptop for instance, then never shares a container with it. The idle stop assumes one bot per label.

A placeholder repository left unchanged fails the first turn's clone with git's own message. The docs' step says to edit the line, and D6 does not try to detect it.

### D6. One boot check: the local Docker
With `SSHDOCKER_HOST=local`, the composition root checks the local Docker at boot in the background:
- **The check.** `docker version`, with a 10-second timeout, retried for up to 60 seconds.
- **On failure** it logs one error naming the socket path, the process's groups and the fix: "the bot cannot reach Docker; in the quickstart, rerun `./init.sh` and `docker compose up -d`; on a box, check that the bot's user is in the socket's group". It sends no error-tracker event.
- **The boot goes on** and does not wait for the check. The home bot starts with Docker Desktop, so a slow engine at logon must neither delay nor crash-loop it, and must not page anyone. The first turn still fails as it does today.

*Why only this check?* It is the one failure the trial path makes likely, because the socket group differs per machine. The other checks of a preflight come from trial reports (proposal, *Out of scope*).

### D7. The credit without installing Claude Code on the host
`docs/quickstart.md` offers two ways to get the subscription token, after `init.sh`:
- `claude setup-token` on any machine with Claude Code;
- `docker compose run --rm sandbox-image claude setup-token`, which runs the CLI from the freshly built sandbox image.

The rehearsal (D8) proves that the second works through `compose run`: an interactive TTY, a URL to open, a code to paste back, and the token printed. If it does not work, the page keeps only the first way.

The API key (`ANTHROPIC_API_KEY`) is named as the alternative for a team, with the one exposure line of `api-key-credit` D7. The order is the maintainer's decision: the token to try, the key to serve.

### D8. The measured path is the documentation
`docs/quickstart.md` is a numbered list. Each step has:
- its command;
- the time it took in the measurement (minutes, rounded up);
- what it needs from whom: a GitHub account; a Claude subscription, or an Anthropic Console account for a key; Docker installed.

After the steps come:
- **"Uninstall":** `docker compose down`, then `docker rm -f` of the containers labelled `managedBy=coach-aven-quickstart`. The sandboxes are siblings, not compose services, and hold the GitHub and Claude tokens.
- **"Going on":** one line per direction:
  - Slack or Teams (links to their pages);
  - a remote Docker host (`SSHDOCKER_HOST=user@host`);
  - an API key;
  - OIDC for more than one person;
  - `npm run ops` with the configuration files (D1).

The README gets a "Try it" block: three lines and the link. The README's first screen is rewritten in its own docs PR, which will move the block.

Platforms:
- **Docker Engine on Linux:** tested by the rehearsal.
- **Docker Desktop on Windows (WSL):** tested on the maintainer's machine, with its own port, beside the home bot.
- **Docker Desktop on macOS:** listed as untested until someone reports a run.

The measurement:
1. **A rehearsal by Claude.** It runs in a fresh, privileged `docker:dind` container standing in for a clean Linux machine. It uses its own GitHub fine-grained token and a subscription token. Every command is copied from the page, never from memory.
2. **The maintainer's run.** It happens on a clean cloud VM after the next release tag, with a stopwatch. Its times replace the rehearsal's in the page.

The outside person's run is the community plan's day-30 metric, not a task of this change.

## Risks / Trade-offs

- **`WEB_AUTH=link` reaches people only with a release.** Until the next tag, the quickstart runs only from a `main` commit, as a canary (D4). The maintainer's measurement waits for the tag.
- **The socket group is wrong on some machines** (rootless Docker, Podman, Colima).
  - D6 names the problem at boot.
  - The docs list only what was run as tested (D8).
- **The sign-in link is in the log.** Until the next restart, anyone who can read the container's log can sign in. On a laptop that is the owner; on a shared host the docs point to OIDC.
- **The agent in a local sandbox shares the machine's kernel and Docker.**
  - The sandbox is unprivileged and has no socket.
  - The bot container has the socket, but the agent never runs there.
  - `docs/quickstart.md` states it in one line and links `SECURITY.md`'s sandbox threat model.
- **The fine-grained GitHub token sits in the sandbox**, as every installation's token does. The docs say to make it for one repository, with an expiry.

## Migration

None. An installation that neither sets `WEB_AUTH=link` nor runs the quickstart sees only the Docker check, and only as a log line when Docker stays unreachable for a minute after boot.
