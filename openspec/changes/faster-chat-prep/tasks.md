# Tasks

## 1. Code

- [x] 1.1 `src/pool.ts`: `eachLimit`. Verify: `src/pool.test.ts` (cap, all settle, first error in list order, limit 1 = sequential).
- [x] 1.2 `src/tasks.ts` `prepareChat`: `cloneRepo` and `reapWorktrees` through `eachLimit` (4). Verify: `npm run typecheck`, `npm test`.
- [x] 1.3 `src/project.ts` `reapWorktrees`: idle from the admin files, the idle test before `status`, `status --no-optional-locks`, a failed `status` keeps the worktree. Verify: `src/project.reap.test.ts` (real git; the first and third tests fail on the old script).

## 2. Docs

- [x] 2.1 `docs/configuration.md` (`WORKTREE_REAP_HOURS`), `docs/housekeeping.md`.
- [x] 2.2 No flag, so no `docs/rollout.md` row; no Slack surface changes, so no Home tab update.
- [ ] 2.3 One PR: typecheck, tests, `scripts/public-guard.sh`.

## 3. After the merge

- [ ] 3.1 On the canary with the 15-repo project: the "Preparing sandbox" phase of a new conversation on a warm sandbox, before and after (bot log timestamps).
- [ ] 3.2 Archive this change into `openspec/specs/chat-preparation/`.
