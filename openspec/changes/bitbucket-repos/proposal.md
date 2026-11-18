# Proposal

## Why

A project can only list GitHub repositories. A client whose code lives on Bitbucket Cloud cannot have an agent that
reads it, even for questions that need no write access at all: what a table means, which service owns a column, why
a migration exists. Moving the client's repositories to GitHub first is their decision and their timeline. Reading
them where they are needs a host in the repo entry, a credential that reaches git for that host only, and a GitHub
token that no longer assumes every repo is on GitHub.

## What Changes

- A repo entry may name a Bitbucket Cloud repository: `bitbucket.org/<workspace>/<repo>`. A bare `<owner>/<repo>` is
  GitHub, as today. Any other host fails the config load.
- One credential per installation, `BITBUCKET_TOKEN` (a Bitbucket API token or workspace access token with read
  scope). A project with a Bitbucket repo and no token fails the config load.
- The sandbox clones and fetches a Bitbucket repo over HTTPS with that token, through a git credential helper scoped
  to `bitbucket.org`. The GitHub token is never offered to Bitbucket, nor the Bitbucket token to GitHub.
- Bitbucket repos are **read-only** for the agent: the system prompt says so (no push, no pull request; a proposed
  change goes into the reply as a diff), and the PR pollers and PR commands skip them. The token's own scope is the
  boundary; the prompt is the guidance.
- The GitHub token of a turn covers the project's GitHub repos only. A project with no GitHub repo mints no GitHub
  token (the sandbox gets the `GITHUB_AUTH=none` treatment, for that project only).
- A checkout is named after the repo's last path segment; two repos of one project with the same name fail the
  config load (they would share a directory).

Out of scope: pull requests, pipelines or reviews on Bitbucket; pushing; Bitbucket Data Center/Server, GitLab or any
other host; SSH remotes; composer credentials for packages hosted on Bitbucket (a private Composer registry needs its
own token, a separate concern).

## Capabilities

### New Capabilities

- `bitbucket-repos`: a project lists Bitbucket Cloud repositories beside GitHub ones; the agent reads them, never
  writes.

### Modified Capabilities

None.

## Impact

- **Code:** a new pure module `src/repohost.ts` (parse an entry: host, owner, name, clone URL; split a list by host)
  with its test; `src/projects.ts` (entry and duplicate validation), `src/config.ts` (`BITBUCKET_TOKEN`),
  `src/project.ts` (`repoName`, `cloneRepo`, a `seedBitbucketAuth` beside `seedGitHubAuth`), `src/tasks.ts` (mint
  over GitHub repos only; seed the Bitbucket credential), `src/prompt.ts` (the read-only paragraph and the repo
  list), `src/pollers.ts` and `src/chat/core/commands.ts` (PR work over GitHub repos only).
- **Rollout: default-preserving.** A project without a `bitbucket.org/` entry is seeded, prompted and polled exactly as
  today: the prompt golden fixtures stay byte-identical, the credential helper and the mint request are unchanged
  (tests pin both). The new behaviour is opt-in by config, so no flag and no ledger row.
- **Operators:** an installation that wants it creates a Bitbucket token with `read:repository:bitbucket` (or a
  workspace access token with repository read) and puts it in `.env`; restart (env is read at boot).
