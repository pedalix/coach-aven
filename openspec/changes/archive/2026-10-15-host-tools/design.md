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
- **Registration at process start.** Right after the process starts, before the first user message, the session writes `initialize` with `sdkMcpServers` (`host` while `DISPATCH=1`; `sources` when the project has a `sources` block — unless the project declares its own server of that name, which wins) and `sdkMcpServerConfigs` timeouts (`host` 30 s, `sources` 90 s). The CLI runs the MCP handshake over `mcp_message`; `sdkMcpServerManifests` (handshake pre-answered) is an optimisation for later. Verified on CLI 2.1.282 inside a sandbox (`scripts/host-tools-smoke.mjs`: handshake in 0.1 s, tool listed as `mcp__host__ping`, the model's call answered).
- **Pure tool tables.** `src/hosttools.ts` exports `mcpServer(name, tools)` — JSON-RPC in, JSON-RPC out — and the `host` tool table over `caller = {slug, conversationKey, teamId?}` (fixed by the turn engine when the session opens) and narrow deps (list projects, propose). Tests drive it with fakes. `sources` reuses `handleMessage` from the `.mjs` with the replica path of the caller's slug, on **one worker thread** for the bot (`src/sources/worker.mjs`): measured on the home stores, most calls take 1–70 ms but `unanswered` over the 198 MB owen-ops replica takes 1.1 s, which on the main thread would delay Slack acks and every other turn. A call that outlives 85 s restarts the worker; its other pending calls fail, a fresh worker serves the next.
- **`propose` reply** = `{ok, id, status, gate: buttons|auto, note?, duplicate?}`; the id is a content hash of project, conversation, kind, target and text, so a retried call is the same proposal and answers with its current state. The thread rendering, Send/Dismiss, provenance and the daily cap are unchanged (`agent-dispatch`); the proposal renders in the conversation's `inflight` channel and thread (the lookup fix of #173).
- **`registry`** returns the projects the caller's workspace is served for as `{slug, channel?, self?}` — no repos, no tokens, no prompts. **`routine`** is deferred (see proposal).
- **Reattach.** The snapshot scan that recognises a pending `can_use_tool` also recognises a pending `mcp_message`; the reattached session holds the same routes, so it answers the call for real. A `propose` that reached the host before the restart is already in `state.json` and answers as a duplicate.
- **One writer on stdin.** Every line a session writes (turns, control responses, tool answers) goes through one promise chain. On ssh-docker each write is its own `cat > fifo`; two writes over `PIPE_BUF` to one FIFO may interleave, and parallel tool calls make concurrent answers of tens of KB normal.
- **Payload.** Results travel as text in the MCP `content`; a sources transcript page is ≤ 50k characters, within what the driver session stream already carries. Measured during the canary (tasks).
- **Removal in the same PR.** The outbox poller, the mounts and the sha uploads never ran on prod (flag off, no sources project), so they go with this change instead of lingering behind a flag. One exception: `snapshot/plain/host-mcp.mjs` stays for one release — a bot that pulled this change but still runs the old code reads it at every session prep while `DISPATCH=1`.
- **No exceptions.** The bot injects no mount and no tenant keeps one. A deterministic program that needs the whole store (owen-ops' review loader) does not get the file in the sandbox — neither as a mount nor as a copy; its logic moves into the store build as a platform layer whose results the tools serve (OpenSpec `attribution-layer`). Until then owen-ops' existing container keeps its old mount (containers are not recreated on an option change).

## Risks / Trade-offs

- [CLI pin drift changes the control protocol] → the protocol is the SDK's public contract; `scripts/host-tools-smoke.ts` runs a real `claude` against the handler for every pin bump (canary first, as `docs/housekeeping.md` says for pins).
- [A tool result too large for the agent's context] → `sources` limits are the server's own (paged transcript, `limit` on lists); `host` tools return small objects by construction.
- [The bot becomes a hop for sources calls] → one process, local SQLite, per-call open as today in `serve`; the daemon change moves the data, not this hop.

## Migration Plan

Bucket 3 (`DISPATCH=1`, already on at home) + bucket 2 (sources-gated). Home: restart, both briefs and one `propose` round trip observed (session init lists `sources`/`host` with `source: sdk`), timings logged; ledger row; prod gets it with C3 on the next tag.

## Open Questions

- Whether `registry` should hide projects the tenant's rules never target (today: the gate decides, the list is complete).
- Resolved: owen-ops' review loader goes into the platform as the attribution layer (OpenSpec `attribution-layer`).
