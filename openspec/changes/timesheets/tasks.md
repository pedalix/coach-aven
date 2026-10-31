# Tasks

- [x] 1. `sheets.json` contract: types, validation (unknown keys, unreachable rules, initiatives outside the umbrella, bad expressions, cap vs step), read at build into `att:sheets` (a broken file stored as its error); `submitted.jsonl` into `att:submitted`; tests.
- [x] 2. `sheetEvidence` (pure, sources MCP): re-key timelog evidence to `sheet:<project>` by the rules (keys, repos, containers, title, `projectFrom`, `sameDay`); `unmapped`; tests on a synthetic tenant.
- [x] 3. `layoutSheet` (pure, sources MCP): weekend shift, rounding with largest remainder per project, per-day cap moving whole steps; tests (Saturday, month edge, cap overflow, no room, submitted days, totals preserved).
- [x] 4. `timesheet` tool in the sources MCP (1.13.0), reading `att:submitted` for the days left out and the cap line; tests over a store; `reconcile` gains `submitted`/`open`/`committed` only when the ledger has a period (test: unchanged without it).
- [x] 5. `docs/sources.md` → *Timesheets*; `docs/attribution.md` roadmap row; rollout ledger row (bucket 2 by construction).
- [ ] 6. Canary (the home tenant): its sheets in `annotations/sheets.json`, the periods already handed in as `submitted.jsonl` lines, the tenant CLI's `sheet submit`, the prompt line for "табель за …"; the open month closed through it.
