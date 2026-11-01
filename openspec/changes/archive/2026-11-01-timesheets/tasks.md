# Tasks

- [x] 1. `sheets.json` contract: types, validation (unknown keys, unreachable rules, initiatives outside the umbrella, bad expressions, cap vs step), read at build into `att:sheets` (a broken file stored as its error); `submitted.jsonl` into `att:submitted`; tests.
- [x] 2. `sheetEvidence` (pure, sources MCP): re-key timelog evidence to `sheet:<project>` by the rules (keys, repos, containers, title, `projectFrom`, `sameDay`); `unmapped`; tests on a synthetic tenant.
- [x] 3. `layoutSheet` (pure, sources MCP): weekend shift, rounding with largest remainder per project, per-day cap moving whole steps; tests (Saturday, month edge, cap overflow, no room, submitted days, totals preserved).
- [x] 4. `timesheet` tool in the sources MCP (1.13.0), reading `att:submitted` for the days left out and the cap line; tests over a store; `reconcile` gains `submitted`/`open`/`committed` only when the ledger has a period (test: unchanged without it).
- [x] 5. `docs/sources.md` → *Timesheets*; `docs/attribution.md` roadmap row; rollout ledger row (bucket 2 by construction).
- [x] 6. Canary (the home tenant, 2026-10-31): its two sheets in `annotations/sheets.json` (the half-day one with `monthRange` 24–30), the period already handed in as a `submitted.jsonl` line, the prompt line for "табель за …"; October asked for and delivered through it. The tenant tried a CLI writer for `submitted.jsonl` and dropped it: the person copies the rows by hand and the client sheets are the record — a later change may read their contents instead.
