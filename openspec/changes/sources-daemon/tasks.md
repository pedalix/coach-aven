# Tasks

## 1. Daemon

- [ ] 1.1 `src/sources/daemon.ts`: CLI command running `createSourcesTicker` for the configured projects plus the serve listener; lock per slug; verify with a sync test (bot ticker off under `SOURCES_DAEMON=1`; second writer refused) and a smoke run on the home machine.
- [ ] 1.2 `src/sources/serve.ts`: `/mcp/<slug>` routing for several projects and `GET /status/<slug>`; verify with the serve tests (unknown slug → 404, status shape, bearer).

## 2. Bot side

- [ ] 2.1 `src/hosttools.ts`: forwarder for `sources` when `sources.daemon` is set (HTTP client, bearer from `tokenEnv`, timeout → JSON-RPC error); verify with a stubbed HTTP server test (verbatim pass-through, error mapping).
- [ ] 2.2 `SourcesStateProvider` (local | daemon) feeding `sourceFreshness`, `rawRecordCount`, `readDueNow` and `/aven status`; verify the empty-slot tests with the daemon provider and the "unreachable → fire" rule.
- [ ] 2.3 Config: `sources.daemon` validated in `src/sources/config.ts` (url, tokenEnv); verify with the config tests.

## 3. Infra and docs

- [ ] 3.1 `infra/prod/coach-aven-sources-daemon.service.tmpl` (replaces the per-slug serve unit) and `runtime.example` notes; `docs/runtime-config.md` → *Sources daemon*; `docs/sources.md` → *Poller* (daemon mode) and *Remote access*; `docs/rollout.md` row (bucket 3, `SOURCES_DAEMON` + `sources.daemon`).

## 4. Canary and C3

- [ ] 4.1 Home: daemon as a second user unit, both projects on loopback, bot ticker off; verify pulls in the daemon log, `/aven status` from the daemon, unchanged briefs, per-call latency logged.
- [ ] 4.2 C3 (ops repo): bluefin-ops daemon on Bluefin's VM, bot forwards; verify the first prod field brief quotes `unanswered` rows and `stats.meta` ages from the daemon.
