# Tasks

## 1. Records and transport (phase A)

- [x] 1.1 `ProposalRecord` + `parseProposal` in `src/dispatch.ts`; `consumeProposals` (per-project outbox `propose-<id>.json`, claim by rename — the shared control dir was rejected, see design) ; verified by `dispatch.test.ts` (valid, invalid, junk, duplicate id ignored by the dispatcher).
- [x] 1.2 Sandbox-side `propose` tool: `snapshot/plain/host-mcp.mjs` (`host` server, stdio, uploaded by sha via `ensureHostMcp`), writes into the outbox mount; verified by the round-trip test (tool → file → host parser) and the stdio handler test; the manual call is the canary (3.2).

## 2. Gate and execution

- [x] 2.1 `proposalBlocks` (dispatch.ts) rendered in the proposing thread; `dispatch_send` / `dispatch_dismiss` in `src/events.ts` call the dispatcher, which is idempotent on the proposal status (a second click returns the record unchanged); rendering tested, the double click is pinned by `approve()`'s status check (events.ts has no test harness).
- [x] 2.2 `src/dispatchrun.ts`: `message` (postMessage + footer + permalink), `dispatch` (parent in the target channel, `liveTurn` in its thread with `origin`, `wrapDispatch` task-as-data, onAnswer/onSettle write the pointer back); the journal `origin` round-trip and the wrapper are tested; the live path is the canary.
- [x] 2.3 `gateDecision` + `Store.dispatchCount/bumpDispatch` + `ProjectConfig.dispatch {auto, maxPerDay}` with boot validation; tested (cap reached → gate; listed target → auto).

## 3. Surface, docs, rollout

- [x] 3.1 Home tab *Proposals* bullet (while the flag is on); `docs/runtime-config.md` → *Dispatch*; `docs/rollout.md` row (bucket 3).
- [x] 3.2 Home bot canary: bluefin-ops proposes a dispatch to owen-ops; verify the thread in `dev-bluefin-aven-owen-ops`, the pointer back in `dev-bluefin-aven`, and one usage record per child turn. — done 2026-10-15: bluefin-ops proposal p-20261015113644 sent by Owen, child thread in the owen-ops channel, pointer back in the brief thread, one usage record. The outbox transport is superseded by `host-tools` (same record as a host tool call).

## Workflow follow-up
- Phase B (host endpoint behind the gateway for remote sandboxes) is a separate change after `sources-serve-remote-mcp` lands.
