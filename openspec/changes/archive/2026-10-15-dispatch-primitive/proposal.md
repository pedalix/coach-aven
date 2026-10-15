# Proposal

## Why

An agent can only act inside its own sandbox and thread. A tenant agent (bluefin-ops) needs to open an investigation in a project channel, and a personal agent needs to send a chase to a commitment's owner — today both end as text a human copies. The missing primitive is a deterministic host path from an agent's proposal to a side effect, with provenance, a human gate by default and no model in the host (Owen's constraint: the bot runs only deterministic code).

## What Changes

- `propose`: a sandbox writes a proposal record (`kind: message | dispatch`, target, text, refs, rationale) to the host; the host renders it in the agent's own thread as Block Kit with **Send / Dismiss**; the click executes it. Same mechanics as 👍/👎 and ask-once.
- `dispatch` execution: the host enqueues a turn for the target project (`queue.jsonl` with `origin: {slug, turnId, proposalId}`), the task text wrapped as data the way routine fires are, in a new thread in the target's channel; the child's final answer is posted there and a pointer (permalink + one-line summary of outcome) is written back to the parent thread.
- `message` execution: `chat.postMessage` to the target channel/thread on behalf of the bot, with "proposed by <agent>, approved by <user>" in the footer.
- Auto mode per tenant: `dispatch.auto: [targets]` lets a tenant skip the gate for listed targets; daily cap per source agent (`dispatch.maxPerDay`, default 5); mention of a project does not dispatch — only `propose` does.
- Transport phase A: control-dir file drop (`data/control/propose-<slug>-<id>.json`, atomic claim like `run-<id>.json`) for the local driver; phase B: host HTTP endpoint behind the gateway for remote sandboxes (depends on `sources-serve-remote-mcp` giving the host an HTTP listener pattern).
- Flag `DISPATCH=1` (bucket 3), Home tab cheat-sheet row, `docs/runtime-config.md`, `docs/rollout.md` row.

## Capabilities

### New Capabilities
- `agent-dispatch`: how an agent's proposal becomes a host-executed side effect (message or task for another agent) with approval, provenance and budget.

### Modified Capabilities
- (none)

## Impact

- New `src/dispatch.ts` (records, rendering, execution), `src/control.ts` (proposal files), `src/events.ts` (buttons), `src/queuejournal.ts` (origin field), `src/blocks.ts` (Home tab), sandbox-side `propose` tool in the sources MCP or a small host-control MCP, docs.
- Prod unaffected until `DISPATCH=1`; the queue journal field is optional (replay ignores it).
