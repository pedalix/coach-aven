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
- **Host transport = hand-rolled streamable HTTP, stateless.** `POST /mcp` with a JSON-RPC body → `application/json` response (the spec allows a server to answer without an SSE stream); `GET` → 405; `Mcp-Session-Id` accepted and echoed, never required. The only client is agentgateway (then Claude Code behind it), and `handleMessage()` already exists — ~120 lines in `src/sources/serve.ts`, no dependency, same style as the stdio server. Alternative: `@modelcontextprotocol/sdk` StreamableHTTPServerTransport — kept as the fallback if the gateway insists on SSE (the parity test runs first against the gateway image locally).
- **Live store, read-only connection, `PRAGMA query_only`,** one connection per request from a small pool; builds already run in a transaction, so WAL readers see a consistent snapshot.
- **Auth: bearer from env for direct use; gateway-m2m for sandboxes.** The gateway holds the long-lived token (Cloudflare Access service token or a static bearer); sandboxes keep minting short-lived M2M tokens as for every other route.
- **Daemon = the existing `createSourcesTicker` loop lifted into a CLI command** with the same `sources_sync` facts; the bot's own ticker is disabled when `SOURCES_DAEMON=1` (bucket 3) so both never pull the same slug.
- **Exposure is documentation, not code.** Prod: nginx on aven-prod (already the TLS edge for `aven.guru`, `bot.aven.guru`) gets `location /sources/<slug>/mcp → 127.0.0.1:<port>`; `infra/prod/` carries the snippet. agentgateway: one more target on the project's existing backend (`mcp: { host: https://aven.guru/sources/<slug>/mcp }`, `Authorization: Bearer ${SOURCES_TOKEN_<SLUG>}`) — same shape as the caldora analytics targets. A laptop without a public name: `cloudflared tunnel` to the same route. The home bot keeps the replica mount (local driver).

## Risks / Trade-offs

- [Ingest machine offline → tools fail mid-turn] → the prompt already says "name what is unavailable and finish the turn"; `stats` first.
- [Token leakage through the sandbox] → sandboxes only ever hold M2M tokens via the gateway; the serve bearer never enters a sandbox.
- [Two processes (bot, daemon) racing on the store] → single-writer rule enforced by the `SOURCES_DAEMON` switch and a lock file in `data/<slug>/`.
- [Tool-table split breaks the sha-upload path] → both files uploaded by sha; test asserts the stdio server's tool list equals the exported table.

## Migration Plan

1. PR: tool-table split + `serve` + tests (parity test runs both transports over one fixture store). 2. PR: `daemon` + `SOURCES_DAEMON` switch. 3. Home bot canary: run `serve` locally, point `bluefin-ops` at `http://127.0.0.1:…` with a static bearer (local driver can reach the host network). 4. Docs for tunnel + gateway route; first remote use = hosted instance or prod bluefin-ops. Rollback: remove the `mcp` entry → replica path.

## Open Questions

- (resolved 2026-10-14) Prod sandboxes never run on the bot host: seven projects on Daytona (Bluefin VM <sandbox-vm>, 16 CPU/30 GB), the `coach-aven` project on the aven sandbox box (<sandbox-host>, ssh-docker + sysbox). `serve` is therefore on the critical path of bluefin-ops on prod. Fallback if `serve` slips: run bluefin-ops on the sandbox box with `driver: ssh-docker` and push the replica there after each build over the existing SSH (≈80 lines) — a second mechanism, so only if needed.
- Memory on aven-prod is the real constraint (7.6 GB, ~1.8 GB free): `aven-prod-archestra-1` (2.1 GB, a full CPU core) and `archestra-mcp-control-plane` (kind, 1.4 GB) are leftovers of the engine that moved to agentgateway on 2026-09-25 — stopping them (Owen's call) frees what the ingest needs.
