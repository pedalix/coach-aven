<!-- A small fix (docs, a typo, a bug with a test) needs only the first two sections. -->

## What and why

<!-- One or two sentences. Link the issue or the OpenSpec change (`openspec/changes/<name>/`) if there is one. -->

## Tests

<!-- `npm run typecheck` and `npm test` pass. Which test covers the change? -->

## Rollout

<!-- Prod must not change as a side effect of a merge (docs/rollout.md). Pick one:
     - none: docs, CI or tests only;
     - bucket 1: a bug fix;
     - bucket 2: default-preserving, and the test that proves today's behaviour is …;
     - bucket 3: behind a flag that is off by default, with its ledger row in docs/rollout.md. -->

## Checklist

- [ ] Fictional names only in code, tests, docs and this text (`scripts/public-guard.sh` runs in CI)
- [ ] A changed Slack command, button or interaction is reflected in the App Home tab
- [ ] The PR has a label (`feature`, `fix`, `ci`, `docs`, `chore`) for the release notes
