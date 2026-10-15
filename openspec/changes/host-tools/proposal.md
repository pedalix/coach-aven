# Proposal

## Why

Two of the bot's own capabilities reach the agent through bind mounts today: the sources replica (`/data/sources`) and the dispatch outbox (`/data/outbox`). Both work only when the sandbox runs on the bot host's docker engine (the home bot); prod sandboxes run on Daytona on another host, so the plan carried two more mechanisms for them (serve behind nginx plus a gateway target for sources, an HTTP endpoint for proposals). The rule since 2026-10-14 is simpler: no mounts, everything crosses the boundary as a tool call — turns go in, internal tools come back.

Claude Code already has that channel. The controlling process registers an in-process MCP server at `initialize` (`sdkMcpServers`); the CLI then delivers that server's handshake and tool calls back over the control channel as `mcp_message` requests (a JSON-RPC message inside) and takes the reply from `control_response.mcp_response`. The bot holds this channel for every session, answers `can_use_tool` on it already (AskUserQuestion), and knows which project and thread is calling from the channel itself. Verified in the SDK typings and in the pinned CLI 2.1.282 inside the sandboxes.

## What Changes

- A host-side MCP server `host`, registered per session over the control channel, with deterministic tools: `propose` (the dispatch record as a tool call; the reply is the proposal id and the gate decision) and `registry` (the projects this bot runs that the conversation may address, so a target is picked from facts). No transport, credential or listener is added. A `routine` tool (what fired this turn, the previous run) is deferred: the routine guard's preamble already carries that text, and it would need a per-turn stamp in the turn engine.
- `sources` served over the same channel: the bot answers the sources JSON-RPC itself with the tool table it already imports for `serve`, from the replica on its own disk, on a worker thread (a heavy `unanswered` over a 200 MB store takes about a second and must not stall Slack acks). The in-sandbox copy of the server, the automatic replica mount and the outbox mount are removed; neither server is an entry in the sandbox's `--mcp-config` any more. A tenant whose own code reads the replica file inside the sandbox (owen-ops' review loader) keeps it as an explicit `sandbox.mounts` line in its config — the operator's choice; the bot injects nothing.
- A host tool call pending across a bot restart is answered after reattach with an error result, so the agent finishes its turn (the treatment a pending AskUserQuestion gets today).
- Gates: the `host` server exists exactly while `DISPATCH=1` (bucket 3, off by default, as before — it replaces the stdio server that flag used to add); `sources` over the channel is bucket 2: only projects with a `sources` block are affected and no prod project has one. A dedicated `HOST_TOOLS` flag arrives with the first host tool that is not about dispatch.
- Out of scope: forwarding `sources` to a daemon on another machine (`sources-daemon`), dispatch across two bots, any host tool that changes something without a button.

## Capabilities

### New Capabilities
- `host-tools`: tools implemented by the bot, served to the agent over the session's control channel, attributed to the calling project by the channel.

### Modified Capabilities
- `agent-dispatch`: the proposal record is submitted with the `host.propose` tool instead of a file in a mounted outbox; the reply carries the id and the gate decision.
- `sources-remote-access`: the control channel is the default way a sources project reaches its store; the replica mount and the in-sandbox stdio server go away; a `url` entry stays as the explicit override.

## Impact

- `src/claudeSession.ts`: send `initialize` with `sdkMcpServers` at process start, route `mcp_message` to the routes, answer a pending call after reattach, serialise every stdin write. New `src/hosttools.ts` (pure JSON-RPC server + `host` tools) and `src/hostrouter.ts` (per-session routes, the sources worker `src/sources/worker.mjs`), wired from the composition root (`src/chat/slack/app.ts`) into the turn engine (`TurnDeps.hostRoutes`). `src/dispatchrun.ts` trades the outbox poller for `propose`; `src/hostmcp.ts`, `withOutboxMount`, `withSourcesMount` and the sha uploads are removed; `snapshot/plain/host-mcp.mjs` stays one release for bots that pulled but did not restart; `src/sources/mcp.ts` keeps the prompt paragraph without the path. Docs: `docs/runtime-config.md` (Host tools), `docs/sources.md` (Replica, Search tool, Remote access), `docs/sandbox-drivers.md`, `docs/rollout.md` row.
- Bucket 3 for `host` (`DISPATCH=1`), bucket 2 for `sources` over the channel. Prod has no sources project and `DISPATCH` off, so nothing is registered there. Home containers keep their old mounts until they are recreated; nothing reads the outbox any more.
- Supersedes `dispatch-remote-transport` (deleted) and the prod wiring tasks of `sources-serve-remote-mcp`: no nginx location and no gateway target are needed for sources; `serve` stays as the daemon's HTTP face.
