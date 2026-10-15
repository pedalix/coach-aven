# Tasks

- [x] 1.1 `sources.timezone` validated in the project config; default the bot zone; verify with `src/sources/config.test.ts`.
- [x] 1.2 The build writes `tz` into the store; `callTool` presents each store in its zone and restores the default; verify with the `mcp-server` test (a Tokyo store answers in Tokyo; an older store keeps the default).
- [x] 1.3 Attribution: no local day stored (schema v8), UTC bounds at query, `timezone` rejected in `attribution.json`; verify with the attribution tests.
- [x] 1.4 Docs (`docs/sources.md` → dates, config table, attribution) and the ledger row.
- [x] 2.1 Home: owen-ops `sources.timezone: Europe/Moscow`, bluefin-ops `Europe/Zurich`, `timezone` removed from owen-ops' attribution.json; restart; verify `stats.tz` per project.
