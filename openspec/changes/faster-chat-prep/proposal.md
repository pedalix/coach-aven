# Proposal

## Why

Before a new conversation the bot prepares the project's sandbox: it fetches every repo, then reaps old worktrees.
Both run one repo after another, a few SSH round trips each. A project with 15 repos waited ~32 s for the fetches
alone, on every new conversation (measured on an installation's first Bitbucket project: 2 s per repo).

The same preparation removed nine worktrees an agent had made an hour earlier. The reaper measures a worktree's
idle time from the date of its HEAD commit, so a worktree checked out today on last week's commit counts as a week
idle. Those nine were clean and their results were saved elsewhere, but the rule can remove a worktree from under an
agent still working in it in another conversation.

## What Changes

- Preparing a conversation fetches (or clones) the project's repos four at a time instead of one at a time. Every
  repo is still fetched; a failure still fails the preparation, after the others have finished. The worktree reap at
  the end runs four at a time too.
- A worktree's idle time counts from its own last git activity: the newest of its HEAD commit and the files git
  writes for that worktree (made, checked out, committed, index refreshed). The reaper's own check writes none of
  them.
- A worktree whose `git status` cannot be read is kept (today it counted as clean).

Out of scope: skipping the fetch on a warm sandbox, a configurable concurrency, the nightly housekeeping reap
(it stays sequential, nobody waits on it), and the idle stop of the sandbox itself.

## Capabilities

### New Capabilities

- `chat-preparation`: how a project's sandbox gets its repos ready before a conversation, and which worktrees it
  removes.

### Modified Capabilities

None.

## Impact

- **Code:** a new pure module `src/pool.ts` (`eachLimit`: run a step over a list, at most N at once, rethrow the
  first failure in list order after all settle); `src/tasks.ts` `prepareChat` uses it for the fetch and the reap;
  `src/project.ts` `reapWorktrees` measures idle time from the worktree's admin files.
- **Docs:** `docs/configuration.md` (`WORKTREE_REAP_HOURS`), `docs/housekeeping.md`.
- **Rollout:** the reap rule is bucket 1 (a bug fix: it removed worktrees in use). The concurrent fetch is bucket 2
  (default-preserving): the same commands on the same repos with the same outcome, only the order of the fetches
  changes; `src/pool.test.ts` shows that a limit of 1 is today's sequential order. No flag, no ledger row.
