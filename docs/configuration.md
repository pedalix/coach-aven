# Configuration reference

Everything an installation can set, in one place: the `.env` settings the bot, the sources daemon and
the `orch` CLI read, the fields of `projects.config.json`, and where each file lives. Each row says what
the code does; the linked pages explain why and how. `src/configdocs.test.ts` fails the suite when the
code reads an environment variable or grows a `ProjectConfig` field this page does not name, so the page
cannot fall behind the code without someone noticing.

Defaults are the values the code applies when the variable is unset or empty. **required** means the
boot (or the command that needs it) stops without it; **—** means there is no default: unset turns the
feature off or leaves the choice to someone else (the CLI, the image), as the row says.

## Where each file lives, and what applies when

The **installation directory** holds an installation's configuration and state: `.env`,
`projects.config.json`, `state.json`, the journals, `data/`. It is `AVEN_DIR`, which only the process
environment can set (the compose file or the shell, never `.env`, which it locates), and which must be
absolute; unset, it is the package root. Relative path settings (`PROJECTS_CONFIG_PATH`, `AVEN_DATA_DIR`,
`MIRRORS_CONFIG`, `GITHUB_APP_PRIVATE_KEY_PATH`, `HUB_KEY_PATH`) resolve against it, never against the
working directory. `PROJECTS_CONFIG_PATH` names the projects config (default `projects.config.json` there);
beside it, `projects.d/<slug>.md` is the project's system prompt (a non-empty file wins over the
`systemPrompt` field) and `hub.peers.json` the messaging peers. See
[Installation directory](runtime-config.md#installation-directory-aven_dir).

**`.env` is read once, at boot:** any change needs a restart (`docker compose up -d --force-recreate`
under compose). **`/aven reload`** (operator-only) re-reads `projects.config.json`, `projects.d/*.md` and
`hub.peers.json` and swaps the registry in place; a config that fails validation keeps the old one. A
reload reaches what is read per use (channel bindings, `youtrackProjects`, `deliverTo`, `webRoom`,
`messaging`, `sources`) at once, but a running conversation keeps the prompt, MCP servers and options its
session was opened with, and an existing container keeps the `sandbox` options it was created with. The
`projects.config.json` table below says which applies where.

## `.env` settings

### Installation directory and data

| Variable | Default | What it does |
|---|---|---|
| `AVEN_DIR` | the package root | The installation directory. Process environment only, absolute; a `.env` that sets it stops the boot. [More](runtime-config.md#installation-directory-aven_dir). |
| `AVEN_DATA_DIR` | `data` in `AVEN_DIR` | Where the sources store (`data/<slug>/`) lives. [Sources → On disk](sources.md#on-disk). |
| `PROJECTS_CONFIG_PATH` | `projects.config.json` in `AVEN_DIR` | The projects config; `projects.d/` and `hub.peers.json` are read beside it. |
| `MIRRORS_CONFIG` | `mirrors.json` in `AVEN_DIR` | The repo-mirror list `orch mirror` reads. [Repo mirrors](runtime-config.md#repo-mirrors). |
| `AVEN_TZ` | `UTC` | IANA time zone for routine schedules, the daily checks, the rate-limit status line and the sources daemon's auth check. |

### Model credit and Claude Code

| Variable | Default | What it does |
|---|---|---|
| `ANTHROPIC_API_KEY` | required: exactly one of the two | An Anthropic API key: the credit for an installation serving a team or clients. Both set, or a value with the other one's prefix, stops the boot. Neither set: the live token in `$HOME/.claude` (a dev box). [Model credit](runtime-config.md#model-credit-anthropic_api_key-claude_code_oauth_token). |
| `CLAUDE_CODE_OAUTH_TOKEN` | required: exactly one of the two | A `claude setup-token` subscription token: the quick way to try it. |
| `CLAUDE_MODEL` | — (the CLI's default) | `--model` for the sandbox Claude Code processes. New sessions only. |
| `CLAUDE_CLI_VERSION` | — (the image's CLI) | Pins the sandbox Claude Code CLI (`x.y.z`, anything else stops the boot); warm sandboxes converge at chat prep and housekeeping. A project's `cliVersion` overrides it. [Sandbox images](../snapshot/README.md), [CLI probe](cli-probe.md). |
| `REPO_SKILLS` | off | `1`: a multi-repo project's sessions load each repo's own skills (`--add-dir` per repo). New sessions only. [Repo skills](runtime-config.md#repo-skills-repo_skills). |

### Sandboxes

| Variable | Default | What it does |
|---|---|---|
| `SANDBOX_IMAGE` | required | The image a project container is created from, unless the project names its own (`sandbox.image`). Read when a container is created; an existing one keeps its image until removed. |
| `SANDBOX_DRIVER` | `ssh-docker` | The only sandbox driver; any other value (`daytona` above all) stops the boot. [Selecting the driver](sandbox-drivers.md#selecting-the-driver). |
| `SANDBOX_HOST` | — (required at a project's first sandbox use) | The Docker host: `local` (this machine's daemon, no sshd) or an ssh target (`user@host`, an `~/.ssh/config` alias). [Sandbox drivers](sandbox-drivers.md). |
| `SANDBOX_DIND_RUNTIME` | `privileged` | How a docker-in-docker project (`"dind": true`) runs: `privileged` or `sysbox-runc` (preferred, needs sysbox on the host); anything else stops the boot. Irrelevant for plain projects. |
| `SANDBOX_LOCAL_PRIVILEGED` | — | `1` confirms a privileged project on the bot's own machine (`SANDBOX_HOST=local`); without it the boot warns. |
| `SANDBOX_AUTOSTOP_MINUTES` | `30` | Idle minutes before the bot stops a project's container (floor 10; `0` or negative = never). [Sandbox idle stop](runtime-config.md#sandbox-idle-stop-sandbox_autostop_minutes). |
| `SANDBOX_NAME_PREFIX` | `proj-` | Container names are `<prefix><slug>`. Two installations on one Docker host need distinct prefixes. [Local dev → The settings](local-dev.md#the-settings). |
| `SANDBOX_MANAGED_BY` | `coach-aven` | The `managedBy` label on every sandbox: the `/aven status` filter and the idle stop's guard. Must match the existing containers' label. |
| `SANDBOX_WORK_DIR` | `/root/work` | The directory inside the sandbox where the repos and worktrees live. |

### GitHub

| Variable | Default | What it does |
|---|---|---|
| `GITHUB_TOKEN` | — | A plain token (a PAT, `gh auth token`). Wins over the App when set; not repo-scoped. |
| `GITHUB_APP_ID` | required unless `GITHUB_TOKEN` or `GITHUB_AUTH=none` | The GitHub App whose installation tokens, scoped to a project's repos, are minted before every turn. |
| `GITHUB_AUTH` | — | `none`: no GitHub access at all — public repositories cloned anonymously, no push, no pull requests, the API asked unauthenticated, and the agent told so (the quickstart's read-only trial). Only this value; refused beside `GITHUB_TOKEN` or `GITHUB_APP_ID`. Unset, a missing credential stops the boot as always. |
| `GITHUB_APP_INSTALLATION_ID` | — (discovered from the repo owner) | Skips the installation lookup. |
| `GITHUB_APP_PRIVATE_KEY_PATH` | — | The App's PEM file (relative = in `AVEN_DIR`). One of the two key settings is required with the App; the path wins. |
| `GITHUB_APP_PRIVATE_KEY` | — | The PEM inline, `\n`-escaped. |
| `MIRROR_SRC_<OWNER>` | — | Read tokens for repo mirrors, named by each `mirrors.json` entry's `srcTokenEnv`; unset = that mirror is skipped. [Repo mirrors](runtime-config.md#repo-mirrors). |

### Slack, Teams and the web chat

One installation runs one chat driver by its run command (`orch slack`, `orch teams`, `orch web`) and
optionally more beside it. [Chat surfaces](runtime-config.md#chat-surfaces-chat_surfaces).

| Variable | Default | What it does |
|---|---|---|
| `CHAT_SURFACES` | — (the run mode only) | Further chat drivers beside the run mode's, comma-separated (`teams`, `web`); validated at boot. |
| `AVEN_ALERT_CHANNEL` | — (no alerts) | A channel id (Slack or Teams) the bot posts its own operator alerts to. |
| `SLACK_APP_TOKEN` | required for `orch slack` | The app-level token (`xapp-…`, Socket Mode). Unset = no Slack. |
| `SLACK_BOT_TOKEN` | required unless OAuth is set | The bot token (`xoxb-…`). With OAuth, optional: it seeds the home workspace's installation. |
| `SLACK_CLIENT_ID` | — | Multi-workspace OAuth install: set all three of these, or none (a partial set stops the boot). [Multi-workspace installs](multitenancy.md#enabling-multi-workspace-installs-operator-steps). |
| `SLACK_CLIENT_SECRET` | — | The OAuth client secret. |
| `SLACK_STATE_SECRET` | — | Signs the OAuth `state` cookie. |
| `SLACK_OAUTH_PORT` | `3000` | The OAuth install/redirect HTTP listener. |
| `SLACK_SCOPES` | the manifest's bot scopes (`src/config.ts`) | Bot scopes requested at install, comma-separated. |
| `SLACK_HOME_TEAM_ID` | — (resolved from `SLACK_BOT_TOKEN`) | The installation's own workspace (pollers, alerts, recovery run there). |
| `SLACK_ALLOWED_TEAMS` | — | Transitional extra allow-list of team ids beside the `workspaces` block. |
| `AVEN_CONTACT` | `the CoachAven team` | Who an installed-but-unconfigured workspace is told to contact. |
| `SLACK_CHANNEL_PREFIX` | `aven-` | Channel-name wildcard: `<prefix><slug>` binds to a project. A `workspaces` entry's `channelPrefix` overrides it per workspace. |
| `SLACK_COMMAND` | `/aven` | The slash command the bot answers (a dev app needs its own). |
| `SLACK_NOTE_PREFIX` | `!` | A message starting with it is a human-only note: no turn. |
| `SLACK_NOTE_REACTION` | `shushing_face` | The reaction a skipped note gets. |
| `TEAMS_APP_ID` | required for `orch teams` | The Teams bot's app id; all three ids or none (partial stops the boot). [Running a Teams installation](teams.md#running-a-teams-installation). |
| `TEAMS_APP_PASSWORD` | required for `orch teams` | The bot's client secret. |
| `TEAMS_TENANT_ID` | required for `orch teams` | The Entra tenant. |
| `TEAMS_PORT` | `3978` | The loopback listener for `/api/messages`. |
| `TEAMS_STATUS_MIN_MS` | `2000` | Minimum interval between edits of one status card. |
| `TEAMS_OPERATORS` | — | Comma-separated Teams user ids or Entra object ids: operator verbs and access admins. |
| `TEAMS_TARGETED` | off | `1`: private replies as targeted messages in the thread (1:1 chat as fallback). |
| `TEAMS_TRACE` | off | `1`: one journal line per inbound activity's shape; `full`: whole bodies and API calls, scrubbed (staging only). |
| `WEB_AUTH` | `oidc` | The web chat's login: `oidc`, `link` (a per-boot sign-in link, localhost base URL) or `none` (loopback only). Any `WEB_*` set turns the web surface's config on. [Web chat](web.md#running-a-web-installation). |
| `WEB_OIDC_ISSUER` | required with `oidc` | The issuer (https). |
| `WEB_OIDC_CLIENT_ID` | required with `oidc` | The OIDC client id. |
| `WEB_OIDC_CLIENT_SECRET` | required with `oidc` | The OIDC client secret. |
| `WEB_OIDC_GROUPS_CLAIM` | `cognito:groups` | The token claim `group:<name>` entries of `WEB_ALLOW` match. |
| `WEB_BASE_URL` | required with `oidc`; `http://localhost:<port>` with `link`; `http://127.0.0.1:<port>` with `none` | The public origin (login redirect, permalinks). |
| `WEB_SESSION_SECRET` | required with `oidc`; with `link`, generated once into `web-session.secret` in `AVEN_DIR`; with `none`, random per boot | Signs the session cookie (at least 32 characters). |
| `WEB_ORG` | the issuer's hostname; `local` with `link`/`none` | The organization behind the issuer: the web surface's tenant id. |
| `WEB_OPERATORS` | — | Comma-separated OIDC subjects or e-mails: operator verbs and access admins. |
| `WEB_ALLOW` | — (everyone the issuer lets in) | Comma-separated e-mails or `group:<name>`. |
| `WEB_PORT` | `8787` | The listener's port. |
| `WEB_BIND` | `127.0.0.1` | The listener's address (`none` requires loopback). |
| `WEB_MAX_FILE_MB` | `20` | Upload limit per file and per post. |

### Turns and limits

| Variable | Default | What it does |
|---|---|---|
| `TURN_MAX_CONCURRENT` | `4` | Agent turns running at once across all conversations; the rest wait for a slot. [Multi-tenancy → capacity](multitenancy.md). |
| `STREAM_MAX_MINUTES` | `15` | Soft turn deadline: past it the user is told the turn is still working. |
| `STREAM_HARD_MAX_MINUTES` | `60` | Hard turn deadline: the turn is killed and the session retired; also how long lingering work keeps an idle sandbox up. |
| `WORKTREE_REAP_HOURS` | `12` | Idle hours before a clean, fully pushed git worktree in a sandbox is reaped. |

### Routines and housekeeping

| Variable | Default | What it does |
|---|---|---|
| `ROUTINE_GUARD` | off | `1`/`true`: missed-slot catch-up, outcome plus one retry, the "previous run" preamble. Read once at boot. [Routine delivery guard](runtime-config.md#routine-delivery-guard-routine_guard). |
| `ROUTINE_GUARD_CATCHUP_HOURS` | `6` | How long after its slot a missed run is still fired (and retried). |
| `ROUTINE_GUARD_RETRY_MINUTES` | `15` | Minimum delay before the one retry of a failed run. |
| `ROUTINE_SKIP_EMPTY` | off | `1`/`true` (needs the guard): a slot with nothing new posts one line instead of a turn. |
| `HOUSEKEEPING_DISK_PCT` | `80` | Disk-use percentage (1 to 99) at which housekeeping prunes Docker; below it, it only reports. [Housekeeping](housekeeping.md). |
| `DISPATCH` | — | Retired: still set, it earns one boot warning and changes nothing. [Dispatch](runtime-config.md#dispatch-dispatch--retired). |

### MCP gateway

| Variable | Default | What it does |
|---|---|---|
| `GATEWAY_OAUTH_ID` | — | The installation's gateway client id, used by every `gateway-m2m` entry whose project has no pair of its own. [MCP gateway](runtime-config.md#mcp-gateway-per-project). |
| `GATEWAY_OAUTH_SECRET` | — | Its secret. |
| `GATEWAY_OAUTH_<SLUG>_ID`, `GATEWAY_OAUTH_<SLUG>_SECRET` | — | A project's own client (slug upper-cased, other characters `_`); wins over the installation pair. Both halves or neither. |
| `${NAME}` in an `mcp` entry | — | Any variable an `mcp` entry's `env` or `headers` value references is resolved from the bot's environment when the sandbox's MCP config is written; unset resolves to an empty string. |

### YouTrack

The support-ticket investigation poller: on only when both `YOUTRACK_URL` and `YOUTRACK_TOKEN` are set.

| Variable | Default | What it does |
|---|---|---|
| `YOUTRACK_URL` | — | The YouTrack base URL. |
| `YOUTRACK_TOKEN` | — | A read-only permanent token (it must read activities for `YOUTRACK_ENGLISH_TAGGERS`). |
| `YOUTRACK_LABEL` | `AI auto review` | The tag that triggers an investigation. |
| `YOUTRACK_PING` | — | Comma-separated chat user ids to mention with each finding. |
| `YOUTRACK_ENGLISH_TAGGERS` | — | Comma-separated logins or e-mails whose tag means the write-up comes back in English. |

### Sources

| Variable | Default | What it does |
|---|---|---|
| `SOURCES_DAEMON` | off | `1` on the bot: a sources daemon on this host ingests every project; the bot pulls none. [Sources daemon](runtime-config.md#sources-daemon-sources_daemon-sourcesdaemon). |
| `SOURCES_DAEMON_TOKEN` | required for `orch sources daemon` | The daemon's bearer; the bot holds a copy under the name a project's `sources.daemon.tokenEnv` gives. [Remote access](sources.md#remote-access). |
| `SOURCES_SERVE_TOKEN` | required for `orch sources serve` | The bearer of a single project's served replica. |
| `tokenEnv` variables | — | A project's `sources.youtrack.tokenEnv`, `sources.wrike.tokenEnv` and `sources.daemon.tokenEnv` name further variables the bot reads (often `YOUTRACK_TOKEN` and `SOURCES_DAEMON_TOKEN`). [Sources → Config](sources.md#config). |
| `TZ` | `UTC` | Fallback zone of the local-activity source when `AVEN_TZ` is unset. |
| `WRIKE_API_TOKEN` | — | The Wrike permanent token a project's `sources.wrike` block reads when it names no `tokenEnv` (only such a project reads it). [Sources → Wrike](sources.md#wrike). |

### Agent messaging and the hub

| Variable | Default | What it does |
|---|---|---|
| `INSTALLATION_ID` | `local` | This installation's name in every agent address (`[a-z0-9-]{1,32}`, invalid stops the boot); must be explicit for the hub. [Agent messaging](runtime-config.md#agent-messaging-messaging-installation_id-hub_url-hub_key_path). |
| `HUB_URL` | — (no hub connection) | `wss://` URL of the messaging hub. Without an explicit `INSTALLATION_ID` and `HUB_KEY_PATH`: one error, messaging inside the installation only. [Joining a hub](hub.md#joining-a-hub). |
| `HUB_KEY_PATH` | — | The installation's key file (`orch hub keygen`; relative = in `AVEN_DIR`). |

### Observability

| Variable | Default | What it does |
|---|---|---|
| `SENTRY_DSN` | — (Sentry off) | Turns on error, trace and (opt-in) log reporting. [Observability](observability.md#config-env). |
| `SENTRY_ENVIRONMENT` | `NODE_ENV`, else `production` | The Sentry environment name. |
| `SENTRY_RELEASE` | — | The release tag; the compose file sets it from the pinned version. |
| `SENTRY_TRACES_SAMPLE_RATE` | `1` | Trace sampling, 0 to 1. |
| `SENTRY_LOGS` | off | `1`: also stream structured logs (sends log content). |
| `AVEN_EVENT_LOG` | off | `1`: one metadata line per received Slack envelope into `events/<day>.jsonl`; `full`: plus the raw body (trusted workspaces only). [Fixtures](fixtures.md). |

## Operator and test-only variables

These are **not for an installation's `.env`**. They are read by the bench, the probe, one-off `orch`
commands on an operator's shell, or tests; or they are standard variables of the host.

| Variable | Default | Read by |
|---|---|---|
| `LAB_DIR` | `data/lab` | The lab bench: datasets, runs and caches. [The lab](lab.md#running-it). |
| `LAB_ENV_FILE` | `.env` | The lab: the file `CLAUDE_CODE_OAUTH_TOKEN` is read from. |
| `LAB_CLAUDE_TOKEN` | — | The lab: its model token, ahead of `LAB_ENV_FILE`. |
| `LAB_CONCURRENCY` | `4` (`6` for `synth`) | The lab: parallel model calls. |
| `LAB_OPT_<KEY>` | — | The lab: variant parameters, set from `--opt key=value`. |
| `CLI_PROBE_TOKEN` | — | The CLI probe: a subscription token for a live run. [CLI probe](cli-probe.md#running-it). |
| `CLI_PROBE_API_KEY` | — | The CLI probe: an API key instead. |
| `CLI_PROBE_CACHE` | `~/.cache/coach-aven/cli-probe` | The CLI probe: where installed CLI versions are cached. |
| `CLI_PROBE_DEBUG` | off | The CLI probe: `1` prints the stack of an error. |
| `SLACK_API_BASE` | `https://slack.com/api` | The Slack source's client: a test's local mock only. |
| `MSGRAPH_API_BASE` | `https://graph.microsoft.com` | The Microsoft Graph source's client: tests only. |
| `MSGRAPH_LOGIN_BASE` | `https://login.microsoftonline.com` | The same, for the login endpoint. |
| `MSGRAPH_TENANT_ID`, `MSGRAPH_CLIENT_ID` | — | `orch sources auth … msgraph`: the `--tenant` / `--client` values when the flags are absent. |
| `SLACK_XOXB`, `SLACK_XOXP`, `SLACK_XAPP` | — (prompted) | `orch sources auth … slack`: the tokens for a scripted run instead of the hidden prompt. |
| `NETRC` | `~/.netrc` | A Jira source with `fromNetrc`: where its credentials file is. |
| `XDG_CONFIG_HOME` | `~/.config` | Where source credentials live (`coach-aven/sources/<slug>/`). [Credentials](sources.md#credentials). |
| `CLAUDE_CONFIG_DIR` | — | Set (not read) for the Claude Code children of the lab and the probe: their own config directory. |
| `CLAUDE_CODE_DISABLE_CLAUDE_MDS` | — | Set to `1` (not read) for the lab's Claude Code children, so no `CLAUDE.md` reaches them. |

The probe's sandbox transport also reads `SANDBOX_DRIVER`, `SANDBOX_HOST`, `SANDBOX_DIND_RUNTIME`,
`SANDBOX_IMAGE` and `SANDBOX_NAME_PREFIX` from its own environment, and labels its containers with its
own `SANDBOX_MANAGED_BY`.

## `projects.config.json`

`{ "projects": [ … ], "workspaces": { … } }`: `projects` holds one object per project, with the
fields below. Validated at boot and at `/aven reload`; a bad value stops
the boot (or keeps the old config, on reload) naming the project.

| Field | Type | Default | What it does | Applies to |
|---|---|---|---|---|
| `slug` | string | required | The project's id: the container `<prefix><slug>`, the channel `<prefix><slug>`, `projects.d/<slug>.md`. | everything |
| `repos` | string[] | required (at least one) | `Owner/name` repos cloned side by side; the first is the primary. The GitHub token is scoped to them. | new sessions (cloned at chat prep) |
| `slackChannel` | string | — (bound by name) | An explicit Slack channel id, overriding the name wildcard. | read per message |
| `teamsChannel` | string | — | The Teams channel id (`19:…@thread.tacv2`); Teams binds by id only. [Teams](teams.md). | read per message |
| `webRoom` | boolean | `true` | `false` hides the project from the web chat (no room, no deliveries). [Web chat](web.md). | read per request |
| `deliverTo` | string[] | — (the default surface) | Chat drivers that background deliveries (reviews, investigations) also go to. [Chat surfaces](runtime-config.md#chat-surfaces-chat_surfaces). | read per delivery |
| `systemPrompt` | string | — | The project's prompt layer, appended after the base prompt; `projects.d/<slug>.md` wins when present. | new sessions |
| `gitFlow` | `"pr"` \| `"direct"` | `"pr"` | How changes leave the sandbox: a worktree and a pull request, or commit and push on the checkout's branch. | new sessions |
| `env` | object | — | Reserved for per-project sandbox variables: accepted, not read by this build. | — |
| `mcp` | `McpServerSpec[]` | — | The project's MCP servers: `name` plus `command`/`args`/`env` or `url`/`headers`; `auth: "gateway-m2m"` with an `oauth` object for the gateway; `${NAME}` references resolve from `.env`. [MCP gateway](runtime-config.md#mcp-gateway-per-project). | new sessions |
| `driver` | `"ssh-docker"` | `SANDBOX_DRIVER` | The sandbox driver; any other value stops the boot. [Selecting the driver](sandbox-drivers.md#selecting-the-driver). | boot, reload |
| `cliVersion` | string (`x.y.z`) | `CLAUDE_CLI_VERSION` | This project's Claude Code CLI pin: the canary knob. | chat prep, housekeeping |
| `youtrackProjects` | string[] | — | YouTrack id prefixes whose tagged tickets this project investigates. | each poll |
| `sandbox` | object | `{ "privileged": false, "dind": false, "mounts": [] }` | How the container runs: plain by default; `"dind": true` for docker-in-docker (implies `privileged`), read-only `mounts`, its own `image` (else `SANDBOX_IMAGE`). [Sandbox drivers](sandbox-drivers.md#ssh-docker). | new containers only (`docker rm` to apply) |
| `scrubSecrets` | boolean | `true` | Redacts secrets from what people type before it reaches the model; `false` opts out. | new sessions |
| `sources` | object | — | Mail, chat, calendars, trackers and recorded calls ingested for the project, and an optional `daemon` (`url`, `tokenEnv`). [Sources → Config](sources.md#config). | each poll; the tools at session open |
| `messaging` | object | — | Agent messaging: `send`, `accept`, `description`, `skills`, caps. Refused on a project several workspaces share. [Agent messaging](agent-messaging.md#turning-it-on). | read per call |

The top-level **`workspaces`** block (optional) maps a tenant id (the tenant the chat surface reports: a Slack
team `T…` or enterprise `E…`) to the projects it may see: either a slug list or `{ "projects": [ … ], "channelPrefix": "…" }`,
where `channelPrefix` overrides `SLACK_CHANNEL_PREFIX` for that workspace (`""` = the channel name is the
slug). Absent, the home workspace owns every project; present, membership is explicit-only, and an
unknown slug stops the boot. The first workspace listing a slug owns it for the pollers.
[Multi-workspace installs](multitenancy.md#enabling-multi-workspace-installs-operator-steps).

Settings of the deploy tooling (`deploy.env`, `compose/.env`: `CHAT_DRIVER`, the pinned version) are not
read by the bot; they are in [`infra/deploy/README.md`](../infra/deploy/README.md).
