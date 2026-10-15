# Tasks

## 1. Host endpoint

- [ ] 1.1 `POST /proposals` on the sources listener (`src/sources/serve.ts`): bearer check, body limit, `parseProposal`, hand-off to the dispatcher's `ingest(slug, …)` for the listener's slug; verify with serve tests (valid → 202 + id, duplicate → 202 no-op, invalid → 400, no bearer → 401).
- [ ] 1.2 Wire the dispatcher into `orch sources serve` (the CLI runs on the bot host with the registry and state); verify a smoke POST on the home machine renders the proposal in a thread.

## 2. Sandbox transport

- [ ] 2.1 `host-mcp.mjs`: when `HOST_PROPOSALS_URL` is set, POST the record with the gateway helper's headers (same helper as `mcp.ts`), else write the outbox file; verify with a test that stubs fetch (url set → POST body = record; unset → file).
- [ ] 2.2 `hostmcp.ts`: pass `HOST_PROPOSALS_URL` from the project's `host` mcp entry (url) — a project that declares `{ name: "host", url, auth: "gateway-m2m" }` gets the HTTP transport and no outbox mount; verify with a projects test.

## 3. Prod wiring and docs

- [ ] 3.1 `infra/prod/nginx-sources.conf.example` gains the `/proposals` location; gateway route `/gw/<slug>/host` documented; `docs/runtime-config.md` → *Dispatch* transport B; `docs/rollout.md` row (bucket 3).
- [ ] 3.2 Canary on prod (after C3): bluefin-ops → `caldora` dispatch with the CB-161/151/196 question; the caldora agent answers in its channel with the YouTrack MCP; pointer back in bluefin-ops' thread.
