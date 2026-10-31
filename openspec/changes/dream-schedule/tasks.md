## 1. Implementation

- [x] 1.1 `handleDream`: `on <when>` parsed with `parseSchedule`; create or patch `cron`/`spec`/`tz`; refuse an unreadable
  schedule. Verify: `src/chat/slack/commands.record.test.ts` (`dream-on-weekly`, `dream-nightly-to-weekly`,
  `dream-on-bad-when`; `dream-on` unchanged).
- [x] 1.2 The Home lists (Slack `homeBlocks`, Teams, web) and the status line name the weekly form; snapshots
  re-recorded on purpose, `docs/commands.md` regenerated. Verify: `npm test` (`commandsdoc.test.ts`, the home and card
  snapshots).
- [x] 1.3 The `docs/rollout.md` ledger row. Verify: the row is there.
- [ ] 1.4 After the release: `/aven dream on weekly sun 3:00` in the production channels whose dreams are nightly.
  Verify: `/aven dream` there shows `weekly sun 3:00`.
- [ ] 1.5 Archive with `/openspec-archive-change` after 1.4.
