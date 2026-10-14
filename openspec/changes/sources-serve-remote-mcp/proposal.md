# Proposal

## Why

Today the ingest, the store and the sandbox must share a filesystem: the bot pulls, builds the store and bind-mounts a replica into the sandbox, where a stdio MCP server reads it. That ties the sandbox to the bot host, duplicates the store per sandbox and makes a hosted or second-person deployment (Vincent, Bluefin's tenant agent on prod sandboxes on another host) impossible without copying data around. Owen's direction (2026-10-14): ingest is just another tool; it runs wherever the data is and is reached over a secure channel.

## What Changes

- `orch sources serve <slug> --listen <host:port>`: the same sources tool table served over MCP streamable HTTP from the live store (read-only connection), bearer-token auth, freshness from the live `sync_state`.
- `orch sources daemon`: the pull → build loop as its own process (today a ticker inside the bot), so the bot does not need the raw data at all.
- Project config: an `mcp` entry named `sources` with a `url` replaces the replica mount; `withSourcesMcp` already yields to a project-declared `sources` server, and `withSourcesMount` is skipped when the project declares it.
- Secure channel: documented path = `cloudflared` tunnel from the ingest machine to a hostname behind Cloudflare Access (service token held by agentgateway), agentgateway route `/gw/<slug>/sources` with the existing Auth0 M2M for sandboxes. No new gateway.
- Docs: `docs/sources.md` *Remote access*, `docs/runtime-config.md` (`mcp` entry), `docs/rollout.md` row.

## Capabilities

### New Capabilities
- `sources-remote-access`: reaching a project's sources store over the network with the same tools and the same read-only guarantees as the in-sandbox server.

### Modified Capabilities
- (none)

## Impact

- New `src/sources/serve.ts`, `src/sources/daemon.ts`, CLI wiring in `src/sources/cli.ts`; `snapshot/plain/sources-mcp.mjs` refactored so its tool table is importable by the host (the `.mjs` stays dependency-free for the sandbox).
- New host dependency `@modelcontextprotocol/sdk` (server + streamable HTTP transport) — host only, not the sandbox image.
- Rollout bucket 3 by construction: nothing changes for a project without a `sources` `mcp` entry; the replica path stays the default.
- Unblocks: hosted instance per person, bluefin-ops on prod when sandboxes run on another host, write-back tools later.
