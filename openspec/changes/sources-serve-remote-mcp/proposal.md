# Proposal

## Why

Today the ingest, the store and the sandbox must share a filesystem: the bot pulls, builds the store and bind-mounts a replica into the sandbox, where a stdio MCP server reads it. That ties the sandbox to the bot host, duplicates the store per sandbox and makes a hosted or second-person deployment (Vincent, Bluefin's tenant agent on prod sandboxes on another host) impossible without copying data around. Owen's direction (2026-10-14): ingest is just another tool; it runs wherever the data is and is reached over a secure channel.

## What Changes

- `orch sources serve <slug> --listen <host:port>`: the same sources tool table served over MCP streamable HTTP from the live store (read-only connection), bearer-token auth, freshness from the live `sync_state`.
- `orch sources daemon` (later, not on the prod path): the pull → build loop as its own process (today a ticker inside the bot), for a machine that ingests without running a bot.
- Project config: an `mcp` entry named `sources` with a `url` replaces the replica mount; `withSourcesMcp` already yields to a project-declared `sources` server, and `withSourcesMount` is skipped when the project declares it.
- Secure channel, prod: the bot host (aven-prod) already terminates TLS for `aven.guru` in nginx — a `location /sources/<slug>/mcp` proxies to the local `serve` port; agentgateway (Bluefin VM) gets a `sources` target on the project's `/gw/<slug>/mcp` route with a static bearer from its `.env`; sandboxes keep using Auth0 M2M. Nothing new on the network. A machine without a public name (a laptop) uses a `cloudflared` tunnel to the same nginx/gateway pattern — documentation, not code.
- Docs: `docs/sources.md` *Remote access*, `docs/runtime-config.md` (`mcp` entry), `docs/rollout.md` row.

## Capabilities

### New Capabilities
- `sources-remote-access`: reaching a project's sources store over the network with the same tools and the same read-only guarantees as the in-sandbox server.

### Modified Capabilities
- (none)

## Impact

- New `src/sources/serve.ts`, `src/sources/daemon.ts`, CLI wiring in `src/sources/cli.ts`; `snapshot/plain/sources-mcp.mjs` refactored so its tool table is importable by the host (the `.mjs` stays dependency-free for the sandbox).
- No new dependency: the host serves MCP streamable HTTP by hand (stateless JSON-RPC over POST, `Mcp-Session-Id` optional) in the same dependency-free style as the stdio server; agentgateway is the only client. `@modelcontextprotocol/sdk` stays a fallback if the gateway turns out to require SSE streams.
- Rollout bucket 3 by construction: nothing changes for a project without a `sources` `mcp` entry; the replica path stays the default.
- Unblocks: bluefin-ops on prod (REQUIRED there — verified 2026-10-14: prod sandboxes run on the Bluefin VM (Daytona, seven projects) and on the aven sandbox box (ssh-docker, the coach-aven project), never on the bot host, so the replica bind mount cannot reach them), hosted instance per person, write-back tools later.
