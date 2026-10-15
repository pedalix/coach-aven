# Tasks

## 1. Engine port (pure, tested)

- [x] 1.1 `src/sources/attribution/registry.ts` — initiatives.json routing (repos, local paths, title patterns, channels, keys, aliases, splits); verify with ported registry tests.
- [x] 1.2 `fragment.ts` + `substance.ts` — calls with topic splits, message runs, work blocks, substance threshold and attach-to-call, garbled meetings; verify with ported fragment tests (same ids).
- [x] 1.3 `ladder.ts` + admin — rules (deciding and candidates), admin bucket from config, exclusive markers, registry routing, narrow/broad; verify with ported ladder tests.
- [x] 1.4 `plan.ts` — ledger precedence, decided/open split, rule proposals (aliases, broad people excluded, purity); verify with ported plan tests.

## 2. Build integration

- [x] 2.1 `config.ts` — parse and validate `annotations/attribution.json`; verify with config tests.
- [x] 2.2 `build.ts` — loaders over the store (subject messages with participants, meetings with dedupe, activity routed by registry), the layer for the horizon, writes `att_*` tables; schema v7; fingerprint over the new tenant files; verify with a build test over a fixture store.

## 3. Readout and docs

- [x] 3.1 `attribution` in `snapshot/plain/sources-mcp.mjs` (1.5.0) + `.d.mts`; verify with mcp-server tests over the fixture store.
- [x] 3.2 `docs/sources.md` → *Attribution*; `docs/rollout.md` row (bucket 2).

## 4. Parity and canary

- [ ] 4.1 owen-ops commits `annotations/attribution.json`; the home bot's build fills the tables.
- [x] 4.2 Parity run: the tool's decided/open sets against `owen-ops review --since D --until D` (no `--write`) for three past days; differences explained or fixed. — Done 2026-10-15 on a copy of the home store, 12–15.10: identical ids, `decided`/`rule`/`open` sets and initiatives; one extra `rule` work block on 14.10 that started 21:xx UTC on 13.10 — the CLI loads a daily window by UTC day and filters by local day, so it never sees blocks just after local midnight; the platform loads with a day of margin.
