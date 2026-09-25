# CoachAven — contributor guide

A Slack coding agent: one Bolt **Socket-Mode** bot drives one warm **Daytona** sandbox per
project, each running a persistent **Claude Code** process. This is the control plane; the
heavy work runs in the sandboxes. See `README.md` and `docs/` for the full picture.

## Commands

- `npm run typecheck` — `tsc --noEmit`. Must pass before every commit.
- `npm test` — Node's built-in runner over `src/**/*.test.ts`. Must pass before every commit.
- `npm run orch -- slack` — run the bot locally (needs a dev Slack app + `.env`; see `README.md`).
- Release — merge PRs to `main`, then `git tag vX.Y.Z && git push origin vX.Y.Z`. The tag
  triggers CI (typecheck + test → GitHub Release → deploy). No changelog or version edits.

## Conventions

- **Changing Slack UI/UX → update the App Home tab.** The Home tab (`homeBlocks` in
  `src/blocks.ts`) is the user-facing cheat-sheet. Any new command, button, or changed
  interaction MUST be reflected there in the same change, or it silently goes stale.
- **Release notes are auto-generated from merged PR titles** (GitHub Releases — `CHANGELOG.md`
  is just a pointer there). So write clear, human-readable PR titles, and label PRs
  (`feature`/`fix`/`ci`/`docs`) so they group per `.github/release.yml`. The git tag is the
  version of record; `package.json`'s `version` is not maintained.
- **Pure logic lives in its own module with tests.** Anything testable without Slack/Daytona
  (parsing, matching, formatting) goes in a standalone file (e.g. `src/schedule.ts`) with a
  `*.test.ts` beside it — don't bury it inside `src/slack.ts`.
- Match the surrounding style: dense, explanatory comments on the *why*; concise code.

## Architecture pointers

- `src/slack.ts` — the composition root: builds the turn engine + channel resolver,
  registers the Slack surfaces, starts the pollers. The parts live beside it:
  `src/turn.ts` (turn lifecycle: `liveTurn`/`doTurn`, queues, agent questions, restart
  recovery), `src/events.ts` (mentions/DMs/buttons/App Home), `src/commands.ts` (the
  `/aven` router), `src/pollers.ts` (scheduler + auto-review/autofix/YouTrack pollers),
  `src/blocks.ts` (all Block Kit rendering), `src/channels.ts` (channel↔project).
- `src/tasks.ts` — chat session over a sandbox; the **3-layer system prompt**
  (orchestrator base → project prompt → repo `CLAUDE.md`).
- `src/driver.ts` — the provider-agnostic **sandbox driver** interface (warm sandboxes,
  exec, persistent process sessions). Implementations: `src/daytona.ts` (the ONLY file
  allowed to import `@daytonaio/sdk`) and `src/sshdocker.ts` (containers on our own host
  over SSH). Selected by `SANDBOX_DRIVER` env, overridable per project via the `driver`
  field in projects.config.json — see `docs/sandbox-drivers.md`.
- `src/projects.ts` / `infra/prod/runtime/projects.config.json` — per-project repos, MCP,
  prompt. System prompts live as markdown beside the config (`projects.d/<slug>.md`, wins
  over the JSON field). Read at boot; `/aven reload` re-reads at runtime (new sessions
  only — running conversations keep their session's prompt/MCP).
- `src/state.ts` — single-file `state.json`: projects, chat→session bindings, routines.
  Beside it: `src/queuejournal.ts` (`queue.jsonl` — queued-turn journal, replayed at boot),
  `src/drafts.ts` (`drafts/<slug>/` — report drafts on disk, per project), and
  `src/metering.ts` (`usage/<month>.jsonl` — per-turn token/cost attribution, `/aven usage`).
- `src/schedule.ts` — pure cron/schedule logic for scheduled report jobs.
- `src/gwtoken.ts` — Auth0 M2M tokens for the MCP gateway (`mcp` entry with `auth: "gateway-m2m"`):
  cached/single-flight mint in the orchestrator, only the token goes into the sandbox — see
  `docs/runtime-config.md` → *MCP gateway*.
- `src/facts.ts` / `src/deps.ts` — project **facts** (`facts/<slug>.json`): derived, machine-written
  state with provenance. Today one writer (the composer dependency scanner) and readers (GitHub
  token scope, composer `auth.json`, system prompt) — see `docs/project-facts.md`.
