# Troubleshooting

By symptom: what you see, why, what to do. The messages are quoted as the bot prints them. Logs:
`docker compose logs -f bot` in the installation's `compose/` directory (the quickstart's is `quickstart/compose/`), or
the terminal of `npm run orch`. Something missing here? Open an issue with the log lines around it ([`SUPPORT.md`](../SUPPORT.md)).

## The bot does not start

| Message | Why | Fix |
|---|---|---|
| `Both ANTHROPIC_API_KEY and CLAUDE_CODE_OAUTH_TOKEN are set: keep exactly one` | one installation, one model credit | remove one from `.env` — and check your shell: `.env` never overrides an exported variable ([`local-dev.md`](local-dev.md#level-2-the-bot-on-your-machine)) |
| `ANTHROPIC_API_KEY holds a subscription token (sk-ant-oat…)` (or the reverse) | a value pasted into the other variable | move it |
| `Missing required env var: GITHUB_APP_ID` / `Provide GITHUB_APP_PRIVATE_KEY_PATH or GITHUB_APP_PRIVATE_KEY` | no GitHub credential | set `GITHUB_TOKEN` (a token is used as is) or the App's id and key |
| `…: each project needs a "slug" and at least one repo in "repos"` | the projects config | every project names at least one `owner/repo` |
| `…: workspaces["T…"] references unknown project "…"` | a `workspaces` entry names a slug that is not in `projects` | fix the slug, or drop the entry |
| `SANDBOX_DRIVER=…: the Daytona driver was removed after v0.42.0` | an old `.env` | `SANDBOX_DRIVER=ssh-docker` (or remove the line) and set `SANDBOX_HOST` |
| `WEB_AUTH=none needs a loopback listener (WEB_BIND=127.0.0.1)` | `none` signs everyone in, so it never listens beyond loopback | inside a container, use `WEB_AUTH=link` ([`web.md`](web.md)) |
| `WEB_AUTH=link needs a localhost WEB_BASE_URL` | `link` is a local mode | a public host signs people in through OIDC |
| `Partial web config: missing …` / `Partial Teams config: missing …` | some of a surface's settings are set, not all | set the rest, or remove them all |
| `CLAUDE_CLI_VERSION must be x.y.z` | a malformed pin | `2.1.292`, not `v2.1.292` or `latest` |

## The quickstart's `./coach-aven init` stops

| Message | Fix |
|---|---|
| `Docker does not answer` | start Docker Desktop or the docker service |
| `… is not published — only release tags and main's commits have images` | the clone is on a branch or a local commit: `git checkout $(git describe --tags --abbrev=0)` (or `main`) and rerun |
| `a container running as uid … with group … cannot reach /var/run/docker.sock` | the socket's group is not what Docker reported; rootless Docker, Podman and Colima are untested — report what you run |
| `run ./coach-aven init first` (from `./coach-aven up`, or `required variable … is missing a value` from `docker compose`) | run `./coach-aven init` first |
| `no sign-in link after 30 s` (from `./coach-aven up`) | `./coach-aven logs` shows why the bot did not start: usually the credit or `GITHUB_TOKEN` missing in `.env` |

## The bot runs but does not answer

- **Two bots on one Slack app.** Socket Mode delivers each event to one connection, so a second bot with the same
  tokens (a laptop beside production) takes about half of the events. Use a separate app for development
  ([`local-dev.md`](local-dev.md#level-3-beside-a-production-bot)).
- **`This workspace has no projects configured yet: …`** The workspace sees no project, and the rest of the sentence
  says why, with the workspace's id: the registry lists no project; it is not the home workspace and there is no
  `workspaces` block; the `workspaces` block does not list it; or its entry lists no projects. Add the id with its slugs
  to `workspaces`. A `workspaces` block that leaves out the home workspace is also a warning at boot.
- **`This channel isn't bound to a project.`** The channel's name does not start with `SLACK_CHANNEL_PREFIX` (`aven-` by
  default) plus a slug. Rename the channel, or prefix your question with a slug.
- **The bot is not in the channel.** Invite it (`/invite @…`).
- **A message in a thread the bot never answered** is not a turn: mention the bot.

## Warnings at boot about sandboxes

- **`php`, `composer` or `artisan` fail, or Sail has no Docker, after an upgrade** — since the release after v0.48.0 a
  project without a `sandbox` block is a plain container. Write `"sandbox": { "dind": true }` on it, then
  `docker rm proj-<slug>` on the sandbox host so the next turn creates it with docker-in-docker.
- **`… run privileged on this machine (SANDBOX_HOST=local)`** — make the projects plain, or confirm with
  `SANDBOX_LOCAL_PRIVILEGED=1`.
- **`Missing required env var: SANDBOX_IMAGE`** or **`SANDBOX_HOST is not set`** after an upgrade — the settings were
  renamed in v0.48.0, and the releases after it no longer read the old names: `SNAPSHOT_IMAGE` → `SANDBOX_IMAGE`, `SSHDOCKER_HOST` →
  `SANDBOX_HOST`, `SSHDOCKER_RUNTIME` → `SANDBOX_DIND_RUNTIME`.

## The first turn fails

- **`SANDBOX_HOST is not set`** — set `local` for this machine's Docker, or an ssh target ([`sandbox-drivers.md`](sandbox-drivers.md)).
- **`the bot cannot reach Docker at /var/run/docker.sock`** (a boot log line, a minute after the start) — the bot's
  process is not in the socket's group. In the quickstart, rerun `./coach-aven init` and `./coach-aven up`; on a box, put
  the bot's user in the `docker` group.
- **`image pull failed: …`** — the sandbox image `SANDBOX_IMAGE` names cannot be pulled by the sandbox host: a typo, a
  private registry without a login on that host, or a tag that was never pushed.
- **The clone fails** with git's own message — the repository in the projects config is still a placeholder, or the
  GitHub token does not reach it (a fine-grained token lists its repositories; an App must be installed on the
  owner).
- **A long first answer** is normal: the first turn creates the sandbox, clones the repositories and, without the
  quickstart's pre-pull, downloads the sandbox image.
- **`claude_code_version_too_old`** from the model — the CLI in the sandbox is too old for `CLAUDE_MODEL`; raise
  `CLAUDE_CLI_VERSION` to a probed version ([`cli-probe.md`](cli-probe.md)).

## During work

- **A push fails after an hour.** The GitHub token is minted before every turn and lives about an hour; a turn longer
  than that sees a stale token. Send another message.
- **The agent cannot reach an MCP server.** Ask the agent which MCP tools it has: a server missing from its list did not
  connect when the session started. Check the entry's URL and credentials in the projects config; a gateway entry
  needs its OAuth client ([`runtime-config.md`](runtime-config.md) → *MCP gateway*). After a fix, `/aven reload` and a
  new conversation.
- **A sandbox stopped.** The idle stop stops a container after `SANDBOX_AUTOSTOP_MINUTES` without activity; the next
  turn wakes it and resumes the conversation.
- **A changed prompt or MCP server does not apply.** `/aven reload` reaches new conversations only; a running one keeps
  what it started with until it ends or you press 🔄 Restart session.
- **`Claude Code pin … is behind npm stable …`** — a daily reminder, not an error: probe a newer CLI and raise the pin
  when you choose to ([`housekeeping.md`](housekeeping.md)).

## The web chat

- **401 with "Open the sign-in link from the bot's log"** — `WEB_AUTH=link`: the key changes at every start. Take the
  newest line: `docker compose logs bot | grep sign-in | tail -n 1`.
- **Signed out after every restart** — `WEB_AUTH=none` without `WEB_SESSION_SECRET` draws a new secret per start; set
  one. (`link` keeps its own in `web-session.secret`.)
- **The page loads but nothing updates live** — a proxy buffers the stream: turn buffering off for `/stream`
  ([`web.md`](web.md)).
