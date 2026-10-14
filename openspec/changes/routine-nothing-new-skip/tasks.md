# Tasks

## 1. Fingerprint

- [ ] 1.1 Add `linesSince(rowid)` / `maxRowid()` to the store API (`src/sources/store.ts`) and persist `lastDeliveredRowid` on the routine guard record when a run settles as delivered; verify with a store test and a guard test (delivered → rowid stored; store rebuild → reset to 0).
- [ ] 1.2 Add `dueNow(slug, today)` in `src/sources/tenant.ts` reading open escalations and commitments due on/before today from the tenant checkout; verify with fixture files (open/answered escalation, due/undue commitment, missing files → empty).

## 2. Guard decision

- [ ] 2.1 In `src/routineguard.ts`, add the `skipped-empty` outcome: for scheduled/late fires of a project with sources, when `ROUTINE_SKIP_EMPTY=1`, the routine does not opt out, delta is 0, due is empty and every source is within its interval → return a skip decision with the fixed message; verify with guard tests for each branch (flag off, manual fire, opt-out, due present, stale source).
- [ ] 2.2 Wire the decision in `src/pollers.ts`: post the parent message, record the outcome, no turn, no usage; verify by a pollers test with a fake clock and a fake sources state.
- [ ] 2.3 Preamble and `missedRoutines` treat a skipped slot as served and still name the last delivered run; verify with the existing preamble tests extended by a skipped slot.

## 3. Surface and docs

- [ ] 3.1 `/aven routines` list shows the last skip with its time (`src/blocks.ts`, Home tab cheat-sheet unchanged unless a new command appears); verify by rendering test.
- [ ] 3.2 `docs/runtime-config.md` (flag, `skipEmpty`), `docs/rollout.md` ledger row (bucket 3, `ROUTINE_SKIP_EMPTY`); verify `npm test` and typecheck.

## 4. Canary

- [ ] 4.1 Home bot: set the flag, fire a manual run right after a delivered one (manual always fires), then observe the next scheduled slot after a quiet period; verify the channel shows `⏭ nothing new since …` once and the following real run's preamble is correct.
