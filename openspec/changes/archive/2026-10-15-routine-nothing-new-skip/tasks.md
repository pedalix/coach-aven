# Tasks

## 1. Fingerprint

- [x] 1.1 `rawRecordCount(path)` in `src/sources/store.ts` (count of `raw_records` — the table has no rowid) and `lastDeliveredRawCount` persisted on the routine record when a run settles as delivered (pollers.ts); verified by `tenant.test.ts` (count, missing/junk file) and the guard tests (lower count = rebuilt → fire).
- [x] 1.2 `readDueNow(slug, tenant, today)` + pure `dueFromText` in `src/sources/tenant.ts` reading open escalations and commitments due on/before today from the tenant checkout; verify with fixture files (open/answered escalation, due/undue commitment, missing files → empty).

## 2. Guard decision

- [x] 2.1 In `src/routineguard.ts`, `emptySkipDecision` + outcome `skipped`: for scheduled/late fires of a project with sources, when `ROUTINE_SKIP_EMPTY=1`, the routine does not opt out, delta is 0, due is empty and every source is within its interval → return a skip decision with the fixed message; verify with guard tests for each branch (flag off, manual fire, opt-out, due present, stale source).
- [x] 2.2 Wire the decision in `src/pollers.ts`: post the parent line, record the outcome, no turn, no usage (the decision and every reader are pure and tested; pollers.ts has no test harness today, so the wiring is verified on the canary).
- [x] 2.3 Preamble and `missedRoutines` treat a skipped slot as served and still name the last delivered run; verify with the existing preamble tests extended by a skipped slot.

## 3. Surface and docs

- [x] 3.1 `/aven routines` list shows the last skip with its time (`src/blocks.ts`, Home tab cheat-sheet unchanged unless a new command appears); verify by rendering test.
- [x] 3.2 `docs/runtime-config.md` (flag, `skipEmpty`), `docs/rollout.md` ledger row (bucket 3, `ROUTINE_SKIP_EMPTY`); verify `npm test` and typecheck.

## 4. Canary

- [ ] 4.1 Home bot: set the flag, fire a manual run right after a delivered one (manual always fires), then observe the next scheduled slot after a quiet period; verify the channel shows `⏭ nothing new since …` once and the following real run's preamble is correct. — not observed yet: no quiet slot since the flag went on (every slot had new records); stays on the tenant plan as an open observation.
