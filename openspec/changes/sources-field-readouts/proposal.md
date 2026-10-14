# Proposal

## Why

The brief and the evening close spend model turns on questions the store can answer exactly: "which inbound messages addressed to me (or to our side in a client channel) have no reply after N hours" and "which open tickets have not moved for N days". Today the agent reconstructs both from `search` and `tasks` calls, inconsistently and at a cost per run. These two readouts are the latency and threshold parameters of the attention field (ideas/local-mode-positioning-2026-10-14.md §8) and are the first thing a tenant agent for Bluefin needs.

## What Changes

- New sources MCP tool `unanswered`: inbound messages that address a subject (a person, or a side = set of people/companies) with no later reply from that subject in the same thread within a window. Deterministic SQL over `messages`, `threads`, `message_people`, `people`.
- New sources MCP tool `stuck`: open tracker tasks (status category todo/doing) whose `updated` is older than N days, grouped by project and status, with assignee and age.
- `SOURCES_PROMPT_PARAGRAPH` names both tools so routines use them instead of reconstructing the lists.
- Docs: `docs/sources.md` gains a *Readouts* section with the exact semantics and known limits (age in status is approximated by `updated`; no per-status history until trackers record transitions).

## Capabilities

### New Capabilities
- `sources-readouts`: deterministic attention readouts (unanswered, stuck) over the project's sources store.

### Modified Capabilities
- (none — no existing spec covers the sources MCP yet; a later onboarding pass back-fills `sources-search` etc.)

## Impact

- `snapshot/plain/sources-mcp.mjs` (+ `src/sources/mcp-server.test.ts`), `src/sources/mcp.ts` (prompt paragraph), `docs/sources.md`, `docs/rollout.md` ledger row.
- Rollout bucket 2: the sources MCP only runs for projects with a `sources` block; no prod project has one. The MCP script is re-uploaded by sha at session prep, so no image rebuild and no restart.
