## Why

Housekeeping — the deterministic janitor of a project's sandbox (stale worktrees, the docker prune on a
docker-in-docker project, the Claude Code CLI pin) — runs only for a project where somebody once typed
`/aven housekeeping on`. On the production installation that is no project at all (2026-11-25): the feature
exists and cleans nothing. The dream had the same switch and the same fate, and was replaced on 2026-11-25 by a
nightly memory tidy the host starts by itself (OpenSpec `company-brain`, design D9).

The maintainer's decision of the same day: one road here too. A project should not need a command to be kept
clean, and the two nightly jobs should be one pass.

Consumer: every installation's operator, who today learns about a full sandbox disk or a stale CLI from a
failing turn.

## What Changes

- **Housekeeping is part of every project.** No routine, no `on`/`off`. During the night hour the host runs
  the janitor for each project that had a turn since its last pass, then the memory tidy of the same night.
- **A quiet project costs nothing.** No turn since the last pass: no pass, and a stopped sandbox is not woken —
  it gathered nothing new. A project that worked is cleaned once that night; where the bot owns the idle stop
  its stopped sandbox is woken for the pass, as the housekeeping routine already did.
- **One nightly pass per project**: housekeeping first, the tidy after it in the same awake sandbox.
- **BREAKING** `/aven housekeeping on` and `off` are removed, with the `housekeeping` routine kind; a stored
  housekeeping routine is dropped at boot. Bare `/aven housekeeping` shows the last pass; `now` runs one.

## Capabilities

### New Capabilities

- `sandbox-housekeeping`: when the nightly janitor runs for a project, what it leaves behind, and the two
  command forms that remain.

### Modified Capabilities

None. `sandbox-idle-stop` already says what a pass does with a stopped container and stays as it is: this
change decides whether a project has a pass tonight.

## Impact

- **Rollout**: ungated, on the maintainer's word (2026-11-25) — a behaviour change that reaches each
  installation when it is shipped, named in the PR and the release summary: every project that had a turn that
  day gets a nightly pass (worktree reap, the CLI pin, and on a docker-in-docker project the dockerd guard and
  the threshold-gated prune), and its stopped sandbox is started for it for a few minutes.
- **Code**: `src/pollers.ts` (one nightly pass in place of `fireHousekeeping` and the tidy's own tick), a small
  pure rule beside `src/housekeeping.ts`, `src/state.ts` (the last pass on the project record; the routine kind
  goes), `src/chat/core/commands.ts` and the three Home lists, the routine views, `docs/housekeeping.md`,
  `docs/commands.md`, `docs/rollout.md`.
- **Out of scope**: what the janitor does (the script is unchanged); cleaning right before the idle stop instead
  of at night; branch pruning, wedged-process detection and a fleet-wide pass (`docs/housekeeping.md`, open).
