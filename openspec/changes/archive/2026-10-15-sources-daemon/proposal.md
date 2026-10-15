# Proposal

## Why

Ingest (pull → build → replica) runs inside the bot process, so a project's store and its source tokens live on the bot host. The data does not always belong there: `local` sources read the operator's own machine, a tenant's store belongs in the tenant's infrastructure (Bluefin's VM for bluefin-ops), and a public SaaS bot should hold no mailbox or chat token of anyone. Plan v3 deferred the daemon "while the bot host ingests". With `host-tools` the bot is the hub the agent talks to, so the missing piece is a process that ingests and serves where the data is, with the bot forwarding the agent's sources calls to it.

## What Changes

- `orch sources daemon`: the existing ticker (`createSourcesTicker`, pull → build → replica, backoff, re-auth parking, daily check) plus the `serve` HTTP face for every project it is configured for, in one process with a lock file per slug. `SOURCES_DAEMON=1` on the bot disables the bot's own ticker (bucket 3).
- Project config `sources.daemon: { url, tokenEnv }`: the bot forwards the project's `sources` JSON-RPC (the control-channel server from `host-tools`) to `POST <url>/mcp/<slug>` with the bearer from `tokenEnv`; without the block the bot answers from its local replica as before.
- Daemon status: `GET <url>/status/<slug>` returns the sync state, the raw record count and the tenant due-now counts, so `/aven status` and the empty-slot skip need neither the replica nor the tenant checkout on the bot host; the daemon owns the tenant checkout.
- `infra/prod/coach-aven-sources-daemon.service.tmpl` replaces the per-slug serve unit; `docs/runtime-config.md` → *Sources daemon*, `docs/sources.md` → *Poller* and *Remote access*, `docs/rollout.md` row.
- Out of scope: a daemon the bot cannot route to (tunnels are the ops repo's business); more than one bearer per daemon; agent access to the daemon other than through the bot.

## Capabilities

### New Capabilities
- `sources-daemon`: ingest and serve as one process where the data lives; the bot is its only client.

### Modified Capabilities
- `sources-remote-access`: the bot's channel-served `sources` answers from the local replica or, when `sources.daemon` is set, by forwarding to the daemon.

## Impact

- New `src/sources/daemon.ts` (CLI command: ticker + serve, lock); `src/sources/serve.ts` grows `/mcp/<slug>` routing and `/status/<slug>`; `src/hosttools.ts` gains the forwarder (HTTP client with the bearer, errors mapped to a JSON-RPC error the agent reads as "replica unavailable"); `src/pollers.ts` and `src/commands.ts` take sync state, raw count and due-now from a provider (local files or the daemon status) chosen per project; `infra/prod/`; docs.
- Bucket 3: `SOURCES_DAEMON` on the bot and `sources.daemon` per project; both absent → today's behaviour. Prod unchanged until C3 points bluefin-ops at a daemon.
