# CoachAven — contributor guide

A Slack coding agent: one Bolt **Socket-Mode** bot drives one warm sandbox per project — a
Docker container on a host the installation runs — each running a persistent **Claude Code**
process. This is the control plane; the heavy work runs in the sandboxes. See `README.md` and
`docs/` for the full picture.

## Commands

- `npm run typecheck` — `tsc --noEmit`. Must pass before every commit.
- `npm test` — Node's built-in runner over `src/**/*.test.ts`. Must pass before every commit.
- `npm run orch -- slack` — run the bot locally (needs a dev Slack app + `.env`; see `README.md`).
- `npm run orch -- routines list [slug]` / `npm run orch -- routines run <id>` — the scheduled routines in
  `state.json`, or ask the running bot to fire one now (a request in the control channel it watches:
  `src/routinescli.ts`, `src/control.ts`).
- `npm run ops -- <slug> <command>` — deploy/export/import/logs for ONE installation: the ops repo
  checked out at `infra/<slug>/` (`infra/README.md`). No default slug, on purpose.
- Release — merge PRs to `main`, then `git tag vX.Y.Z && git push origin vX.Y.Z`. The tag
  triggers CI (typecheck + test → GitHub Release → deploy). No changelog or version edits.
  **`main` is the canary**: the home bot runs it; prod runs the last tag. Tag only after ~2 days
  on the canary, and start every work session by checking `docs/rollout.md` (the flag ledger)
  and `git log $(git describe --tags --abbrev=0)..main` for what is due to ship, flip or retire.

## Conventions

- **Prod must not change as a side effect of a merge.** Shared-code behaviour changes are
  bug fixes (ungated), default-preserving (test proves today's prod shape), or behind a flag
  that is off by default and canaried first — and the PR says which. Flags are rollout
  stages, not permanent switches: add the ledger row in the same PR. See `docs/rollout.md`.
- **Changing Slack UI/UX → update the App Home tab.** The Home tab (`homeBlocks` in
  `src/chat/slack/blocks.ts`) is the user-facing cheat-sheet. Any new command, button, or changed
  interaction MUST be reflected there in the same change, or it silently goes stale.
- **Release notes are auto-generated from merged PR titles** (GitHub Releases — `CHANGELOG.md`
  is just a pointer there). So write clear, human-readable PR titles, and label PRs
  (`feature`/`fix`/`ci`/`docs`) so they group per `.github/release.yml`. The git tag is the
  version of record; `package.json`'s `version` is not maintained.
- **Pure logic lives in its own module with tests.** Anything testable without Slack or a sandbox
  (parsing, matching, formatting) goes in a standalone file (e.g. `src/schedule.ts`) with a
  `*.test.ts` beside it — don't bury it inside a chat driver (`src/chat/slack/`).
- **Fictional names only.** Tests, fixtures, docs, comments, OpenSpec and commit/PR text use invented people,
  companies and `.example` domains — never a real customer, installation, person, host or id. Real ones live in
  the installation's ops repo (`infra/<slug>/`). CI's `scripts/public-guard.sh` checks against a private deny-list.
- Match the surrounding style: dense, explanatory comments on the *why*; concise code.
- **Plan before code — OpenSpec.** Shared-code work starts as a change in `openspec/changes/<name>/`
  (`/opsx:propose`: proposal → spec delta → design → tasks), is implemented with `/opsx:apply` in a
  worktree, ships as a PR that names its rollout bucket and ledger row, and is archived into
  `openspec/specs/` with `/opsx:archive` after the merge. `openspec list` shows what is in flight;
  a tenant's own repository records its plans and decisions, this repo records behaviour.

## Architecture pointers

- `src/chat/` — the **chat driver** layer (OpenSpec `chat-driver-interface`). One installation
  runs ONE chat driver, chosen by the run command (`orch slack` / `orch teams`; `src/chat/drivers.ts`). The
  platform-neutral core (`src/chat/core/`: `messages.ts` mentions/DMs/thread replies,
  `commands.ts` the `/aven` router, `interactions.ts` buttons/dialogs/home, `gates.ts` who may
  drive) and the engine-side code (`src/turn.ts`, `src/pollers.ts`) talk
  to `ChatDriver` (`src/chat/driver.ts`) with view models (`src/chat/views.ts`) — never to a
  platform SDK (`src/chat/imports.test.ts` enforces it).
- `src/chat/teams/` — the Teams driver (`orch teams`; OpenSpec `teams-chat-driver`): `app.ts`
  composition root over the Teams SDK (`@microsoft/teams.apps`, the ONLY directory allowed to
  import it), `driver.ts` (the `TeamsApi` seam + edit coalescing + private-reply routing),
  `events.ts` (activity normalizers, pure, tested over `src/fixtures/chat/teams/activities/`),
  `cards.ts` (Adaptive Cards, golden-tested), `format.ts`, `keys.ts`. See `docs/teams.md`.
- `src/chat/slack/` — the Slack driver: `app.ts` is the **composition root** (builds the turn
  engine + channel resolver, registers the Slack surfaces, starts the pollers), `driver.ts`
  (rendering + Web API), `events.ts` / `commands.ts` (Bolt wiring, payload normalization),
  `blocks.ts` (all Block Kit), `installations.ts` (OAuth store), `twin.ts` (the test harness).
  Slack output is pinned by recorded call snapshots (`src/fixtures/chat/`, re-snapshot on
  purpose with `UPDATE_SNAPSHOTS=1`).
- `src/turn.ts` (turn lifecycle: `liveTurn`/`doTurn`, queues, agent questions, restart
  recovery), `src/pollers.ts` (scheduler + auto-review/autofix/YouTrack pollers),
  `src/channels.ts` (channel↔project).
- `src/cli.ts` — the commander CLI (`slack`, `teams`, `sources …`, `routines …`). `src/project.ts` — clone,
  worktrees, auth/MCP seeding into the sandbox, `provisionTooling()`. `src/claudeSession.ts` — the persistent
  `claude` process (stream-json). `src/github.ts` — GitHub App tokens (minted before every turn) + PR/CI reads.
  `src/scrub.ts` — secrets redaction at the model boundary and at ingest.
- `src/tasks.ts` — chat session over a sandbox. `src/prompt.ts` — the **3-layer system prompt**
  (orchestrator base → project prompt → repo `CLAUDE.md`), pure and golden-tested: the base text
  reaches every production session, so `src/fixtures/prompt/*.txt` pins it byte-exact — change it
  on purpose and re-snapshot. Per project it varies only by `gitFlow` (`pr`/`direct`) and
  `sandbox.dind` (the Sail/DinD toolchain paragraph).
- `src/driver.ts` — the provider-agnostic **sandbox driver** interface (warm sandboxes,
  exec, persistent process sessions) and the seam for another provider: one file per driver,
  its SDK (if any) imported there alone. One implementation: `src/sshdocker.ts` (containers
  on a Docker host the installation runs, over SSH or locally). `SANDBOX_DRIVER` and a
  project's `driver` field are optional and select only `ssh-docker`: any other value, `daytona`
  included, is a configuration error (`SANDBOX_DRIVER` at boot, a project's `driver` at boot and
  at `/aven reload`) — see `docs/sandbox-drivers.md`. `src/idlestop.ts` — the
  **idle stop** for a provider without one (ssh-docker): the activity record the driver
  writes, the rule (holds, wakeups, lingering work), the once-a-minute sweep started with
  the pollers (OpenSpec `sandbox-idle-stop`).
- `src/projects.ts` / `infra/<slug>/projects.config.json` (an installation's ops repo) — per-project repos, MCP,
  prompt. System prompts live as markdown beside the config (`projects.d/<slug>.md`, wins
  over the JSON field). Read at boot; `/aven reload` re-reads at runtime (new sessions
  only — running conversations keep their session's prompt/MCP).
- `src/state.ts` — single-file `state.json`: projects, chat→session bindings, routines.
  Beside it: `src/queuejournal.ts` (`queue.jsonl` — queued-turn journal, replayed at boot),
  `src/drafts.ts` (`drafts/<slug>/` — report drafts on disk, per project), and
  `src/metering.ts` (`usage/<month>.jsonl` — per-turn token/cost attribution, `/aven usage`).
- `src/schedule.ts` — pure cron/schedule logic for scheduled report jobs; `src/routineguard.ts` —
  the routine delivery guard (missed-fire catch-up, outcome + one retry, "previous run" preamble),
  behind `ROUTINE_GUARD=1` — see `docs/runtime-config.md`.
- `src/messaging/` — agent messaging (OpenSpec `agent-messaging`, `docs/agent-messaging.md`): `service.ts` (the tools,
  the deliverer, the answering side), `protocol.ts`/`a2a.ts` (wire format, shared with the hub; no `node:` imports),
  `seal.ts` (E2E), `local.ts`/`hubclient.ts` (transports), `marks.ts`, `wrap.ts`, `runtime.ts` (the composition roots'
  half); shadow conversations journal through `src/chat/shadow/driver.ts`. `hub/` is the relay — a Cloudflare Worker with
  its own package and tests (`docs/hub.md`).
- `src/gwtoken.ts` — OAuth client-credentials tokens for the MCP gateway (`mcp` entry with `auth: "gateway-m2m"`):
  Auth0 by default, any RFC 6749 server via the entry's `oauth` object; cached/single-flight mint in the orchestrator,
  only the token goes into the sandbox — see `docs/runtime-config.md` → *MCP gateway*.
- `src/sources/` — per-project ingestion (mail, chat, calendars, trackers, recorded calls, local activity)
  into a scrubbed store the agent queries over MCP (`docs/sources.md`); `src/sources/attribution/` is the
  attribution layer — the ladder, the item floor, the shadow learning loop — architecture, status and
  roadmap in `docs/attribution.md`, the bench in `src/lab/` (`docs/lab.md`).
- `src/cliprobe/` — the **CLI probe** (`npm run cli-probe`, `docs/cli-probe.md`): what the bot relies on
  in the headless Claude Code CLI, as scenarios with verdicts per CLI version; recordings and reports in
  `src/fixtures/cli/<version>/`, replayed through `ClaudeSession` in `npm test`; the repo pins only
  versions in `PROBED_CLI_VERSIONS` (`src/cliversion.ts`).
- `src/facts.ts` / `src/deps.ts` — project **facts** (`facts/<slug>.json`): derived, machine-written
  state with provenance. Today one writer (the composer dependency scanner) and readers (GitHub
  token scope, composer `auth.json`, system prompt) — see `docs/project-facts.md`.
