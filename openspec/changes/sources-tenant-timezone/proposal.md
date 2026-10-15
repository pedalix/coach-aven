# Proposal

## Why

Owen, 2026-10-15: UTC in persistence, the tenant's time zone in presentation. The sources tools read every bare date in one zone per bot (`AVEN_TZ`), so bluefin-ops on the home bot counted Bluefin's days in Moscow; the attribution layer kept a second zone in its own config and stored each fragment's local day.

## What Changes

- `sources.timezone` (IANA) in the project config — the tenant's zone; default the bot's `AVEN_TZ`, so nothing changes for a project that does not set it.
- The store build writes it into the store as `tz`; every sources tool call presents that store's answers in it (bare dates, `today`, `stats.tz`), whatever the server's default.
- Storage is UTC only: the attribution table loses its local `day` column (schema v8); the `attribution` tool turns the asked days into UTC bounds and labels rows with their local day when answering. `timezone` leaves `annotations/attribution.json` — one zone per tenant.
- Tool descriptions name "the project's time zone (stats.tz)" with the server default, not one fixed zone. Sources MCP 1.6.0.
- Out of scope: routine schedules (each routine keeps its own zone), prod config (no prod project has `sources`).

## Capabilities

### New Capabilities
- `sources-timezone`: one presentation zone per tenant over UTC storage.

### Modified Capabilities
- (none)

## Impact

- `src/sources/{types,config,store,run}.ts`, `src/sources/attribution/{config,build}.ts`, `snapshot/plain/sources-mcp.mjs` (+ `.d.mts`), tests, `docs/sources.md`, `docs/rollout.md`. Bucket 2 (default-preserving: absent → the bot zone). Schema v8 rebuilds each store from raw once.
