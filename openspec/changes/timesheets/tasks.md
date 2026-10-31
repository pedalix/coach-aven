# Tasks

- [ ] 1. `sheets.json` contract: types, validation (unknown keys, unreachable rules, unknown projects), loader in the attribution inputs; tests.
- [ ] 2. `sheetEvidence` (pure): re-key timelog evidence to `sheet:<project>` by the rules (keys, repos, containers, title); `unmapped`; tests on a synthetic tenant.
- [ ] 3. `sheetlayout.ts` (pure): weekend shift, per-day cap, rounding with largest-remainder per project; tests (Saturday, cap overflow, totals preserved).
- [ ] 4. `timesheet` tool in the sources MCP (version bump), reading `ledger/submitted.jsonl` for excluded periods and the cap line; golden tests; `reconcile` gains `submitted`/`open` only when the ledger exists (golden: unchanged without it).
- [ ] 5. `docs/sources.md` → *Timesheets*; `docs/attribution.md` roadmap row; rollout ledger row (bucket 2 by construction).
- [ ] 6. Canary (the home tenant): its three sheets in `annotations/sheets.json`, the October periods already handed in as `submitted.jsonl` lines, the tenant CLI's `sheet submit`, the prompt line "табель за …"; October closed through it.
