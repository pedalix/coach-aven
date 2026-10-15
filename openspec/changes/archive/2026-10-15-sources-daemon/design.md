# Design

## Context

`src/sources/sync.ts` is the ticker (pure, tested with fake clocks); `src/pollers.ts` runs it inside the bot and reads `rawRecordCount`, `readDueNow` and `readSyncState` from local files for the empty-slot skip and `/aven status`; `src/sources/serve.ts` is a stateless streamable-HTTP face over one replica with a static bearer; `src/sources/tenant.ts` clones the tenant repo before each build. `host-tools` makes the bot answer the agent's `sources` calls itself. See proposal.md.

## Goals / Non-Goals

**Goals:**
- One process per data location: tokens, raw, store, replica and the tenant checkout live with the daemon; the bot keeps nothing but a URL and a bearer.
- The agent's experience is unchanged: same tools, same markers, same freshness semantics (`stats.meta`).

**Non-Goals:**
- Multi-tenant auth on the daemon (one bearer, the bot is the only client); the sandbox talking to the daemon directly; a replica push.

## Decisions

- **Ticker + serve in one process** (`orch sources daemon`): one unit, one lock, one place for tokens. Alternative: separate `daemon` and `serve` units — two processes sharing files for no gain.
- **Single-writer rule.** `SOURCES_DAEMON=1` disables the bot's ticker for every project; the daemon takes `data/<slug>/.lock` (pid, mtime) per project; a second writer refuses to start. Verified by a sync test running both tickers against one fake pull.
- **Routing by slug in the path.** `POST /mcp/<slug>` and `GET /status/<slug>`; one bearer per daemon; a slug the daemon is not configured for → 404 without details. The bot forwards the JSON-RPC message verbatim and returns the response verbatim.
- **Status instead of files.** `/status/<slug>` = `{sync: <sources_sync fact value>, rawRecords, due: {escalationsOpen, commitmentsDue}, replicaAt}`; the bot's `sourceFreshness`, `rawRecordCount` and `readDueNow` become one `SourcesStateProvider` with two implementations (local, daemon), chosen per project; the empty-slot skip treats an unreachable daemon as "unreadable → fire", as today for a missing checkout.
- **Tenant checkout moves with the build.** The daemon syncs the tenant repo (it needs people.json for the build); it needs a GitHub credential of its own (deploy key or App installation token minted by the daemon) — the ops repo decides which.
- **Placement for C3**: the bluefin-ops daemon runs on Bluefin's VM; the bot on the bot host reaches it over the private network the ops repo defines (the public repo ships the unit and the bearer env, nothing about hosts).

## Risks / Trade-offs

- [Bot ↔ daemon partition] → sources calls fail with the JSON-RPC error the prompt already tells the agent to report in one line; routines fire rather than skip; `/aven status` shows "daemon unreachable since …".
- [Two tickers by misconfiguration] → the lock refuses the second; the first alert names the pid.
- [Latency: channel + HTTP hop] → measured in the home canary (daemon on loopback) and again on C3; both well under the tool timeout.

## Migration Plan

Bucket 3. Home canary: daemon as a second user unit on the same machine, both projects with `sources.daemon` on loopback, `SOURCES_DAEMON=1` on the bot, restart in the window; verify pulls continue from the daemon's log, `/aven status` reads the daemon, the briefs are unchanged. Then C3 per the tenant plan.
