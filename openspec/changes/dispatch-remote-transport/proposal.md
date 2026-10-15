# Proposal

## Why

Phase A of the dispatch primitive moves proposals through a bind-mounted outbox, which only exists for sandboxes on the bot host's own docker engine (the home bot). The tenant agent that needs dispatch most — bluefin-ops on prod — runs on Daytona on another host, and the agents it should reach (the project agents: caldora, holidayshop-hsx, …) live in the prod bot's registry, not the home bot's. The first real dispatch (2026-10-15) went to `owen-ops` only because the dry run had no other target, and `owen-ops` could not answer: the question was about CB tickets it does not ingest. The target has to be the project agent, so the proposal has to travel to the bot that owns it.

## What Changes

- Host endpoint: the bot host accepts proposals over HTTP (`POST /proposals/<slug>`), authenticated like the sources listener (a static bearer behind nginx on the bot host; agentgateway route `/gw/<slug>/host` for sandboxes, which present their Auth0 M2M token as for every other route). The same `handleProposal` path as the outbox: validate, store, render, gate.
- Sandbox tool: `host-mcp.mjs propose` posts to `HOST_PROPOSALS_URL` when set (headers from the gateway helper), else writes the outbox file as today. One record, two transports.
- Session identity over HTTP: the record keeps `AVEN_SESSION`; the endpoint maps it to the thread exactly as the outbox path does.
- Scope: phase B serves remote sandboxes of the SAME bot. A cross-bot relay (home bot → prod bot) is not in scope: once bluefin-ops runs on prod (C3), its targets are local to the prod bot.
- Docs: `docs/runtime-config.md` → *Dispatch* (transport B), `infra/prod/` snippets (nginx location + unit, beside the serve ones), `docs/rollout.md` row (bucket 3: the endpoint runs only when started; `DISPATCH=1` stays the switch).

## Capabilities

### New Capabilities
- (none)

### Modified Capabilities
- `agent-dispatch`: a proposal may reach the host over HTTP from a sandbox on another host, with the same validation, gate and provenance as the outbox transport.

## Impact

- `src/dispatchrun.ts` (one more ingress calling `ingest`), a small listener sharing `src/sources/serve.ts`'s HTTP shape (or one process serving both `/mcp` and `/proposals`), `snapshot/plain/host-mcp.mjs` (HTTP transport), `src/hostmcp.ts` (env for the url), `infra/prod/`, docs.
- Prod unaffected until the listener is started and a project's sandbox gets the url (`DISPATCH=1` + the `host` entry); bucket 3.
- Depends on `sources-serve-remote-mcp` prod wiring (same nginx/gateway pattern); unblocks C3 with real targets.
