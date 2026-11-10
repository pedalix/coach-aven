# Proposal

## Why

Every sandbox commit is authored by one fixed account, the shared GitHub App's bot user: its login and numeric id are
constants in `src/gitidentity.ts`, and the auto-review's "my own pull request" check uses the same constant
(`src/pollers.ts`). An installation with its own GitHub App, or with a personal token (`GITHUB_TOKEN`), pushes as a
different account than the one its commits name: the commits link to a bot that has no access there, and the
auto-review does not recognise the pull requests the bot opened as its own.

## What Changes

- The bot asks GitHub who its credential is, once per process, when it first resolves a GitHub token — before any
  sandbox is seeded or any session starts: a GitHub App → its bot user (`GET /app` → slug, `GET /users/<slug>[bot]` →
  id); a personal token → its owner (`GET /user`). `GITHUB_AUTH=none` keeps `coach-aven[bot]` (nothing is pushed).
- That account is the author and committer of every sandbox commit, the e-mail in the `Co-Authored-By: CoachAven`
  trailer, and the login the auto-review and the autofix treat as the bot's own.
- `GITHUB_BOT_LOGIN` + `GITHUB_BOT_USER_ID` in `.env` name the account by hand and skip the lookup (both or neither;
  a malformed value stops the boot).
- A failed lookup fails that token request with an error naming the two settings; the next request asks again. The
  bot does not fall back to a guessed identity.
- The base system prompt says "the bot's own GitHub account" where it named `coach-aven[bot]` (one clause, every
  session).

Rollout: default-preserving for an installation on the shared App (the lookup returns today's constants — checked
against GitHub for the shared App); a bug fix for an installation on its own App. **Behaviour change for a
personal-token installation**: its commits were authored by `coach-aven[bot]`, and are now authored by the token's
owner; the auto-review there skips the owner's pull requests (the bot's own, and the owner's hand-made ones — one
account, GitHub cannot tell them apart). No flag: the old value was wrong there, and the `.env` pair restores any
identity.

Out of scope: the memory journal's commit author (`src/memjournal.ts`, a local repository, cosmetic); a second
identity per project; changing a running session (it keeps the environment it started with).

## Capabilities

### New Capabilities

- `bot-git-identity`: which GitHub account the bot's commits, attribution and own-pull-request check name, and where
  that comes from.

### Modified Capabilities

None.

## Impact

`src/gitidentity.ts`, `src/github.ts` (`lookupGitIdentity`, `ensureGitIdentity` inside `getGitHubToken`),
`src/config.ts` (`gitIdentity`), `src/pollers.ts`, `src/prompt.ts` + its goldens, `docs/configuration.md`,
`docs/pr-review.md`, `.env.example`, `docs/rollout.md`. Two more GitHub API reads per process for an App, one for a
token.
