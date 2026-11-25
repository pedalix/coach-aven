## Context

`/aven housekeeping on` creates a routine of kind `housekeeping` (default 04:30) on the routine scheduler;
`fireHousekeeping` (`src/pollers.ts`) runs the janitor for it: `reapWorktrees` per repository, then one script
(`src/housekeeping.ts`) — the dockerd guard and the threshold-gated prune on a docker-in-docker project, the CLI
pin on every project. A stopped sandbox is woken for the pass where the bot owns the idle stop and it is on
(`sandbox-idle-stop`, "Housekeeping keeps running where the bot stops containers"), and skipped otherwise.

Since 2026-11-25 the host also starts a nightly memory tidy by itself (`company-brain` D9): a tick every minute
during the 03:00 hour, per project, from the lint alone.

Constraints: the host runs deterministic code only; no mounts; a `proj-*` container is never recreated; a
stopped container must not be woken without a reason, because every wake is a boot of its session files and its
dockerd.

## Goals / Non-Goals

**Goals:**

- A project is cleaned without anybody asking, and only when it has something to clean.
- One nightly pass per project, not two schedulers side by side.

**Non-Goals:**

- Changing what the janitor does.
- A fleet-wide pass, branch pruning, wedged-process detection.

## Decisions

### D1. The night hour, not a routine

The tidy's tick (`startNightlyTidy`) becomes the nightly pass: per project, housekeeping, then the tidy. The
`housekeeping` routine kind, its default cron and `fireHousekeeping`'s routine bookkeeping go.

- Why one hour for both: the tidy may need the sandbox awake anyway; cleaning first means it runs on a pruned
  disk and a converged CLI, and the sandbox is started once.
- Rejected: keeping the routine and creating it for every project at boot. It keeps the switch (a routine can
  be turned off and forgotten), the per-channel record, and a second schedule.

### D2. A pass needs a turn since the last one

The host decides from its own files whether a project worked: the newest record of the project in the usage log
(`usage/<month>.jsonl`, every turn of every kind) against the time of the last pass. The tidy's own turn is a
turn, so the night after a tidy the janitor runs once more and then the project is quiet.

- Why not "every night": a project nobody touched for a month would be started every night to find nothing.
  The idle stop exists to prevent exactly that.
- Why not "only if the sandbox is awake at that hour": a sandbox used in the afternoon is asleep by night, and
  it is the one that has stale worktrees and a full disk.
- What a stopped sandbox gets: the existing rule, unchanged — woken where the bot owns the idle stop and it is
  on, skipped otherwise; the summary of a skipped pass says so and the pass counts as done.
- Rejected: cleaning right before the idle stop. It would never wake anything, but it puts a command of up to
  fifteen minutes into the stop path, which is deliberately small and re-checked under a lock. Worth a look
  later; not in this change.

### D3. Where the last pass lives

`ProjectRecord` in `state.json` gains `housekeeping: { at, summary }` — what the routine record carried. The
bare verb reads it; the nightly rule compares `at` with the usage log.

- A stored housekeeping routine is dropped on load, in memory, as the dream routine is; its `lastRunAt` and
  `lastSummary` are not migrated — the first night writes new ones.

### D4. The command

`housekeeping` (bare) and `housekeeping now` stay; `on` and `off` answer with one line and do nothing. The
answer is kept, unlike the dream verb's, because the verb itself survives: an unknown sub-command of a known verb
should not become a question to the agent.

- `now` ignores D2 (a person asked) and nothing else: no live turn, the stopped-container rule.

### D5. Order and failure

Housekeeping is awaited before the tidy starts. A failed janitor is logged, stored as the summary and does not
stop the tidy. Both give up at the end of the hour; neither is retried that night after it ran.

## Risks / Trade-offs

- [Every active project's sandbox is started once a night where the idle stop is on] → that is what the routine
  did where it was enabled; it is bounded by D2 to projects that worked that day, and the idle stop puts the
  container back.
- [The prune removes something a person wanted] → unchanged from today: threshold-gated, never volumes, a
  stopped Sail stack's containers and images are kept (`sandbox-idle-stop`).
- [The CLI converges at night on installations that never enabled housekeeping] → it already converges at every
  chat preparation; the night only brings it forward.
- [The usage log is large] → one month's file, read once per project per night.

## Migration Plan

1. This spec, merged first.
2. One code PR: the nightly pass, the project record field, the command forms, the routine kind removed, a
   stored routine dropped at boot; Home lists, `docs/housekeeping.md`, `docs/commands.md`, the ledger.
3. `ship` by stage. The first night every project that had a turn that day gets a pass.
4. Rollback: ship the earlier version. A dropped housekeeping routine is not restored; `/aven housekeeping on`
   creates it again there.

## Open Questions

- Should the pass post one line to the alert channel when the prune ran or the disk is still above the
  threshold after it?
