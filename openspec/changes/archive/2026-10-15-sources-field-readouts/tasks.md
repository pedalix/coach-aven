# Tasks

## 1. Store queries

- [x] 1.1 Add `unanswered(params)` in `snapshot/plain/sources-mcp.mjs`: side resolution (account owner default; `side` from tenant people/initiatives), candidate threads by `threads.last_ts`, inbound/answered rule, row shape per spec; verify with a unit test in `src/sources/mcp-server.test.ts` using a fixture store with a replied and an unreplied client thread and a Sent Items message.
- [x] 1.2 Add `stuck(params)` grouped by project/status with `daysSinceUpdate`; verify with a test covering an open stale task, an open fresh task (commented inside the window) and a done task.
- [x] 1.3 Register both tools in the tool list with descriptions that state the limits (age since last update; side = tenant people); verify `tools/list` test enumerates them.

## 2. Prompt and docs

- [x] 2.1 Extend `SOURCES_PROMPT_PARAGRAPH` (`src/sources/mcp.ts`) with one sentence naming `unanswered`/`stuck` as the source of waiting/not-moving lists; verify `npm run typecheck` and that `src/fixtures/prompt/*.txt` golden tests are unchanged (prod projects have no sources paragraph).
- [x] 2.2 Document both tools in `docs/sources.md` (*Readouts*) with the exact semantics and a worked example; add the `docs/rollout.md` ledger row (bucket 2, `sources` config gate).

## 3. Canary

- [x] 3.1 On the home bot, call both tools from a thread turn (`@dev-coach-aven unanswered since yesterday`) and confirm rows match a manual check of two threads; verify the next 18:30 close quotes `unanswered` permalinks. — done 2026-10-15: both briefs quote the rows; the first bluefin-ops brief exposed the side-mode flaw, fixed in 1.4.1 (#164) and re-verified the same day.
