# Design

## Context

The routine guard (`src/routineguard.ts`, `ROUTINE_GUARD=1`) already decides fire mode (scheduled/late/retry/manual), writes outcomes and builds the "previous run" preamble from `lastDelivered`. The sources poller records per-pass counts in `sources_sync` facts and the store keeps `raw_records` (one row per raw line, rowid monotonic) and `sync_state`. The tenant checkout under `data/<slug>/tenant/` is pulled before every build and holds `annotations/escalations.jsonl` and `ledger/commitments.jsonl`. See proposal.md.

## Goals / Non-Goals

**Goals:**
- Exact fingerprint: counts from the store, not from the pullers' reported numbers.
- Zero model cost on an empty slot; the channel still sees a line, so silence is never ambiguous.

**Non-Goals:**
- Skipping manual fires (`orch routines run`) — a human asked.
- Any content-based judgement of "nothing interesting" — that stays with the agent.

## Decisions

- **Fingerprint = `max(raw_records.rowid)` at last delivery vs now.** Stored on the routine's guard record (`lastDeliveredRowid`). Alternative: `pulled:<kind>` scalars from facts — those are per pass, not per routine, and miss builds triggered by rescrub; rejected.
- **Due = deterministic read of tenant files by the host, no CLI.** The host already parses tenant annotations for the store build (`src/sources/tenant.ts`); reuse those readers for `escalations.jsonl` (status open) and `ledger/commitments.jsonl` (`due <= today`, status open). Alternative: run the tenant CLI in the sandbox — that is a turn, which is what we are avoiding.
- **Skip is an outcome, not a fire mode.** The guard records `skipped-empty` with the timestamp and keeps `lastDelivered` untouched; `missedRoutines` treats a skipped slot as served (no catch-up for it).
- **Message text is fixed, not templated by the agent:** `⏭ nothing new since 08:31 MSK (sources: slack 09:58, gmail 09:57, …)`.

## Risks / Trade-offs

- [A pull failed silently so delta is 0 while the world moved] → the freshness line in the skip message names each source's last pull; a source older than its interval turns the skip into a normal fire (same rule the prompt gives the agent).
- [Tenant file formats change] → readers are shared with the store build and tested there.
- [Rowid is not monotonic after a store rebuild from scratch] → store rebuild resets `lastDeliveredRowid` to 0 (fires once more, never skips wrongly).

## Migration Plan

Flag off by default; home bot sets `ROUTINE_SKIP_EMPTY=1`; ledger row in `docs/rollout.md`; flip in prod only together with `ROUTINE_GUARD`, and only matters for prod projects that gain sources.
