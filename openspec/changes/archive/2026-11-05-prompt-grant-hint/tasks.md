# Tasks

## 1. The prompt

- [x] 1.1 `src/prompt.ts`: a `githubApp` input; when set, one paragraph after the flow (the refusal is deliberate, the
  grant command on Slack and on Teams/web, push again after it, never ask to change the App). `src/tasks.ts` passes
  `githubApp` when `cfg.github.kind === 'app'`. Verify: the golden `single-repo-github-app.txt` is the single-repo
  golden plus that paragraph; every existing golden unchanged; `npm run typecheck` and `npm test`.

## 2. Verification

- [x] 2.1 After `ship` to an App-mode installation, in a project without a grant ask the agent to push a change to
  `.github/workflows/`: its reply names `/aven grant workflows` and does not ask to change the App. Record the date in
  the ledger row. Done 2026-11-05 on prod (v0.53.0): the reply named the grant command.

## Workflow follow-up

- After merge and the live check: `/openspec-archive-change prompt-grant-hint`.
