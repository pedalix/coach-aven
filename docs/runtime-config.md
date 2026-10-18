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
| `sources` | partly (reload re-reads intervals/accounts for the next pull) | which mail/chat/calendar/file systems, task trackers (YouTrack, Jira, Asana) and meeting recorders (Granola, Gemini in Meet, Wispr) the BOT pulls for this project into `data/<slug>/raw` (`docs/sources.md`); credentials are bootstrapped separately with `orch sources auth` and live under `~/.config/coach-aven/sources/<slug>/`, so adding a source needs that one-time step on the host as well; `sources.tenant` names the project's repo of decisions (people with markers, fragments → initiatives) that the bot fetches and indexes before each build; the store replica mount (`/data/sources`) is added to the project's sandbox options automatically, and that applies at container creation (recreate `proj-<slug>` after turning sources on) |

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

## MCP gateway (per project)

A project can reach all its MCP sources through the gateway (bluefin-infra `engine/`, agentgateway at
`https://<gateway-host>/gw/<slug>/mcp`) instead of listing each upstream:

```json
"mcp": [{ "name": "gw", "url": "https://<gateway-host>/gw/<slug>/mcp", "auth": "gateway-m2m" }]
```

- The bot is the Auth0 M2M client `coach-aven-<slug>`. The orchestrator mints and caches its token
  (`src/gwtoken.ts`, ≤ 1 mint per project per day — Auth0 Free allows 1000/month) from
  `AUTH0_M2M_TOKEN_URL` + `AUTH0_M2M_<SLUG>_ID/_SECRET` in the prod `.env`, and writes only the token
  into the sandbox (`/root/.aven/gw-token-gw`, 600) every turn. Claude Code reads it through the
  server's `headersHelper` (`/root/.aven/gw-headers.sh`), which also sends `x-aven-session`
  (the chat key) — the gateway logs it as `aven_session`, joining its audit to our event log.
- What the bot may do is decided by the gateway's route policy, not here. Tool names become
  `<source>_<tool>` (e.g. `youtrack_search_issues`); the project prompt should map them.
- Name the entry `gw` — `steps.ts` renders `mcp__gw__<target>_<tool>` by target.

**Rollback** (one edit): in `projects.config.json` move the project's `mcpDirectBackup` list back
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
`scripts/mirror.ts` keeps a **one-way, read-only mirror** of each in BluefinOrg, and the
project lists the mirror. Upstream stays the source of truth — the project prompt tells the
agent not to push or open PRs there.

- **Where it runs:** the deployer's crontab on the prod box, every 30 min —
  `*/30 * * * * cd /var/www/coach-aven && <node> --import tsx scripts/mirror.ts >> mirrors/mirror.log 2>&1`.
  Not GitHub Actions: the write side needs the App key, which must not leave the box.
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
  (`note` is a comment; example: `infra/deploy/ops.example/mirrors.example.json`). The script reads
  `MIRRORS_CONFIG` (a path) when set, else `./mirrors.json` in its working directory. A missing or
  malformed list fails the run (exit 1, Sentry tag `mirror: config`) — it never mirrors nothing quietly.
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
Daytona, ssh-docker and local docker (OpenSpec `host-tools`; pure part `src/hosttools.ts`, routes
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

## Repo skills (`REPO_SKILLS`)

A multi-repo project's sessions start in the project folder, where no repo's `.claude/skills` is visible. With
`REPO_SKILLS=1`, every such session starts with `--add-dir <checkout>` for each repo, so it loads each repo's own Claude
Code skills as a Claude Code started in that repo would (OpenSpec `agent-skills`); `--add-dir` also loads each repo's
legacy `.claude/commands/`. Off by default: unset or anything else, every spawn line stays as it was. Single-repo
projects are unaffected either way: their session starts in the repo. Both sandbox drivers run the same command line
(the Daytona driver passes it unchanged).

| Setting | Where | What |
|---|---|---|
| `REPO_SKILLS` | `.env` | `1` turns repo skills on for the installation's multi-repo projects (their agent cards can then offer the repos' skills too). Unset or anything else: off. |

**Off everywhere; switch it on per installation when a skill worth it exists.** What turning it on brings: whatever
skills and commands the repos carry — typically OpenSpec workflow skills (`openspec-*`) and `/opsx` commands, plus a
few framework development helpers (a Laravel media-library or HTTP-client helper, a Tailwind helper). A skill or command
defined in two of a project's repos loads twice, and `/name` runs the first `--add-dir`'s. Watch for skills the agent
starts using on its own. The canary installations are single-repo, so the multi-repo path rests on the live measurement
(design `agent-skills`) and the tests until an installation with a multi-repo project switches it on.

**Turning it on.**
1. Set `REPO_SKILLS=1` in the installation's `.env` in its ops repo — not on the box, which the next export would
   overwrite.
2. `npm run ops -- <slug> export`, then restart the bot.
3. Sessions already running, and sessions the restart reattaches, keep their old command line until they end, or until
   `🔄 Restart session` in their thread. Turning it off is the same with the line removed.

## Dispatch (`DISPATCH`) — retired

The dispatch primitive (`propose`, `registry`, proposals with Send / Dismiss) was retired by OpenSpec
`retire-agent-dispatch`; agent messaging (`docs/agent-messaging.md`) is the way to reach beyond a thread. `DISPATCH` and a
project's `dispatch` block are ignored with a warning at boot.
