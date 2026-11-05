# Proposal

## Why

The agent's sandbox token carries `checks: read`, so the agent sees THAT a pull request's CI failed but not WHY: the
run list and the job logs (`gh run list`, `gh run view --log-failed`) need the GitHub App permission `actions: read`,
which the token does not request. Fixing a red build is the agent's most common loop after opening a pull request; today
it needs a person to paste the log.

## What Changes

- The sandbox token (and the bot's own mints, which share the set) also requests `actions: read`: workflow runs, job
  logs, artifacts and caches of the project's repositories. Read-only — Actions secrets and variables are separate
  permissions this does not touch; pushing a workflow file stays behind `/aven grant workflows`.
- The App installations already in use grant `actions: read`, so no owner approval is needed there. An installation
  that has not approved it mints without it (the existing intersection), with the usual one-time warning.
- No prompt text, tool or command changes: the agent's `gh` calls that were refused now succeed.

## Capabilities

### New Capabilities

### Modified Capabilities
- `project-grants`: the standing permission set a project without a grant is minted now includes actions read.

## Impact

- `src/github.ts` (`AGENT_PERMISSIONS`), `src/github.test.ts`, `docs/security.md` (the token's scope), `docs/rollout.md`
  (ledger row).
- Rollout: ungated — a read-only widening that completes the existing CI-reading capability; it reaches each
  installation in `ship`'s stage order. Rollback: the previous version (a widened token expires within the hour).
- Accepted risk: job logs and artifacts can hold what a build printed or packed (GitHub masks only registered secrets).
  It adds no new way out of the sandbox — the agent already writes code and has unrestricted egress.
