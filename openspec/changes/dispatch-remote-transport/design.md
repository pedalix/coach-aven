# Design

## Context

`createDispatcher().pollOutboxes()` claims files from `data/<slug>/outbox`; `ingest(slug, raw, file)` validates, stores and renders; `host-mcp.mjs` writes the file with `AVEN_SESSION`. `src/sources/serve.ts` is the host's one HTTP listener (stateless, bearer, loopback behind nginx; gateway in front for sandboxes). See proposal.md and `dispatch-primitive`.

## Goals / Non-Goals

**Goals:**
- Same record, same gate, same provenance — only the transport differs.
- A sandbox needs no new credential: the gateway's M2M token already identifies the project.

**Non-Goals:**
- Cross-bot relay; agent-to-agent conversation; executing anything without the gate.

## Decisions

- **One host process for `/mcp` and `/proposals`.** `orch sources serve <slug>` grows a `POST /proposals` route (same bearer), so prod runs one unit per project, not two. Alternative: a separate `orch dispatch serve` — one more unit and nginx location per project; rejected while both are per-slug.
- **The slug comes from the route, never from the body** (the endpoint is per project, like the sources listener), so a sandbox cannot propose on another project's behalf.
- **The gateway route `/gw/<slug>/host`** is a plain HTTP passthrough target (not MCP) with the same M2M policy; the sandbox's `propose` tool reads the url from `HOST_PROPOSALS_URL` and the Authorization header from the gateway headers helper (`mcp.ts` GATEWAY_HELPER_PATH), falling back to the outbox file when the url is unset.
- **Idempotency** stays on the proposal id (the sandbox generates it); a retried POST after a timeout is a no-op.

## Risks / Trade-offs

- [Endpoint abuse] → bearer + gateway M2M + per-slug route + body limits (1 MB) + the existing per-day cap.
- [Session mapping without `inflight` on the host] → the proposing thread is the sandbox's `AVEN_SESSION` key; the host resolves channel via the chat record or the project's bound channel exactly as today.

## Migration Plan

Bucket 3. After the serve prod wiring: add the route to the unit's listener, the nginx location and the gateway target; set `HOST_PROPOSALS_URL` for bluefin-ops on prod (C3); first dispatch = bluefin-ops → `caldora` with the question the 2026-10-15 dry run asked `owen-ops`.
