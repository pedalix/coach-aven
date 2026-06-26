# Housekeeping

Scheduled **mechanical** hygiene of a project's sandbox — reaping stale git state, keeping
the DinD disk from filling, clearing wedged processes. The janitor, as opposed to
[Dreaming](memory.md#dreaming) (the agent's memory consolidation).

> **Status: design stub.** Captures the boundary and candidate tasks; not yet built.
> Some of it already exists (`reapWorktrees`); this consolidates it and adds the rest.

## Decision (TL;DR)

- **Separate from Dreaming.** Different nature, cost, and risk — see below.
- **Mostly deterministic, no LLM.** Housekeeping is shell/API on a schedule
  (`git worktree prune`, `docker image prune`, disk checks). Reserve the LLM only for the
  rare task that genuinely needs judgment.
- **Shares the scheduler, not a new one.** A `housekeeping` [routine kind](#shape) on the
  existing routines mechanism (`src/schedule.ts`), alongside scheduled reports and dreaming.
- **Safe by construction:** idempotent, never touches active state, report-before-delete
  for anything destructive.

## Why separate from Dreaming

| | Dreaming | Housekeeping |
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
  idle, lazily on session prep. Housekeeping makes this proactive and consolidates it with
  the rest below.

## Candidate tasks (inside `proj-<slug>`)

- **Orphaned git worktrees** — proactively, not only lazily on next prep.
- **Merged / abandoned feature branches** — prune branches whose PR merged or that are long
  dead. Never prune a branch with an open PR.
- **Disk & Docker hygiene** — the DinD sandbox is heavy: dangling containers/images from
  Sail stacks, build caches, stray `node_modules`. Prune below a disk threshold.
- **Wedged processes/sessions** — detect zombie or stuck `claude` processes / dead sessions
  and clear them.
- **Sandbox health** — basic liveness check; restart the box if it's wedged.

## Boundaries — what does NOT belong here

- **Memory** → [Dreaming](memory.md#dreaming). Dreaming may *observe* operational state and
  note it ("3 stale worktrees"), but housekeeping is what *acts*. Observation vs. action.
- **"PR needs attention / CI failed"** → proactivity (auto-fix / PR subscription). That's
  **event-triggered** (PR webhooks/polling), not scheduled cleanup. Different trigger,
  different doc.

## Shape

- A **`housekeeping` routine kind** on `src/schedule.ts`, gated like the others (skip
  projects with no recent activity; run at low-traffic hours; let the sandbox auto-stop
  again afterward).
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
- **Cadence** — same nightly window as dreaming, or its own (e.g. more frequent, lighter)?
- **Fleet-wide pass** — needed now, or per-project is enough for v1?

## Related

- [Project memory](memory.md) and [Dreaming](memory.md#dreaming) — the cognitive counterpart.
- Scheduler / routines: `src/schedule.ts`. Existing reaping: `reapWorktrees` in `src/project.ts`.
