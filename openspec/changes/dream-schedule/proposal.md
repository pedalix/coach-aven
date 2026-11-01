## Why

A dream (memory consolidation) runs every night at 03:00, also after days without a conversation. On the production
installation in October 2026 two nightly dreams were its biggest cost line — up to about $5.7 a run, almost all of it
reading (hundreds of thousands of tokens written to the prompt cache, millions read, a couple of thousand written
out). The owner wants them weekly; `/aven dream` offers only nightly.

## What Changes

- `/aven dream on <when>` takes the forms `/aven schedule` already reads (`weekly sun 3:00`, `daily 3:00`,
  `weekdays HH:MM`, `cron …`): it creates the dream on that schedule, or moves an existing one to it.
- Bare `/aven dream on` is as before: nightly at 03:00 for a new dream, the schedule kept for an existing one.
- A schedule it cannot read is refused with the forms; nothing is created or changed.
- The Home lists (Slack, Teams, web) and the dream status line name the weekly form.

## Impact

- **Rollout bucket 2**, default-preserving: without `<when>` every reply and every schedule is today's (the recorded
  `dream-on`, `dream-on-off-status` snapshots keep their replies; the status line gains `[when]`). Visible: one Home
  line per surface names the weekly form.
- Out of scope: what a dream reads and whether it should run only after a day with turns — an open question in the
  operator's notes, not this change.
- Code: `src/chat/core/commands.ts` (`handleDream`), the three Home lists, recorded snapshots, `docs/commands.md`.
