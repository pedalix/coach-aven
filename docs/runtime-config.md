# Runtime config & Slack admin editing

Change a project's configuration **without a redeploy/restart** — hot-reload the registry,
and let admins edit safe fields (the project system prompt) from Slack.

> **Status: hot-reload shipped.** `/aven reload` re-reads `projects.config.json` +
> `projects.d/*.md` and swaps the live registry (everything holds a `RegistryRef` and
> reads `.current` per use); a parse failure keeps the old config. System prompts now
> live as markdown files beside the config — `projects.d/<slug>.md` (a non-empty file
> wins over the JSON `systemPrompt` field, kept as fallback) — synced by
> `npm run ops -- <slug> export`/`import`. Prompts/MCP bake into a session at `openChat`, so running
> conversations keep their setup until their persistent claude process ends.
> Still open below: the Slack **editing** half (modal + state-overrides).

## Why

Today `projects.config.json` is read **once at boot** (`loadProjects`), so any change needs
`export` + `restart` (`npm run ops -- <slug> …`). Two pains:

- restart latency for any config tweak;
- no self-serve — only an operator with the deploy machinery can change anything.

## Scope — soft vs structural

Not all fields are equal in risk. Only **soft** fields are runtime-editable from Slack;
**structural** fields stay on file + deploy (`/manage-project` skill), because they're tied to
sandbox state.

| Field | Runtime-editable from Slack? | Why |
| --- | --- | --- |
| `systemPrompt` | **yes** | read at `openChat` → `buildSystemPrompt` (`src/prompt.ts`); applies on a fresh session |
| `gitFlow` | yes (reload is enough) | `"pr"` (default) or `"direct"` — how the agent gets changes out of the sandbox, as told in the base system prompt (`src/prompt.ts`): `pr` = a dedicated worktree off the remote default branch + a pull request (code under review); `direct` = `git pull --rebase --autostash`, commit on the checkout's current branch, push, and reference the Slack thread in the commit message (a repo with no review flow, e.g. an ops ledger the agent itself keeps). Explicit only — never inferred from repo names or `sources`. Read when a session opens; running conversations keep theirs |
| `mcp` | maybe, with session recycle | `--mcp-config` is set at process spawn → needs a restart of the project session |
| `repos` | no | changes clone layout, cwd, token scope, worktrees → re-prepare the sandbox |
| `cliVersion` | no (reload is enough) | the per-project Claude Code CLI pin (canary override of `CLAUDE_CLI_VERSION`) — applied in place at the next chat prep / nightly housekeeping; see `snapshot/README.md` |
| `slug` / `slackChannel` | no | routing keys (`dm:…:<slug>`, `cmd:…:<slug>`) — changing orphans live sessions |
| `sandbox` | no | `{ privileged, dind, mounts }` are `docker run` flags — they apply to a NEW container only; an existing `proj-<slug>` keeps its flags until it is removed on the sandbox host and recreated by the next turn (`docs/sandbox-drivers.md`); `dind: false` also drops the Sail/Docker-in-Docker toolchain paragraph from the base system prompt (`src/prompt.ts`, new sessions) |
| `scrubSecrets` | yes (reload is enough) | read when a session opens; `false` turns off the redaction of pasted passwords/tokens/DSNs before model input (`src/scrub.ts`). Default on |
| `sources` | partly (reload re-reads intervals/accounts for the next pull) | which mail/chat/calendar/file systems, task trackers (YouTrack, Jira, Asana, Wrike) and meeting recorders (Granola, Gemini in Meet, Wispr) the BOT pulls for this project into `data/<slug>/raw` (`docs/sources.md`); credentials are bootstrapped separately with `orch sources auth` and live under `~/.config/coach-aven/sources/<slug>/`, so adding a source needs that one-time step on the host as well; `sources.tenant` names the project's repo of decisions (people with markers, fragments → initiatives) that the bot fetches and indexes before each build; the store replica mount (`/data/sources`) is added to the project's sandbox options automatically, and that applies at container creation (recreate `proj-<slug>` after turning sources on) |

The soft/instructional needs are largely already covered by [project memory](memory.md)
("запомни для проекта: …"). So Slack editing here focuses on the deliberate
`systemPrompt`, not a full config editor.

## Design

### 1. Hot-reload (no restart)

- Re-read `projects.config.json` and **atomically swap** the in-memory `registry`.
- Trigger: `/aven reload` (admin) and/or a file watch. Removes restart latency from the
  existing `export` flow even before any Slack editing.

### 2. State-overrides (the truth-source fix)

- **File config = structural base** (deploy-managed). **Slack edits = overrides in
  `state.json`** (server-owned, *not* touched by `export`/`import`).
- Effective config = `fileConfig ⊕ stateOverride`. This is why Slack edits must NOT write
  `projects.config.json`: the next `export` would clobber them.
- `/aven prompt` → modal (`views.open`) prefilled with the current prompt → save → write
  override + apply.
- `/aven prompt reset` → drop the override, fall back to the file value (so a later
  file+deploy change isn't silently shadowed).

### 3. Apply semantics

- `systemPrompt` is baked at `openChat` → to apply, **evict the project's live sessions**
  from the `live` map so the next turn rebuilds with the new prompt.
- **To verify when building:** whether `--resume` carries the old system prompt from the
  transcript — if so, a prompt change should start a fresh session rather than resume.

### 4. Guardrails

- **Authz:** admins only — allowlist of Slack user ids / emails (`users:read.email`).
- **Validation:** validate before applying (valid JSON / non-empty prompt).
- **Audit:** record who changed what (the traceability theme — Slack user → change).

## Boundaries

- **Structural changes** (add a repo, new project) → file + deploy via the `/manage-project` skill, not here.
- **Memory** (the learned layer) → [memory.md](memory.md). `/aven prompt` edits the
  deliberate layer; `/aven memory` reads the learned one.

## Open decisions

- Hot-reload trigger: explicit `/aven reload` vs. file watch (or both)?
- Beyond `systemPrompt`, is `mcp` worth making runtime-editable (with session recycle)?
- Modal UX details for multi-line prompt editing.

## Related

- [Project memory](memory.md) — read-only `/aven prompt` lands there; soft instructions via memory.
- Config loading: `loadProjects` / `registry` in `src/projects.ts`, `src/chat/slack/app.ts`.
- Server-owned state that survives deploy: `state.json` (`src/state.ts`).

## Installation directory (`AVEN_DIR`)

Everything an installation **has** lives in one directory, the installation directory (OpenSpec
`installation-directory`): the configuration the bot reads — `.env`, `projects.config.json` with
`projects.d/<slug>.md` and `hub.peers.json` beside it, `mirrors.json`, the GitHub App key under the name
`.env` gives it — and every file the bot writes at runtime: `state.json`, `queue.jsonl`, `usage/`,
`drafts/`, `facts/`, `memory/`, `feedback/`, `events/`, `shadow/`, the mirror job's `mirrors/`, and `data/`
unless `AVEN_DATA_DIR` names another place. The layout is the ops overlay's (`infra/<slug>/`), so an
overlay checkout with its two secret files in place is a complete installation directory.

- **`AVEN_DIR`** names it. Unset or empty = the package root, which is where every unit and npm script
  runs today, so nothing moves until an installation sets it. A compose installation sets it to the
  directory it mounts (`infra/deploy/README.md`).
- **Relative path settings resolve against it**, never against the working directory: `PROJECTS_CONFIG_PATH`,
  `AVEN_DATA_DIR`, `MIRRORS_CONFIG`, `GITHUB_APP_PRIVATE_KEY_PATH`, `HUB_KEY_PATH`. An absolute value is used
  as it is. A path given on a command line keeps resolving against the shell's directory, as with any tool.
- **It comes from the process environment only** — the compose file or the shell — and must be
  absolute. It says where `.env` is, so `.env` cannot set it: a `.env` that does, or a relative value, stops
  the boot with one sentence naming the setting. The boot logs `installation directory: …` once, before the
  chat driver starts.
- Only the bot's own assets (fixtures, static files, workers) are located beside the code; `src/paths.test.ts`
  fails the suite when code under `src/` locates a runtime file through its own location or the working
  directory. The error tracker's release is `SENTRY_RELEASE`, which the compose file sets from the pinned version.

## MCP gateway (per project)

A project can reach all its MCP sources through the gateway (bluefin-infra `engine/`, agentgateway at
`https://<gateway-host>/gw/<slug>/mcp`) instead of listing each upstream. The entry names the route and how the
bot asks for its token:

```json
"mcp": [{
  "name": "gw",
  "url": "https://<gateway-host>/gw/<slug>/mcp",
  "auth": "gateway-m2m",
  "oauth": { "tokenUrl": "https://<tenant>/oauth/token", "audience": "https://<gateway-host>/gw/<slug>/mcp" }
}]
```

- The bot is a machine client of the installation's identity provider and holds one token **per route**. The
  orchestrator mints it with a standard OAuth 2.0 client-credentials request (RFC 6749 §4.4, `src/gwtoken.ts`),
  caches it, and writes only the token into the sandbox (`/root/.aven/gw-token-gw`, 600) every turn. Claude Code
  reads it through the server's `headersHelper` (`/root/.aven/gw-headers.sh`), which also sends `x-aven-session`
  (the chat key) — the gateway logs it as `aven_session`, joining its audit to our event log. Nothing of `oauth`
  and no credential reaches the sandbox.
- What the bot may do is decided by the gateway's route policy, not here. Tool names become
  `<source>_<tool>` (e.g. `youtrack_search_issues`); the project prompt should map them.
- Name the entry `gw` — `steps.ts` renders `mcp__gw__<target>_<tool>` by target.

### Credentials: one pair per installation

- `GATEWAY_OAUTH_ID` / `GATEWAY_OAUTH_SECRET` in the bot's `.env`: the installation's bot client, used by every
  `oauth` entry whose project has no pair of its own.
- `GATEWAY_OAUTH_<SLUG>_ID` / `_SECRET` (the slug upper-cased, other characters → `_`): a project's own client,
  which wins — for a project on another identity provider, or one you want to revoke at the provider on its own.
  Set both halves or neither: a half pair fails that project and never falls back to the installation pair.
- One client is enough because the isolation is the token, not the client: every pair would sit in the same
  `.env`, and only a project's own route token enters its sandbox. So **each entry asks for its own route's token**
  (its own `audience` or `scope`): two projects on the installation pair asking for the same token fail the config
  load (boot, `/aven reload`), naming both — a copied entry would otherwise hand one project a token that works on
  the other's route. And **the gateway binds each token to its route** (see the provider notes below).
- Revoking one project's bot: take `<slug>:bot` (or whatever the route policy grants the bot) out of that route's
  policy — immediate. At the provider, removing the route's grant only stops new tokens; issued ones live out their
  lifetime. Rotating the secret: one value in `.env`, then a restart (credentials are read at first use).

### The `oauth` object

- Fields: `tokenUrl` (https only), and optionally `scope` (sent as is), `audience` (servers that take Auth0's
  parameter), `resource` (RFC 8707), `clientAuth` (`basic`, the default: HTTP Basic as RFC 6749 §2.3.1 wants; or
  `post`: id and secret in the form body). A malformed object, or one carrying a credential, fails the config load
  naming the project.
- Lifetime: the bot replaces a cached token once less than min(1 h, half its lifetime) is left. A **1-day** access
  token gives one mint per route per day (plus one per route after a restart); a shorter lifetime works, with more
  mints.

**Auth0.** `"oauth": { "tokenUrl": "https://<tenant>/oauth/token", "audience": "<the route URL>" }`.

- In the tenant: one API per route (identifier = the route URL) and ONE machine-to-machine client for the bot with
  a grant on every route API. A free tenant caps applications (M2M clients included) and APIs at 10 each, so a
  client per project runs out early. Claims for the route policy (e.g. `<slug>:bot`) can come from a
  credentials-exchange Action that reads the requested audience.
- `audience`, not `resource`: Auth0 answers RFC 8707 `resource` on client credentials with 400 `invalid_request`.
- The gateway's half: the route's authentication pins `audiences` to the route URL, so a token for another route
  gets 401. Auth0's default API token lifetime is 24 h; a free tenant allows 1000 M2M tokens a month.

**Amazon Cognito** (or any server whose tokens carry no `aud`). `"oauth": { "tokenUrl": "https://idp.example/oauth2/token", "scope": "gw-<slug>/bot" }`.

- `scope` is `<resource-server>/<scope>`, one per route; HTTP Basic (the default) is what Cognito wants. App-client
  access-token lifetime: 5 minutes to 1 day, default 1 hour — set 1 day.
- The gateway's half: Cognito's client-credentials tokens carry `client_id` and a space-delimited `scope` and **no
  `aud`**, so leave `audiences` out of the route's authentication (agentgateway: issuer + JWKS only) and authorize in
  the route policy by **the route's own scope** (`jwt.scope` contains `gw-<slug>/bot`). With one installation
  client, `jwt.client_id` alone no longer tells the projects apart; check it in addition if you like.

### Upgrading from an entry without `oauth`

Until v0.44.0 a `gateway-m2m` entry without `oauth` minted with an Auth0-specific request (a JSON body,
`AUTH0_M2M_TOKEN_URL` + `AUTH0_M2M_<SLUG>_ID/_SECRET`). That request is gone: such an entry now fails the config
load, naming the projects. To move an installation:

1. Every gateway entry gets `"oauth": { "tokenUrl": "<the value of AUTH0_M2M_TOKEN_URL>", "audience": "<the entry's url>" }`.
2. `.env`: `GATEWAY_OAUTH_ID` / `GATEWAY_OAUTH_SECRET` = the bot client (when all projects use one), or a
   `GATEWAY_OAUTH_<SLUG>_*` pair per project; the `AUTH0_M2M_*` lines can go (nothing reads them).
3. `npm run ops -- <slug> export`, then `restart` (the env is read at boot); each project's next turn mints once.

**Rollback of the gateway itself** (one edit): in `projects.config.json` move the project's `mcpDirectBackup` list back
to `mcp` (a project may keep its pre-gateway list there), `npm run ops -- <slug> export`, `/aven reload`; running
conversations keep the old config until their claude process ends (or restart the bot to recycle).

### A `sources` entry with a `url`

A project whose `mcp` list declares `{ "name": "sources", "url": …, "auth": "gateway-m2m" }` reaches its
store through the gateway (`orch sources serve`, docs/sources.md → *Remote access*) and gets **no**
replica mount — the sandbox may live on another host. Everything else about the project (pullers,
builds, the prompt paragraph) stays as for a mounted project.

## Repo mirrors

Some repos a project needs live outside the App's installations (the HSX studio in the old
`BluefinAG` org, the Vallora studio in `vendor-labs/omni-cms-v2`). A project's GitHub
token is minted from ONE installation, so they can't simply be listed in `repos[]`. Instead
`orch mirror` keeps a **one-way, read-only mirror** of each in BluefinOrg, and the
project lists the mirror. Upstream stays the source of truth — the project prompt tells the
agent not to push or open PRs there.

- **Where it runs:** the deployer's crontab on the prod box, every 30 min —
  `*/30 * * * * cd /var/www/coach-aven/compose && docker compose --progress quiet run --rm --no-deps bot mirror >> /var/www/coach-aven/mirrors/mirror.log 2>&1`
  (`orch mirror` from the pinned version's image, with the bot's mounts and environment; `--progress quiet`
  keeps compose's container lines out of the log). Not GitHub Actions: the write side needs the App key, which
  must not leave the box.
- **Credentials:** read = `MIRROR_SRC_<OWNER>` fine-grained PATs (Contents:read, that repo only)
  in the runtime `.env`; write = an App token minted per run, scoped to the one mirror repo with
  `contents` + `workflows` write. Failures go to Sentry (tag `mirror`) and `mirrors/mirror.log`.
- **Adding a mirror:** create the private repo in BluefinOrg, **disable its Actions**
  (`gh api -X PUT repos/<mirror>/actions/permissions -F enabled=false` — upstream deploy
  workflows would otherwise run on every sync), add an entry to the installation's
  `mirrors.json`, add the repo to the owner's PAT (or a new `MIRROR_SRC_*` line in the runtime
  `.env`), export.
- **The list is data:** `mirrors.json` in the installation's ops overlay (`infra/<slug>/mirrors.json`,
  uploaded beside `.env` by `npm run ops -- <slug> export`, pulled back by `import`) — an array of
  `{"src": "<owner>/<repo>", "dst": "<your-org>/<repo>", "srcTokenEnv": "MIRROR_SRC_<OWNER>", "note": "…"}`
  (`note` is a comment; example: `infra/deploy/ops.example/mirrors.example.json`). The job reads
  `MIRRORS_CONFIG` (a path) when set, else `mirrors.json` in the installation directory (`AVEN_DIR`, above);
  the bare repos are cached in `mirrors/` beside it. A missing or malformed list fails the run (exit 1,
  Sentry tag `mirror: config`) — it never mirrors nothing quietly.
- **No token → snapshot:** a mirror whose `MIRROR_SRC_*` is unset is skipped (logged, no alert).
  `BluefinAG` is a *user* account where we're only collaborators — fine-grained PATs can't
  target it — so the HSX mirror stays a manual snapshot until those repos move into the org.
- Dependabot is enforced by the org's security configuration and can't be turned off per mirror;
  close any PR it opens there.

## Routine delivery guard (`ROUTINE_GUARD`)

Off by default. `ROUTINE_GUARD=1` in the runtime `.env` (read once at boot) makes a scheduled
routine **land or say why not**. With the switch unset the scheduler, the routine prompt and the
Slack output are byte for byte what they were before the guard existed — `src/routineguard.test.ts`
pins that — so production keeps the historical behaviour until the guard has proven itself on the
home bot. Everything is `src/routineguard.ts` (pure decisions, tested) wired by `src/pollers.ts`.

| Env | Default | Meaning |
| --- | --- | --- |
| `ROUTINE_GUARD` | unset (off) | `1` turns the four behaviours below on |
| `ROUTINE_GUARD_CATCHUP_HOURS` | `6` | how long after its cron slot a missed run is still fired, and a retry still allowed |
| `ROUTINE_GUARD_RETRY_MINUTES` | `15` | minimum delay before the one automatic retry of a failed run |
| `ROUTINE_SKIP_EMPTY` | unset (off) | `1` (with the guard on) adds the **empty-slot skip** below |

What it does (report/task routines only — dreams and housekeeping keep their silent paths):

1. **Missed-fire catch-up.** The scheduler used to match the live wall-clock minute only, so a
   slot the process did not observe (laptop asleep, restart or deploy across the minute, a fire
   skipped because the previous run was still in flight) was lost. Now every tick — the first one
   at boot included — also fires a routine whose most recent cron occurrence is later than its
   `lastRunAt` and no older than the grace window, as a **late run**: the parent message reads
   `📋 Morning brief · late run (missed 08:30) · running…`. `lastRunAt` is stamped at fire, so a run
   that fired and failed is not re-fired by this path (that is the retry's job), and a routine that
   never ran is owed only slots after its `createdAt`.
2. **Outcome on record + one retry.** When the run's turn settles, the routine record gets
   `lastOutcome` (`ok` / `error` / `canceled`), `lastDeliveredAt` + `lastSummary` (the answer's
   headline) on success, `lastReason` on error — and a failed run's parent is rewritten to
   `⚠️ <label> — failed: <reason>` instead of staying at `running…` forever. A **scheduled or late**
   run that errored is re-fired ONCE, ≥ `ROUTINE_GUARD_RETRY_MINUTES` later, provided the retry
   still falls inside the slot's grace window; the pending retry lives on the record (`retry:
   { at, slot }`), so it survives a restart, and is consumed by whatever fire of the routine comes
   first (a manual `/aven routines run` counts). A retry's own failure, a manual run's failure and a
   cancel are recorded, not re-fired. The scheduler logs every fire with its kind and every skip
   with its reason (in flight / no client / tenant lost / project gone / already fired this minute
   by a previous process / retry dropped: disabled, window passed, last run did not fail).
3. **Deterministic "previous run" line.** Every routine prompt is prefixed with one bot-rendered
   line from state — `[Routine state] Previous run of this routine: ok at 2026-10-13T05:31:12Z
   (08:31 Europe/Moscow) (delivered: …)` / `error at … (not delivered: <reason>)` / `missed at …
   — the scheduled run did not fire` / `started at …, outcome not recorded` (the bot restarted
   mid-run) / `none recorded` — plus, for a late run or a retry, what this run is. The LLM never
   decides whether yesterday's run happened.
4. **Tolerant GitHub preflight.** `gh auth login --with-token` (the one network round-trip in
   `seedGitHubAuth`, `src/project.ts`) is retried on transient output (`src/gitretry.ts`) and, if it
   still fails, logged as a warning and skipped — git itself needs no network at seed time, and a
   later `gh` call fails visibly inside the turn. With the guard off it stays fatal, as before.

Not gated (no-ops in prod by construction): the `ssh-docker` mount probe now **fails** `ensureSandbox`
when a bind mount is still empty after the recycle (prod projects mount nothing), and every usage
record of a routine turn carries `routineId` / `routineLabel` (additive).

### Empty-slot skip (`ROUTINE_SKIP_EMPTY`)

A scheduled run costs a full model turn even when the world did not move (the 2026-10-14 09:04
brief spent one to say "almost nothing new since 08:31"). With `ROUTINE_SKIP_EMPTY=1` (needs
`ROUTINE_GUARD=1`; read at boot) a **scheduled or late** fire of a report/task routine whose project
has `sources` first asks the host, deterministically (`routineguard.ts emptySkipDecision`, tested):

- **delta** — the raw-record count of the project's replica (`data/<slug>/replica/store.sqlite`,
  `raw_records`: one row per pulled line, inserts only) minus the count recorded when this routine
  was last delivered (`lastDeliveredRawCount` on the record, written at settle). A lower count
  means the store was rebuilt → fire;
- **due** — the tenant checkout's ledgers (`annotations/escalations.jsonl` with status `open`,
  `ledger/commitments.jsonl` still `proposed`/`confirmed` with `due` on or before today in the
  routine's tz; last line per id wins, `src/sources/tenant.ts readDueNow`). No tenant → nothing due;
  a checkout that is not there yet → fire;
- **freshness** — every configured source's last pass must be ok and younger than two
  `intervalMinutes` (`sources_sync` facts); a stale or failed source turns the skip into a normal
  fire, the same rule the prompt gives the agent.

When delta is 0, nothing is due and every source is fresh, the host posts one parent line —
`📋 Morning brief — ⏭ nothing new since 2026-10-14T05:31:40Z (08:31 Europe/Moscow) (sources: slack 3 min,
youtrack 12 min)` — stamps the routine `lastRunAt` + `lastOutcome: skipped` (the slot counts as served:
no minute re-fire, no catch-up), keeps the last *delivered* run's fields, and runs no turn: no
sandbox call, no usage record. Everything else fires as before and the log says why (`not skipped —
7 new raw record(s) …` / `due: 1 open escalation(s) …` / `stale source(s): slack 31 min`). A manual
`/aven routines run`, a retry, dreams and housekeeping never skip; a routine opts out with
`skipEmpty: false` on its record (`state.json`). `/aven routines` shows `⏭ skipped (nothing new)`
and the next real run's preamble reads `skipped at … (last delivered: …)`. Nothing is judged by
content — "nothing interesting" stays the agent's call.

**State fields added** to `RoutineRecord` (`state.json`, written only while the guard is on; absent
on prod records): `lastOutcome`, `lastReason`, `lastDeliveredAt`, `lastFire`
(`scheduled|late|retry|manual`), `retry: { at, slot }`; `lastSummary` is reused for the delivered
headline; with the empty-slot skip also `lastOutcome: 'skipped'`, `lastDeliveredRawCount` and the opt-out
`skipEmpty`. All are cleared at every fire and set at settle. Nothing to migrate: old records simply
have none of them, and the first guarded fire renders `none recorded` / `outcome not recorded`.

**Restarting the home bot.** The code is read at boot, so a change needs
`systemctl --user restart coach-aven-home`. Do it in the **20:30–08:00 Europe/Moscow window**, and
never at **08:30 / 18:30 / 19:30 ±1 min** (the r1/r2/r3 fire minutes): without the guard a bot down
across the minute loses the fire (no catch-up) and a restart inside the minute right after the fire
double-fires it (`firedThisMinute` is in-memory); with the guard on both are covered (late run;
`lastRunAt` dedupe), but a restart *during* a run still leaves its parent at `running…` — recovery
re-posts the answer, not the headline — so keep the window anyway. The Home tab (`homeBlocks`,
`src/chat/slack/blocks.ts`) needs no change: the guard adds no command or button. To switch it on at home:
add `ROUTINE_GUARD=1` to the checkout's `.env`, restart in the window, then watch the next 08:30
run — its thread starts with the `[Routine state]` line and the journal shows `routine r1
(owen-ops): fired — scheduled` … `delivered — <headline>`.

## Host tools (the session control channel)

The bot serves some MCP servers to the agent **itself**, over the stream-json channel it already
drives every turn through — no mount, no listener, no credential in the sandbox, the same on
a remote Docker host and in local mode (OpenSpec `host-tools`; pure part `src/hosttools.ts`, routes
`src/hostrouter.ts`, framing `src/claudeSession.ts`). This is Claude Code's in-process MCP
mechanism, the one the Agent SDK uses: right after spawn the bot writes
`control_request{initialize, sdkMcpServers: [names], sdkMcpServerConfigs: {timeouts}}`; the CLI then
sends each server's handshake and every `tools/call` back as `control_request{mcp_message}`, and the
bot answers in `control_response.response.mcp_response`. The agent sees ordinary MCP tools
(`mcp__host__send_message`, `mcp__sources__search`, …) and the session's `init` lists them with
`source: "sdk"`. The CLI probe's `host-tool` contract scenario proves the round trip against every
probed CLI version (`docs/cli-probe.md`); `scripts/host-tools-smoke.mjs` remains for a manual check
inside a project's sandbox.

- **The caller is the session.** A tool call is attributed to the project and conversation of the
  session it arrived on; a project or thread named in the input is ignored.
- **`host`** — for a project with a `messaging` block: the messaging tools (below). Absent otherwise.
- **`sources`** — for a project with a `sources` block: the same twelve tools as before, answered
  from the replica on the bot host's disk on a worker thread (`src/sources/worker.mjs` — a heavy
  `unanswered` over a 200 MB personal store takes about a second and must not stall Slack acks).
  The sandbox holds no copy of the server and mounts nothing for it. See `docs/sources.md`.
- **A project's own server wins.** A project that declares an MCP server named `host` or `sources`
  keeps it; the bot registers nothing under that name.
- **Restarts.** A reattached session keeps its registration (the CLI process is the same); a call the
  old bot never answered is answered by the new one. Every stdin write of a session is serialised —
  a tool answer can be tens of KB and two writes over `PIPE_BUF` to one FIFO could interleave.

## Sources daemon (`SOURCES_DAEMON`, `sources.daemon`)

A project's sources can live with a daemon instead of the bot (`orch sources daemon`, docs/sources.md →
*Remote access*, OpenSpec `sources-daemon`). Two switches, both off by default:

- `SOURCES_DAEMON=1` in the bot's env — a daemon on THIS host ingests: the bot's sources poller and
  the 06:00 auth check run for no project. Set it (and restart the bot) before starting a daemon on the
  bot host; the daemon refuses to start while a live bot holds a project's data lock.
- `sources.daemon: { url, tokenEnv }` per project — the data lives with that daemon: the bot never
  pulls the project (whatever `SOURCES_DAEMON` says), forwards the agent's `sources` calls to it and
  reads its status. `tokenEnv` names the bot's env variable holding the daemon's bearer (the daemon
  reads its own copy from `SOURCES_DAEMON_TOKEN`).

Without either, everything is as before: the bot ingests and answers from its own replica.

## Agent messaging (`messaging`, `INSTALLATION_ID`, `HUB_URL`, `HUB_KEY_PATH`)

Agents asking agents — `docs/agent-messaging.md` (what it does, the `messaging` block), `docs/hub.md`
(between installations). Off unless configured:

| Setting | Where | What |
|---|---|---|
| `messaging` | per project, `projects.config.json` | `send`, `accept`, `description`, `skills` (the project's Claude Code skills its card offers: names, `*` globs and `!` exclusions, e.g. `["*", "!openspec-*"]`; none by default — `docs/agent-messaging.md` → *Skills*), daily caps, `maxRounds`, `costWarnUsd`. Read at call time; `/aven reload` applies it (open tasks whose asker is no longer accepted end `canceled: not accepted`). Refused on a project several tenants share. |
| `INSTALLATION_ID` | `.env` | This installation's name in every address (default `local`, enough inside one installation; must be explicit for the hub, where it is claimed by this installation's key or reserved for it — `local` and `hub` never can be). Invalid → the boot fails. |
| `HUB_URL` | `.env` | `wss://<hub>` — the bot keeps one outbound connection to the hub. Unset: no connection. Set without an explicit `INSTALLATION_ID` or `HUB_KEY_PATH`: a loud error, and messaging inside the installation only. |
| `HUB_KEY_PATH` | `.env` | The installation's key file (`orch hub keygen`, mode 0600). |
| `hub.peers.json` | beside `projects.config.json` | The peer installations this one may reach and their pinned public keys (lists, for rotation). `/aven reload` re-reads it; `deploy.sh export`/`import` carry it. |

Sessions are spawned with the message ledger (`--replay-user-messages`) only for projects with a
`messaging` block; a session opened before a reload keeps the mode it was spawned with.

## Chat surfaces (`CHAT_SURFACES`)

An installation runs one *default* chat driver — its run mode, `orch slack` or `orch teams` — and, with
`CHAT_SURFACES=<driver>[,<driver>]`, additional ones beside it (OpenSpec `multi-driver-installation`; `web` is one, `docs/web.md`): every running
driver is a *surface*, over one turn engine, one set of pollers and one agent-messaging identity. A conversation belongs
to the surface it started on for its whole life; the default surface's conversation keys keep the shapes a single-driver
installation has (no migration), an additional surface's carry the driver's name first (`teams:thread:…`). Unset =
the run mode only, exactly as before. The value is validated against the drivers this build has; every surface is
prepared before any starts, and one that cannot run (its settings missing, its port taken) fails the boot naming it,
so nothing half-starts. Each surface keeps its own identities, access gate, operators, command prefix, Home and alert
channel; a project is reachable from every surface it is bound on (`slackChannel`, `teamsChannel`; on the web every project has a room unless `webRoom: false`), with one sandbox.

Where background deliveries go: a routine delivers where it was created (its record remembers the surface). Deliveries
no conversation started — auto-reviews, ticket investigations — go to the project's channel on the default surface,
or, with `"deliverTo": ["slack", "teams"]` on the project, also to the surfaces named there: a review runs once and its
answer is posted to the other surfaces' channels; a ticket investigation lands on one surface, the first in that list
with a driver and a channel (its dialogs belong to that thread). The auto-review channel is the one `review auto on`
was typed in, on that surface.

## Model credit (`ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`)

The sandboxes' Claude Code runs on one credit per installation (OpenSpec `model-credit`): a Claude subscription token
to try CoachAven, an Anthropic API key for an installation that serves a team or clients. Set **exactly one**.

| Setting | Where | What |
|---|---|---|
| `CLAUDE_CODE_OAUTH_TOKEN` | `.env` | A subscription token (`claude setup-token`, starts `sk-ant-oat`). Every project shares the subscription's limits; `/aven usage` dollars are an API-list-price equivalent, not a bill. |
| `ANTHROPIC_API_KEY` | `.env` | An API key from the Anthropic console (starts `sk-ant-api`). `/aven usage` dollars are what the key is billed at list prices; no subscription quota is tracked. |

- **Checked at boot.** Both set stops the boot in one sentence, and so does a value in the other credit's variable (a
  token in `ANTHROPIC_API_KEY` or a key in `CLAUDE_CODE_OAUTH_TOKEN`); an unknown prefix passes. Neither set: a
  developer machine's own `~/.claude` login, else the boot stops naming both. The boot line names the credit and the
  variable it came from, never the value. `.env` does not override the shell: an exported `ANTHROPIC_API_KEY` counts.
- **Into the sandbox as a file.** The value is written to `/root/.cc-token` through the file API before each session
  and turn; the CLI's command reads it into `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY`, never through a command
  line. With a token the command is today's, byte for byte.
- **Exposure.** The sandbox can read the credit, as it can the token: anything that runs there (package scripts,
  dependencies, a client repository's tooling, text the agent reads) could. Use a dedicated key in its own Anthropic
  workspace with a monthly spend limit. Tool processes inherit it: on CLI 2.1.292 the Bash tool sees
  `ANTHROPIC_API_KEY` in its environment (`api-key-turn`, `docs/cli-probe.md`). A project's MCP `${ENV}` value can name `ANTHROPIC_API_KEY` like any bot
  variable; do not, unless the server needs it.
- **Confirmed per turn.** The CLI's own `apiKeySource` (`system/init`) decides which credit a usage record names; a
  disagreement with the configured credit logs one warning per session.

**Switching.** Put the new credit in the installation's `.env` in its ops repo, comment the old one out, `npm run ops --
<slug> export`, and restart the bot. The switch applies to new conversations: a running one keeps its credit until its
process ends (an idle stop, an error reopen), or at once when the project's container is recreated (`docker rm -f` of
it; the next turn creates it again). Back: the reverse.

## Repo skills (`REPO_SKILLS`)

A multi-repo project's sessions start in the project folder, where no repo's `.claude/skills` is visible. With
`REPO_SKILLS=1`, every such session starts with `--add-dir <checkout>` for each repo, so it loads each repo's own Claude
Code skills as a Claude Code started in that repo would (OpenSpec `agent-skills`); `--add-dir` also loads each repo's
legacy `.claude/commands/`. Off by default: unset or anything else, every spawn line stays as it was. Single-repo
projects are unaffected either way: their session starts in the repo, so it always loads all of that repo's skills and
commands, whoever asks.

`--add-dir` does **not** load a repo's `CLAUDE.md` (verified on CLI 2.1.292 with marker files); the CLI would with
`CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD=1`, which the bot leaves unset on purpose: every turn would carry every
repo's instructions, and rules from different repos can contradict each other. The base prompt tells the agent to read
the `CLAUDE.md` of the repo it works in instead.

| Setting | Where | What |
|---|---|---|
| `REPO_SKILLS` | `.env` | `1` turns repo skills on for the installation's multi-repo projects (their agent cards can then offer the repos' skills too). Unset or anything else: off. |

**Off everywhere; switch it on per installation when a skill worth it exists.** What turning it on brings: whatever
skills and commands the repos carry — typically OpenSpec workflow skills (`openspec-*`) and `/opsx` commands, plus a
few framework development helpers (a Laravel media-library or HTTP-client helper, a Tailwind helper). A skill or command
defined in two of a project's repos loads twice, and `/name` runs the first `--add-dir`'s (an agent card withholds such a
name, so this concerns only what the agent itself sees; how to load each name once is an open decision). Watch for skills the agent
starts using on its own. The canary installations are single-repo, so the multi-repo path rests on the live measurement
(design `agent-skills`) and the tests until an installation with a multi-repo project switches it on.

**Turning it on.**
1. Set `REPO_SKILLS=1` in the installation's `.env` in its ops repo — not on the box, which the next export would
   overwrite.
2. `npm run ops -- <slug> export`, then restart the bot.
3. Sessions already running, and sessions the restart reattaches, keep their old command line until they end, or until
   `🔄 Restart session` in their thread. Turning it off is the same with the line removed.

## Sandbox idle stop (`SANDBOX_AUTOSTOP_MINUTES`)

A project's sandbox stops after `SANDBOX_AUTOSTOP_MINUTES` without activity, and the next turn wakes it and
resumes the conversation with `--resume`. Docker has no idle lifecycle, so the bot does the stop itself
(OpenSpec `sandbox-idle-stop`; what counts as activity, what holds a container and
the log lines: `docs/sandbox-drivers.md` → *Idle stop*). Without it every conversation touched since a container
started keeps its `claude` process (~200 MB each), and the agent's Sail stacks keep running.

| Setting | Where | What |
|---|---|---|
| `SANDBOX_AUTOSTOP_MINUTES` | `.env` | Idle minutes before a sandbox stops. Unset, empty or only spaces: 30. `0` or negative: never. On ssh-docker a value between 0 and 10 is raised to 10, with a warning at boot. Not a number: the bot does not start. |
| `STREAM_HARD_MAX_MINUTES` | `.env` | The turn hard cap (60), and also how long background work, an unanswered injected message, a turn the CLI started on its own or a call that has not returned may keep an otherwise idle ssh-docker container up. |
| `SANDBOX_NAME_PREFIX` | `.env` | Installations that share a Docker host must use distinct prefixes: the idle stop and the wake's session cleanup assume one bot per container. |

**Read at boot.** Change the value in the installation's `.env` in its ops repo, `npm run ops -- <slug> export`,
restart the bot. Setting `0` stops the sweep and housekeeping's wake of an asleep container; a container it
already stopped wakes on its next turn. It does not turn off what every ssh-docker warm-up and reattach now does
regardless (the boot step, the session identity check, the `docker start` retry; `docs/sandbox-drivers.md` →
*Idle stop*, *Off switch*) — a revert does. Every installation gets an idle stop from this key, 30 minutes when
it is unset — decide the value on purpose. The canary log line at boot: `idle stop: sandboxes without
an idle stop of their own (ssh-docker) stop after <m> min without activity`.

## Dispatch (`DISPATCH`) — retired

The dispatch primitive (`propose`, `registry`, proposals with Send / Dismiss) was retired by OpenSpec
`retire-agent-dispatch`; agent messaging (`docs/agent-messaging.md`) is the way to reach beyond a thread. `DISPATCH` and a
project's `dispatch` block are ignored with a warning at boot.
