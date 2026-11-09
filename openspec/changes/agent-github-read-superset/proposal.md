# Proposal

## Why

An agent working on a project keeps hitting 403s on questions it should be able to answer itself: which deployment a
fix is on (`deployments`), whether an environment waits for a reviewer or allows only `main` (`environments`), how
the default branch is protected (`administration`), which dependencies have open Dependabot alerts (the weekly
security check works them out from lockfiles instead). It also cannot start, re-run or cancel a workflow run — a
deploy — even when an operator would allow it for an hour. Each of these needs a GitHub App permission, and widening
the App means every installation re-approves; one round of approvals for a deliberate superset is cheaper than one per
capability (the July `checks` lesson).

## What Changes

- The sandbox token's standing permissions grow by read-only access to **deployments, environments, administration,
  Dependabot alerts and code scanning alerts**. Nothing among them can change a repository; none returns a secret value.
- Two read permissions stay out on purpose and are named in the code: **secret scanning alerts** (an alert carries the
  detected secret in clear) and **webhooks** (hook URLs often embed tokens).
- A new grant capability **`actions`**: `/aven grant actions [duration]` lets a project's sandbox token carry
  `actions: write` for a while — dispatch, re-run and cancel workflow runs, e.g. a deploy. It is separate from
  `workflows`, which changes workflow files.
- The system prompt's grant hint covers a refused Actions write (dispatch, re-run, cancel) the same way it covers a
  refused workflow-file push.
- The Home tabs (Slack, Teams, web) name both capabilities; docs list the App's permission superset.

Out of scope:

- Changing the App's permissions or approving them on installations — done by hand in GitHub (no API exists).
- Environment protection: required reviewers need GitHub Enterprise for private repositories; a repository that
  deploys through a workflow should restrict its `production` environment to `main` (available on Team) — the
  operator's step, per repository.
- Bot-side reads (pollers): their tokens keep their own, narrower permissions.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `project-grants`: the standing token permissions grow; a second capability, `actions`, widens the token with
  `actions: write`; the grant-effect reply and the prompt hint cover any capability, not only `workflows`.

## Impact

- **Code:** `src/github.ts` (`AGENT_PERMISSIONS`), `src/grants.ts` (`CAPABILITIES.actions`), `src/prompt.ts` (the
  hint), `src/chat/slack/blocks.ts`, `src/chat/teams/teamshome.ts`, `src/chat/web/webhome.ts`; tests beside each;
  the prompt golden fixtures and the Slack Home snapshot re-recorded on purpose.
- **Rollout: bucket 1 for the reads, the grant gated by nature.** The reads are an ungated, read-only widening (as
  `agent-actions-read`); an installation that has not approved them yet mints exactly as today, because the mint
  intersects desired with granted permissions — so the code can ship before the approvals. `actions: write` reaches a
  token only while an operator's grant is active. The prompt text changes for App-auth installations (re-snapshot).
- **Operators:** one round of approvals on every installation (Actions read → read and write; new: Administration,
  Dependabot alerts, Code scanning alerts, Environments — all read). Client organisations approve on their side.
