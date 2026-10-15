# Proposal

## Why

Two of the bot's own capabilities reach the agent through bind mounts today: the sources replica (`/data/sources`) and the dispatch outbox (`/data/outbox`). Both work only when the sandbox runs on the bot host's docker engine (the home bot); prod sandboxes run on Daytona on another host, so the plan carried two more mechanisms for them (serve behind nginx plus a gateway target for sources, an HTTP endpoint for proposals). The rule since 2026-10-14 is simpler: no mounts, everything crosses the boundary as a tool call — turns go in, internal tools come back.

Claude Code already has that channel. The controlling process registers an in-process MCP server at `initialize` (`sdkMcpServers`); the CLI then delivers that server's handshake and tool calls back over the control channel as `mcp_message` requests (a JSON-RPC message inside) and takes the reply from `control_response.mcp_response`. The bot holds this channel for every session, answers `can_use_tool` on it already (AskUserQuestion), and knows which project and thread is calling from the channel itself. Verified in the SDK typings and in the pinned CLI 2.1.282 inside the sandboxes.

## What Changes

- A host-side MCP server `host`, registered per session over the control channel, with deterministic tools: `propose` (the dispatch record as a tool call; the reply is the proposal id and the gate decision), `registry` (the projects, channels and agents this bot runs, so a target is picked from facts), `routine` (what fired this turn, the previous outcome and run). No transport, credential or listener is added.
- `sources` served over the same channel: the bot answers the sources JSON-RPC itself with the tool table it already imports for `serve`, from the replica on its own disk. The in-sandbox copy of the server, the replica mount, the outbox mount and `host-mcp.mjs` are removed; neither server is an entry in the sandbox's `--mcp-config` any more.
- A host tool call pending across a bot restart is answered after reattach with an error result, so the agent finishes its turn (the treatment a pending AskUserQuestion gets today).
- Gates: the `host` server appears only with `HOST_TOOLS=1` (bucket 3, off by default, home canary first); `propose` additionally needs `DISPATCH=1` as today. `sources` over the channel is bucket 2: only projects with a `sources` block are affected and no prod project has one.
- Out of scope: forwarding `sources` to a daemon on another machine (`sources-daemon`), dispatch across two bots, any host tool that changes something without a button.

## Capabilities

### New Capabilities
- `host-tools`: tools implemented by the bot, served to the agent over the session's control channel, attributed to the calling project by the channel.

### Modified Capabilities
- `agent-dispatch`: the proposal record is submitted with the `host.propose` tool instead of a file in a mounted outbox; the reply carries the id and the gate decision.
- `sources-remote-access`: the control channel is the default way a sources project reaches its store; the replica mount and the in-sandbox stdio server go away; a `url` entry stays as the explicit override.

## Impact

- `src/claudeSession.ts`: send `initialize` with `sdkMcpServers` at process start, route `mcp_message` to the tool tables, recover a pending call on reattach. New `src/hosttools.ts`: pure tool table and JSON-RPC handling with tests, wired from `src/slack.ts` with the registry, state, dispatcher and routine guard. `src/dispatchrun.ts` loses the outbox poller; `src/hostmcp.ts`, `snapshot/plain/host-mcp.mjs`, `withOutboxMount`, `withSourcesMount` and the sha upload of the sources server are removed; `src/sources/mcp.ts` keeps the prompt paragraph without the path. Docs: `docs/runtime-config.md` (Host tools), `docs/sources.md` (Remote access rewritten), `docs/rollout.md` row.
- Bucket 3 for `host` (`HOST_TOOLS=1`), bucket 2 for `sources` over the channel. Prod has no sources project and both flags off, so nothing changes there. The home containers `proj-bluefin-ops` and `proj-owen-ops` are recreated without mounts.
- Supersedes `dispatch-remote-transport` (deleted) and the prod wiring tasks of `sources-serve-remote-mcp`: no nginx location and no gateway target are needed for sources; `serve` stays as the daemon's HTTP face.
