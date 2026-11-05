# Tasks

## 1. The token

- [x] 1.1 `src/github.ts`: `actions: 'read'` in `AGENT_PERMISSIONS`. Verify: `src/github.test.ts` — the request
  without a grant is exactly contents write, pull requests write, checks read, actions read, metadata read; an
  installation granting Actions write still yields read; one without `actions` drops it and the request otherwise
  stands; `npm run typecheck` and `npm test`.

## 2. Docs

- [x] 2.1 `docs/security.md`: the sandbox's GitHub scope names `actions: read`. `docs/rollout.md`: ledger row
  (ungated; watch: `gh run view --log-failed` works in a sandbox; no mint warning on the App installations).

## 3. Verification

- [x] 3.1 After `ship` to an installation in App mode: in a project's thread, ask the agent for the log of a failed
  run of one of its repositories (`gh run view <id> --log-failed`) — it reads it; a push of a workflow file is still
  refused without a grant. Record the date in the ledger row. Done 2026-11-05 on prod (v0.53.0): the agent read a
  failed deploy run's log by itself.

## Workflow follow-up

- After merge and the live check: `/openspec-archive-change agent-actions-read` (after `project-grants` is archived,
  since this modifies its requirement).
