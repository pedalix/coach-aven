## 1. The rule (pure)

- [x] 1.1 `src/housekeeping.ts`: `passDue({ lastPassAt, lastTurnAt })` and the last-turn reader over the usage log (`src/metering.ts`) — `src/housekeeping.test.ts`, `src/metering.test.ts`
- [x] 1.2 `ProjectSettings.housekeeping` (`at`, `summary`) — `src/state.test.ts`
- [x] 1.3 Drop a stored housekeeping routine on load, logged once; remove `housekeeping` from the routine kind — `src/state.test.ts`

## 2. The nightly pass

- [x] 2.1 `src/pollers.ts`: the night tick runs, per project, housekeeping (when due, never over a live turn, the stopped-container rule of `housekeepingSandboxStep`) and then the tidy; `fireHousekeeping`'s routine path goes — the rule in `src/housekeeping.test.ts`, the tidy in `src/brain/night.test.ts`
- [ ] 2.1b A test of the night pass itself over a fake sandbox driver (the pass needs `createDriver`, which the recorded pollers harness does not fake)
- [x] 2.2 A failed janitor is logged, stored as the summary, and the tidy still runs — the same test

## 3. Commands and Home

- [x] 3.1 `src/chat/core/commands.ts`: bare verb from the project record, `now`, the one-line answer to `on`/`off` — recorded command snapshots re-recorded on purpose
- [x] 3.2 Routine views (Slack blocks, Teams cards, web views) and the status line lose the housekeeping kind
- [x] 3.3 Home lists of the three surfaces: upkeep is automatic, `housekeeping` shows the last pass, `now` runs one — Home snapshots, `docs/commands.md`

## 4. Docs and rollout

- [x] 4.1 `docs/housekeeping.md`: the shape (the night hour, the turn-since rule, no routine), status line updated
- [x] 4.2 `docs/rollout.md`: a *Retired* row for the housekeeping routine and its switch
- [x] 4.3 `npm run typecheck`, `npm test`, `openspec validate nightly-housekeeping --strict`

## 5. After the deploy

- [ ] 5.1 First night on production: which projects had a pass, how many sandboxes were woken, what the prune freed — into `docs/housekeeping.md`
