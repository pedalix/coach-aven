# Tasks

## 1. Identity

- [x] 1.1 `src/gitidentity.ts`: `identityOf`, `checkedIdentity`, `gitIdentityOverride`, the default, live `GIT_NAME` / `GIT_EMAIL` / `ATTRIBUTION_SETTINGS` and `setGitIdentity`. Verify: `src/gitidentity.test.ts`.
- [x] 1.2 `src/config.ts`: `gitIdentity` from the `.env` pair, checked at boot. Verify: `src/gitidentity.test.ts` (half a pair, bad values).
- [x] 1.3 `src/github.ts`: `lookupGitIdentity` (token, App, none, override) and `ensureGitIdentity` inside `getGitHubToken`. Verify: `src/github.test.ts` with a fake GitHub.
- [x] 1.4 `src/pollers.ts`: the bot's login is the identity's. Verify: typecheck; the pollers' tests.
- [x] 1.5 By hand, against GitHub: the shared App resolves to today's constants; an installation's own App to its own bot user; a personal token to its owner.

## 2. Prompt, docs, ledger

- [x] 2.1 `src/prompt.ts` and the goldens: "the bot's own GitHub account".
- [x] 2.2 `docs/configuration.md`, `docs/pr-review.md`, `.env.example`.
- [x] 2.3 `docs/rollout.md`: the ledger row.
- [x] 2.4 One PR (#197); typecheck, tests, guard.

## 3. After the merge

- [ ] 3.1 In a sandbox of an installation with its own App, after its release: `git config --global user.name` prints `<app-slug>[bot]`, and a commit on GitHub links to that account.
- [ ] 3.2 Archive this change into `openspec/specs/bot-git-identity/`.
