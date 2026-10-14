# Tasks

## 1. Tool table split

- [ ] 1.1 Move the tool definitions and `call()` out of `snapshot/plain/sources-mcp.mjs` into `snapshot/plain/sources-tools.mjs`; keep the stdio loop in place; upload both by sha in `ensureSourcesMcp`; verify existing `mcp-server.test.ts` passes unchanged and a new test asserts the stdio tool list equals the exported table.

## 2. Serve

- [ ] 2.1 Add `@modelcontextprotocol/sdk` (host only) and `src/sources/serve.ts`: streamable HTTP server over the live store (read-only, `query_only`), bearer auth from `SOURCES_SERVE_TOKEN`, `--listen`; verify with a parity test calling `search`/`get`/`stats` over HTTP and over stdio against one fixture store.
- [ ] 2.2 `stats.meta` from live `sync_state`; verify a test with a stale source.
- [ ] 2.3 CLI `orch sources serve <slug>` in `src/sources/cli.ts`; verify `--help` and a smoke run against the owen-ops store on the home machine.

## 3. Daemon and project wiring

- [ ] 3.1 `orch sources daemon` running the pull → build ticker for configured projects, lock file per slug, `SOURCES_DAEMON=1` disables the bot's ticker; verify by a sync test and by running both and observing a single pull per interval.
- [ ] 3.2 `withSourcesMount` skipped when the project's `mcp` declares `sources` with a `url` (`src/projects.ts`); verify with a projects test (replica by default, none when declared).

## 4. Docs and canary

- [ ] 4.1 `docs/sources.md` *Remote access* (serve, daemon, tunnel + gateway route), `docs/runtime-config.md` `mcp` example, `docs/rollout.md` rows (bucket 3: `SOURCES_DAEMON`, config-gated `mcp` entry); verify typecheck + tests.
- [ ] 4.2 Home bot: `bluefin-ops` pointed at a local `serve`; verify a brief turn uses the remote tools (session log shows the HTTP server name) and `/aven usage` shows no change in cost.
