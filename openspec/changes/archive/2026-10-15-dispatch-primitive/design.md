# Design

## Context

Host-side deterministic paths already exist for every piece: control-dir file drops with atomic claim (`src/control.ts`, `run-<id>.json`), queued turns journaled in `queue.jsonl` and replayed at boot, Block Kit buttons handled in `src/events.ts`, feedback and ask-once escalations as ledger records. Routines wrap their fire text as data for the agent. The bot has no inbound HTTP (Socket Mode). See proposal.md.

## Goals / Non-Goals

**Goals:**
- No model step in the host; every decision is a record or a click.
- Visible threads: a dispatched task lives in the target's channel so humans can read, answer and rate it; metering per turn stays as is.

**Non-Goals:**
- Agent-to-agent conversation; a dispatch is one task with one answer.
- A2A or any inter-host protocol while there is one host.
- Email sending (a `message` targets Slack only; mail goes through a future write-API source).

## Decisions

- **Phase A transport = a per-project OUTBOX, not the shared control dir** (changed at implementation): `data/<slug>/outbox` is bind-mounted read-write at `/data/outbox`; the sandbox writes `propose-<id>.json` there (tmp + rename) and the bot polls every outbox with the control-dir claim-by-rename. Mounting the shared control dir would have let any sandbox fire any routine (`run-<id>.json`); the outbox keeps a sandbox's reach to its own proposals. The record carries `AVEN_SESSION` (the conversation key already exported into the claude process for the gateway audit), which is how the host finds the thread to render in. Remote sandboxes (phase B) post the same record to a host endpoint behind the gateway once `sources-serve` gives the host an HTTP listener pattern. Alternative: Slack message with a magic prefix — rejected (mentions must not dispatch; text is untrusted).
- **Sandbox-side tool = `propose` in a tiny host-control MCP** (stdio, same upload path as the sources server) rather than teaching the agent a file format; the tool validates the record and writes the file.
- **Gate rendering = one section + Send/Dismiss actions + a status context line** (`proposalBlocks`), the same shape as the ask-once question blocks; after the click the buttons disappear and the line says who/when/where.
- **Dispatch = `queueTurn` with `origin`**; the child runs as an ordinary turn in its channel thread; the parent pointer is written by the turn's settle hook (`onSettle`), the same hook routines use for outcomes.
- **Budget record** per source project per local day in `state.json` (`dispatches["<slug>|<day>"]`), cap default 5; proposals themselves live in `state.json` `proposals` (status pending/sent/dismissed/failed, approver, message ts, result).

## Risks / Trade-offs

- [Prompt injection via dispatched text] → wrapped as data with origin; the target's base prompt treats it like a routine fire; refs are permalinks, not instructions.
- [Approval fatigue] → auto list per tenant for trusted targets, visible cap.
- [Control dir unavailable for remote sandboxes] → phase B endpoint; until then dispatch is home-bot only (documented).

## Migration Plan

Flag off by default; phase A on the home bot with `bluefin-ops → owen-ops` dispatch (same bot) as the first real use; ledger row; phase B when bluefin-ops moves to prod.

## Open Questions

- Whether the child's answer should also be summarised in the parent thread by the proposing agent (a second turn) or only linked — decide after the first ten dispatches.
