# Housekeeping

Scheduled **mechanical** hygiene of a project's sandbox — reaping stale git state, keeping
the DinD disk from filling, clearing wedged processes. The janitor, as opposed to
the [nightly memory tidy](memory.md#the-nightly-tidy) (a model's pass over the agent's memory).

> **Status: shipped, for every project.** There is no switch and no routine (OpenSpec `nightly-housekeeping`): during the
> 03:00 hour (`AVEN_TZ`) the bot runs the janitor for each project that had a turn since its last pass, then the
> [memory tidy](memory.md#the-nightly-tidy) of the same night. `/aven housekeeping` shows the last pass,
> `/aven housekeeping now` runs one. The janitor: on a docker-in-docker project (`"dind": true`) the dockerd guard and a threshold-gated
> docker prune (never volumes); on every project a proactive worktree reap, and (with `CLAUDE_CLI_VERSION` set) converging the sandbox's
> Claude Code CLI to the pin (`src/cliversion.ts`; the bump/canary procedure, which starts with a
> probe of the new version, is in `docs/cli-probe.md`). Pure script/report logic in `src/housekeeping.ts` (tested);
> firing in `src/pollers.ts`; the dockerd guard also runs at every chat prep
> (`ensureDockerd`). Still open below: branch pruning, wedged-process detection,
> a fleet-wide pass.

## Decision (TL;DR)

- **Separate from the memory tidy.** Different nature, cost, and risk — see below.
- **Mostly deterministic, no LLM.** Housekeeping is shell/API on a schedule
  (`git worktree prune`, `docker image prune`, disk checks). Reserve the LLM only for the
  rare task that genuinely needs judgment.
- **No switch.** Every project is cleaned without a command; a quiet project costs nothing — see [Shape](#shape).
- **Safe by construction:** idempotent, never touches active state, report-before-delete
  for anything destructive.

## Why separate from the memory tidy

| | Memory tidy | Housekeeping |
| --- | --- | --- |
| Nature | cognitive (consolidate/synthesize memory) | mechanical (reap/prune/restart) |
| Needs an LLM | yes — judgment | mostly no — deterministic |
| Cost | a full agent turn | cheap shell/API |
| Risk | memory drift | deleting real state → needs idempotency + safety |
| Acts on | the project's memory | git worktrees, branches, disk, processes |

Mixing them means paying for an LLM turn to run `git worktree prune`. Keep them as two
distinct inhabitants of the same scheduler.

## Already exists

- **`reapWorktrees`** (`src/project.ts`) — reaps finished/orphaned task worktrees, ~12h
  idle (since the worktree's own last git activity, not its commit's date), lazily on session prep. Housekeeping makes this proactive and consolidates it with
  the rest below.

## Tasks (inside `proj-<slug>`)

- ✅ **dockerd guard** — `docker info` + restart if dead (v1; also at every chat prep).
- ✅ **Orphaned git worktrees** — proactively (v1), not only lazily on next prep.
- ✅ **Disk & Docker hygiene** — stopped containers, unused images >7 days, build cache;
  only past a disk threshold (`HOUSEKEEPING_DISK_PCT`, default 80%), NEVER volumes (v1), and
  never a container Docker Compose manages: since the idle stop (OpenSpec `sandbox-idle-stop`)
  a stopped Sail stack is an idle project's normal state — its containers stay, and so do the
  images they use, so the next `sail up -d` does not rebuild.
- **Merged / abandoned feature branches** — prune branches whose PR merged or that are long
  dead. Never prune a branch with an open PR. (open)
- **Wedged processes/sessions** — detect zombie or stuck `claude` processes / dead sessions
  and clear them. (open — hard to distinguish deterministically from the intended
  persistent processes; needs a session-registry cross-check)
- **Sandbox health** — basic liveness check; restart the box if it's wedged. (open)

## Boundaries — what does NOT belong here

- **Memory** → the [nightly tidy](memory.md#the-nightly-tidy). The agent may *observe* operational state and
  note it ("3 stale worktrees"), but housekeeping is what *acts*. Observation vs. action.
- **"PR needs attention / CI failed"** → proactivity (auto-fix / PR subscription). That's
  **event-triggered** (PR webhooks/polling), not scheduled cleanup. Different trigger,
  different doc.

## Shape

- **One nightly pass per project**, started by the bot during the 03:00 hour: housekeeping, then the memory
  tidy in the same awake sandbox. A failed janitor is logged, kept as the last pass's summary, and does not
  stop the tidy.
- **Only a project that worked.** A pass runs when the usage log holds a turn of the project newer than its
  last pass (`passDue` in `src/housekeeping.ts`). No turn since: nothing runs and a stopped sandbox is not
  started. The last pass — time and one-line summary — is kept per project in `state.json`
  (`projectSettings.<slug>.housekeeping`).
- **An asleep sandbox**: where the bot owns the idle stop (ssh-docker) and it is on, the pass
  wakes the container, and its summary starts with `woke ·`; containers never slept before
  the idle stop, so the janitor keeps running as it did, and the idle stop puts the container
  back to sleep. With `SANDBOX_AUTOSTOP_MINUTES=0` nothing would stop it again, so the pass
  skips it (`sandbox asleep — skipped`). So it does on a driver whose provider stops its own
  sandboxes: a stopped sandbox gathers no garbage, and waking the fleet nightly would defeat
  that provider's stop. A missing sandbox is never created.
- **Skip if a turn is in flight** for the project (visible via `queues`) — never reap state
  out from under a live user turn.
- **Deterministic core**, with an optional LLM-assisted step only where judgment is needed
  (e.g. "is this branch truly abandoned?"). Default to no LLM.
- **Per-project** vs **fleet-wide**: most tasks are per-`proj-<slug>`; a thin fleet-wide
  pass (overall disk, orphaned sandboxes) may layer on top later.

## Guardrails

- **Idempotent** — safe to run repeatedly; a missed or double run causes no harm.
- **Never touch active state** — no reaping worktrees/branches tied to an open PR or an
  in-flight turn.
- **Report-before-delete for destructive ops** — start in a dry-run/log mode (what *would*
  be pruned) before enabling deletion, especially for disk/Docker pruning.
- **Bounded** — disk pruning triggers on thresholds, not blindly; log what was removed.

## Open decisions

- **Silent vs. digest** — log-only, or post a periodic housekeeping summary to the channel?
- **Cadence** — same nightly hour as the memory tidy, or its own (e.g. more frequent, lighter)?
- **Fleet-wide pass** — needed now, or per-project is enough for v1?

## Related

- [Project memory](memory.md) and its [nightly tidy](memory.md#the-nightly-tidy) — the cognitive counterpart.
- Scheduler / routines: `src/schedule.ts`. Existing reaping: `reapWorktrees` in `src/project.ts`.
