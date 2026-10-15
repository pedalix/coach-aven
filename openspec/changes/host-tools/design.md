# Design

## Context

`src/claudeSession.ts` drives `claude --output-format stream-json --input-format stream-json --permission-prompt-tool stdio` over the driver's process session and already handles `control_request{can_use_tool}` (AskUserQuestion → Slack buttons) and sends `control_request{interrupt}`. `src/mcp.ts` writes the sandbox's `--mcp-config`; `src/sources/mcp.ts` injects the stdio `sources` server and `src/hostmcp.ts` the stdio `host` server, each backed by a mount from `src/sandboxopts.ts` / `src/dispatch.ts`. `src/sources/serve.ts` imports `handleMessage` from `snapshot/plain/sources-mcp.mjs` and answers JSON-RPC on the host. The SDK protocol (`@anthropic-ai/claude-agent-sdk` typings, CLI 2.1.282 in the sandboxes): `control_request{initialize, sdkMcpServers: [...], sdkMcpServerConfigs}` from the host; `control_request{mcp_message, server_name, message}` from the CLI for the MCP handshake (`initialize`, `notifications/initialized`, `tools/list`) and every `tools/call`; the host replies `control_response{subtype: success, request_id, response: {mcp_response}}`.

## Goals / Non-Goals

**Goals:**
- One channel for everything the agent asks of our side; the driver stays a pipe and loses its mount features.
- The caller is known by the channel: no identity field in any tool input is trusted.
- Same records, same gate, same rendering for dispatch; same tool table and scrub markers for sources.

**Non-Goals:**
- Host-initiated calls into the agent (turns stay the only way in); streaming results; a daemon elsewhere (`sources-daemon`).

## Decisions

- **Protocol layer, not the driver.** `mcp_message` is handled beside `can_use_tool` in `claudeSession.ts`; the driver interface does not change. Alternative: a driver capability ("host tools") per implementation — rejected, the channel is the same bytes on Daytona, ssh-docker and local.
- **Registration at process start.** Right after the process starts, before the first user message, the session writes `initialize` with `sdkMcpServers` (`host` when `HOST_TOOLS=1`; `sources` when the project has a `sources` block and no `sources` url entry) and `sdkMcpServerConfigs` timeouts (`host` 30 s, `sources` 90 s for transcript pages). The CLI runs the MCP handshake over `mcp_message`; `sdkMcpServerManifests` (handshake pre-answered) is an optimisation for later.
- **Pure tool tables.** `src/hosttools.ts` exports `handleHostMessage(caller, message, deps)` — JSON-RPC in, JSON-RPC out — with `caller = {slug, conversationKey, routineId?}` supplied by the session, and `deps` as narrow functions (list projects, propose, routine record). Tests drive it with fake deps. `sources` reuses `handleMessage` from the `.mjs` with the replica path of the caller's slug; the DB is opened per call as `serve` does, so a swapped replica is picked up at once.
- **`propose` reply** = `{id, status: pending|auto, gate: buttons|auto}`; ids stay sandbox-independent (content hash of record + conversation), so a retried call is a no-op. The thread rendering, Send/Dismiss, provenance and the daily cap are unchanged (`agent-dispatch`).
- **`registry`** returns the bot's projects as `{slug, channel, agent: display name, dispatchable}` — no repos, no tokens, no prompts. **`routine`** returns `{id, label, kind, previous: {at, outcome, summary}}` for a routine turn and `null` otherwise, from the routine guard's records.
- **Reattach.** The snapshot scan that today recognises a pending `can_use_tool` also recognises a pending `mcp_message`; the reattached session answers it with a JSON-RPC error (`host restarted — call again`) so the turn proceeds. A `propose` that reached the host before the restart is already in `state.json` (idempotent id).
- **Payload.** Results travel as text in the MCP `content`; a sources transcript page is ≤ 50k characters, within what the driver session stream already carries. Measured during the canary (tasks).
- **Removal in the same PR.** The outbox poller, `host-mcp.mjs`, the mounts and the sha upload never ran on prod (flag off, no sources project), so they go with this change instead of lingering behind a flag.

## Risks / Trade-offs

- [CLI pin drift changes the control protocol] → the protocol is the SDK's public contract; `scripts/host-tools-smoke.ts` runs a real `claude` against the handler for every pin bump (canary first, as `docs/housekeeping.md` says for pins).
- [A tool result too large for the agent's context] → `sources` limits are the server's own (paged transcript, `limit` on lists); `host` tools return small objects by construction.
- [The bot becomes a hop for sources calls] → one process, local SQLite, per-call open as today in `serve`; the daemon change moves the data, not this hop.

## Migration Plan

Bucket 3 (`HOST_TOOLS=1`) + bucket 2 (sources-gated). Home: flag on, containers recreated without mounts, both briefs and one `propose` round trip observed, timings logged; ledger row; prod flips `HOST_TOOLS` with C3 on the next tag and the flag retires afterwards.

## Open Questions

- Whether `registry` should hide projects the tenant's rules never target (today: the gate decides, the list is complete).
