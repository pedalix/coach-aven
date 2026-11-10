# Design

## Context

`GIT_NAME` / `GIT_EMAIL` / `ATTRIBUTION_SETTINGS` are module constants read synchronously by `seedGitHubAuth`
(`git config --global`), `claudeLaunch` (the `GIT_*` environment, `--settings`) and the PR pollers. Every one of those
runs after a `getGitHubToken` call in the same flow: `ensureSession` seeds with a fresh token before it starts a
session, and the pollers list pull requests (which resolves a token) before they compare logins.

## Decisions

- **D1 — ask GitHub, do not configure.** The credential already determines the account; a setting an operator must
  look up (a numeric user id) is a setting that gets forgotten, which is how the first installation with its own App
  got the shared bot's name. The `.env` pair stays as the manual override and the way out when the lookup cannot
  work. Rejected: required settings; a default of "whatever it is today" with an optional override.
- **D2 — resolve inside `getGitHubToken`.** It is the one chokepoint before every use, it already reports credential
  failures, and it is async. Once per process, single-flight; a failure is not cached. Rejected: at container start
  (the identity is the installation's, not a sandbox's, and the session environment needs it too); at boot (a GitHub
  outage would stop the bot from starting, and the App's installation token needs a repository).
- **D3 — live bindings, not plumbing.** The three exports become `let`, moved together by `setGitIdentity`. ES module
  imports are live, so the synchronous call sites stay as they are and read the resolved value at use. Rejected:
  threading an identity argument through `claudeLaunch`, `seedGitHubAuth` and the pollers — eight signatures for one
  process-wide value.
- **D4 — an App's bot user is read with the installation token** (`GET /users/<slug>[bot]` is public, but the
  anonymous rate limit is 60/h per address); the slug with the App's JWT (`GET /app`).
- **D5 — what GitHub returns is checked** (login pattern, numeric id) before it is used: both values are interpolated
  into sandbox shell commands.
- **D6 — no fallback on failure.** A turn that commits as the wrong account leaves history that cannot be fixed
  without a rewrite; a failed turn can be repeated.

## Risks

- A personal-token installation changes author (the proposal's rollout note). The override restores the old one.
- A running session keeps its environment; after a restart with a changed identity its next process gets the new one.
