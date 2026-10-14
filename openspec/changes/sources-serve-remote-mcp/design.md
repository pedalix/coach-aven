# Design

## Context

`snapshot/plain/sources-mcp.mjs` implements JSON-RPC over stdio by hand (no SDK in the sandbox image). The store is one SQLite file per project in WAL mode; builds are incremental and swap the replica atomically. The bot has no inbound HTTP today (Slack Socket Mode). agentgateway (`<gateway-host>/gw/<slug>/mcp`, Auth0 M2M, `docs/runtime-config.md` → MCP gateway) already fronts per-project MCP routes. See proposal.md.

## Goals / Non-Goals

**Goals:**
- One tool table, two transports: the `.mjs` keeps running unchanged in sandboxes; the host imports the same module and serves it.
- The ingest process is separable from the bot (daemon), so a hosted deployment is `daemon + serve` on one machine and the bot anywhere.

**Non-Goals:**
- Write tools (feedback, annotations) over this channel — later, same transport.
- Multi-tenant serving from one process — one `serve` per slug.
- Replacing agentgateway or adding a Cloudflare Worker gateway.

## Decisions

- **Export the tool table from the `.mjs`.** Split `sources-mcp.mjs` into `sources-tools.mjs` (pure: `tools`, `call(name, args, db)`) and the thin stdio loop; both ship in the snapshot, the host imports `sources-tools.mjs` by path. Alternative: duplicate the queries in TypeScript — rejected, two implementations drift.
- **Host transport = `@modelcontextprotocol/sdk` StreamableHTTPServerTransport.** Host-side dependency only; the sandbox image stays dependency-free. Alternative: hand-roll streamable HTTP — more code, less compatible with Claude Code's MCP client.
- **Live store, read-only connection, `PRAGMA query_only`,** one connection per request from a small pool; builds already run in a transaction, so WAL readers see a consistent snapshot.
- **Auth: bearer from env for direct use; gateway-m2m for sandboxes.** The gateway holds the long-lived token (Cloudflare Access service token or a static bearer); sandboxes keep minting short-lived M2M tokens as for every other route.
- **Daemon = the existing `createSourcesTicker` loop lifted into a CLI command** with the same `sources_sync` facts; the bot's own ticker is disabled when `SOURCES_DAEMON=1` (bucket 3) so both never pull the same slug.
- **Tunnel is documentation, not code:** `cloudflared tunnel run` on the ingest machine → `sources-<slug>.<domain>` → agentgateway route. Local-mode home bot keeps using the replica; the tunnel is for hosted/remote sandboxes.

## Risks / Trade-offs

- [Ingest machine offline → tools fail mid-turn] → the prompt already says "name what is unavailable and finish the turn"; `stats` first.
- [Token leakage through the sandbox] → sandboxes only ever hold M2M tokens via the gateway; the serve bearer never enters a sandbox.
- [Two processes (bot, daemon) racing on the store] → single-writer rule enforced by the `SOURCES_DAEMON` switch and a lock file in `data/<slug>/`.
- [Tool-table split breaks the sha-upload path] → both files uploaded by sha; test asserts the stdio server's tool list equals the exported table.

## Migration Plan

1. PR: tool-table split + `serve` + tests (parity test runs both transports over one fixture store). 2. PR: `daemon` + `SOURCES_DAEMON` switch. 3. Home bot canary: run `serve` locally, point `bluefin-ops` at `http://127.0.0.1:…` with a static bearer (local driver can reach the host network). 4. Docs for tunnel + gateway route; first remote use = hosted instance or prod bluefin-ops. Rollback: remove the `mcp` entry → replica path.

## Open Questions

- Whether prod sandboxes run on the bot host (then the replica path also works for bluefin-ops on prod) — decides whether step 4 is needed before bluefin-ops goes to prod.
