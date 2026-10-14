# Tasks

## 1. Records and transport (phase A)

- [ ] 1.1 Define `ProposalRecord` and its validation in `src/dispatch.ts`; add `propose-<slug>-<id>.json` handling to `src/control.ts` with atomic claim; verify with unit tests (valid, invalid, duplicate id).
- [ ] 1.2 Sandbox-side `propose` tool (host-control MCP, stdio, uploaded by sha like the sources server) that writes the record into the control mount; verify with an MCP test and a manual call from a home-bot thread.

## 2. Gate and execution

- [ ] 2.1 Render proposals with Send/Dismiss in the proposing thread (`src/blocks.ts` reuse of escalation blocks) and handle the buttons in `src/events.ts` idempotently; verify by a rendering test and an events test (double click → one execution).
- [ ] 2.2 Execute `message` (chat.postMessage with footer) and `dispatch` (queueTurn with `origin`, wrapped task text, new thread in the target channel, settle hook writes the pointer back); verify with turn tests using the fake Slack client and a replayed `queue.jsonl` line carrying `origin`.
- [ ] 2.3 Budget per source agent per day and tenant `dispatch.auto` list; verify with tests (cap reached → gate; auto target → executes).

## 3. Surface, docs, rollout

- [ ] 3.1 Home tab cheat-sheet row for proposals; `docs/runtime-config.md` (`DISPATCH`, `dispatch.auto`, `dispatch.maxPerDay`); `docs/rollout.md` ledger row (bucket 3); verify typecheck and tests.
- [ ] 3.2 Home bot canary: bluefin-ops proposes a dispatch to owen-ops; verify the thread in `dev-bluefin-aven-owen-ops`, the pointer back in `dev-bluefin-aven`, and one usage record per child turn.

## Workflow follow-up
- Phase B (host endpoint behind the gateway for remote sandboxes) is a separate change after `sources-serve-remote-mcp` lands.
