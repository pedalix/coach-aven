# CoachAven — contributor guide

A Slack coding agent: one Bolt **Socket-Mode** bot drives one warm **Daytona** sandbox per
project, each running a persistent **Claude Code** process. This is the control plane; the
heavy work runs in the sandboxes. See `README.md` and `docs/` for the full picture.

## Commands

- `npm run typecheck` — `tsc --noEmit`. Must pass before every commit.
- `npm test` — Node's built-in runner over `src/**/*.test.ts`. Must pass before every commit.
- `npm run orch -- slack` — run the bot locally (needs a dev Slack app + `.env`; see `README.md`).
- Prod deploy / releases — tag `vX.Y.Z` (see `infra/prod/README.md`); CI runs typecheck + test → deploy.

## Conventions

- **Changing Slack UI/UX → update the App Home tab.** The Home tab (`homeBlocks` in
  `src/slack.ts`) is the user-facing cheat-sheet. Any new command, button, or changed
  interaction MUST be reflected there in the same change, or it silently goes stale.
- **Every user-facing change gets a `CHANGELOG.md` `[Unreleased]` entry** (Keep a Changelog).
- **Pure logic lives in its own module with tests.** Anything testable without Slack/Daytona
  (parsing, matching, formatting) goes in a standalone file (e.g. `src/schedule.ts`) with a
  `*.test.ts` beside it — don't bury it inside `src/slack.ts`.
- Match the surrounding style: dense, explanatory comments on the *why*; concise code.

## Architecture pointers

- `src/slack.ts` — Bolt bot: events, `/aven` command + subcommands, turn lifecycle
  (`liveTurn`/`doTurn`), block rendering, the report-job scheduler.
- `src/tasks.ts` — chat session over a sandbox; the **3-layer system prompt**
  (orchestrator base → project prompt → repo `CLAUDE.md`).
- `src/projects.ts` / `infra/prod/runtime/projects.config.json` — per-project repos, MCP,
  prompt. Read **once at boot** — prod changes need a restart.
- `src/state.ts` — single-file `state.json`: projects, chat→session bindings, routines.
- `src/schedule.ts` — pure cron/schedule logic for scheduled report jobs.
