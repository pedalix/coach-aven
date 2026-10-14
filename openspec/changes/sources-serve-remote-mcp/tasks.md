# Tasks

## 1. Tool table split

- [x] 1.1 No split needed: `src/sources/serve.ts` imports `handleMessage` from the unchanged `.mjs` (the stdio loop only runs when the file is the entry point), so one file stays the single source of truth and the sha upload path is untouched.

## 2. Serve

- [x] 2.1 `src/sources/serve.ts`: stateless streamable HTTP (POST JSON-RPC → JSON, 202 for notifications, 405 GET, 503 without replica, /health), constant-time bearer from `SOURCES_SERVE_TOKEN`, `--listen`; no dependency; `serve.test.ts` runs the surface in-process and over a real loopback socket. The agentgateway check is the prod canary (4.3).
- [x] 2.2 `stats.meta` is the replica's live `sync_state` (DB opened per call); the serve test asserts `last_build_at` comes through.
- [x] 2.3 CLI `orch sources serve <slug> [--listen] [--db]` in `src/sources/cli.ts`; refuses to start without the token.

## 3. Project wiring (daemon deferred)

- [ ] 3.1 (deferred — not needed while the bot host ingests) `orch sources daemon` running the pull → build ticker for configured projects, lock file per slug, `SOURCES_DAEMON=1` disables the bot's ticker; verify by a sync test and by running both and observing a single pull per interval.
- [x] 3.2 `withSourcesMount` skipped when the project's `mcp` declares `sources` with a `url` (`src/projects.ts`); tested in `serve.test.ts` (replica by default, none when declared).

## 4. Docs and canary

- [x] 4.1 `docs/sources.md` *Remote access*, `infra/prod/nginx-sources.conf.example` + `coach-aven-sources.service.tmpl`, `docs/runtime-config.md` note, `docs/rollout.md` row.
- [ ] 4.3 Prod: `serve` as a second systemd unit on aven-prod (`infra/prod/coach-aven-sources.service.tmpl`, port on loopback), nginx location, `SOURCES_TOKEN_BLUEFIN_OPS` in the gateway `.env` + target in `bluefin-infra/engine/config.yaml`; verify `initialize` 200 through `<gateway-host>/gw/bluefin-ops/mcp` with an M2M token before the project is enabled.
- [ ] 4.2 Home bot: `bluefin-ops` pointed at a local `serve`; verify a brief turn uses the remote tools (session log shows the HTTP server name) and `/aven usage` shows no change in cost.
