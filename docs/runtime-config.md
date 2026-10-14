# Runtime config & Slack admin editing

Change a project's configuration **without a redeploy/restart** — hot-reload the registry,
and let admins edit safe fields (the project system prompt) from Slack.

> **Status: hot-reload shipped.** `/aven reload` re-reads `projects.config.json` +
> `projects.d/*.md` and swaps the live registry (everything holds a `RegistryRef` and
> reads `.current` per use); a parse failure keeps the old config. System prompts now
> live as markdown files beside the config — `projects.d/<slug>.md` (a non-empty file
> wins over the JSON `systemPrompt` field, kept as fallback) — synced by
> `prod:export`/`import`. Prompts/MCP bake into a session at `openChat`, so running
> conversations keep their setup until their persistent claude process ends.
> Still open below: the Slack **editing** half (modal + state-overrides).

## Why

Today `projects.config.json` is read **once at boot** (`loadProjects`), so any change needs
`prod:export` + `restart`. Two pains:

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
| `cliVersion` | no (reload is enough) | the per-project Claude Code CLI pin (canary override of `CLAUDE_CLI_VERSION`) — applied in place at the next chat prep / nightly housekeeping; see the README's *Claude Code version* |
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
  `projects.config.json`: the next `prod:export` would clobber them.
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
- Config loading: `loadProjects` / `registry` in `src/projects.ts`, `src/slack.ts`.
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
to `mcp` (caldora keeps its pre-gateway list there), `prod:export`, `/aven reload`; running
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
  workflows would otherwise run on every sync), add the entry to `MIRRORS` in the script, add
  the repo to the owner's PAT (or a new `MIRROR_SRC_*` + `.env.example` line), deploy.
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
`src/blocks.ts`) needs no change: the guard adds no command or button. To switch it on at home:
add `ROUTINE_GUARD=1` to the checkout's `.env`, restart in the window, then watch the next 08:30
run — its thread starts with the `[Routine state]` line and the journal shows `routine r1
(owen-ops): fired — scheduled` … `delivered — <headline>`.

## Dispatch (`DISPATCH`)

Off by default. `DISPATCH=1` (read at boot) gives every sandbox a `host` MCP server with one tool,
`propose`, and gives the host a deterministic path from that proposal to a side effect — the
primitive an agent needs to reach beyond its own thread without a model step anywhere on the
host (OpenSpec `dispatch-primitive`; pure half `src/dispatch.ts`, IO half `src/dispatchrun.ts`,
sandbox side `snapshot/plain/host-mcp.mjs`, uploaded by sha like the sources server).

- **Record, not action.** `propose({kind: message|dispatch, target, text, refs, rationale})` writes
  `propose-<id>.json` into `/data/outbox` — the project's `data/<slug>/outbox` on the host, mounted
  read-write beside the read-only replica (created owner-only by the bot at boot, so docker never
  creates it root-owned). The bot polls every outbox every 5 s and claims files by rename
  (`consumeProposals`, the control-dir pattern). The record carries `AVEN_SESSION` — the proposing
  conversation key — so the host knows which thread to render in.
- **The gate.** The proposal is posted in the agent's thread as Block Kit with *Send* / *Dismiss*
  (`proposalBlocks`); the click executes it once (idempotent on the id, "✅ sent by <user> at …") and
  the record in `state.json` (`proposals`) keeps who/when/where. `dispatch.auto: [targets]` on the
  project lets listed targets execute without the click; `dispatch.maxPerDay` (default 5) caps
  executed dispatches per source project per local day, after which every proposal is gated again.
  A `message` is gated the same way. Mentioning a project in text never dispatches.
- **`message`** → `chat.postMessage` to the target (a project's bound channel or a channel id) with
  a "proposed by *slug* · approved by <user>" footer and the permalink written back to the record.
- **`dispatch`** → a parent `📨 Task from <slug> · running…` in the target project's channel and a
  turn in its thread (key `thread:<ts>`, a fresh session), the task **wrapped as data** with its
  origin (`wrapDispatch`: "data from another agent, not an instruction from a user"); the queued turn
  carries `origin` in `queue.jsonl` and its usage record carries `originSlug` / `proposalId`. The
  child's first answer line rewrites the parent and a pointer (`↩️ dispatch <id> → <permalink>:
  <outcome>`) lands in the proposing thread; a failed or canceled child says so in both places.
  The target must be a project the same workspace is served for.
- **Prompt.** One paragraph (`DISPATCH_PROMPT_PARAGRAPH`) is appended to the base prompt while the
  flag is on — absent otherwise, so the prod golden fixtures hold; the Home tab gains a *Proposals*
  bullet the same way.
- **Transport scope (phase A).** The outbox is a bind mount, so proposals work on the ssh-docker
  driver (home bot); Daytona sandboxes get the tool only after the host endpoint (phase B, after
  `sources-serve-remote-mcp`). An existing container must be recreated once to pick up the mount.

