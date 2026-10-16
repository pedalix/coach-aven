# Spec Delta

## ADDED Requirements

### Requirement: The tenant checkout keeps the platform's commits
The process that ingests a project (the daemon, or the bot's poller when the bot ingests) SHALL keep the tenant checkout a shallow clone it fetches before every build. With `SOURCES_TENANT_WRITE=1` it SHALL rebase the checkout's local commits onto the fetched head and push them to one branch — `refs/heads/<sources.tenant.ref>` when the key is set, else the remote's default branch as `git ls-remote --symref origin HEAD` names it — resolved once per pass right after the fetch and never a ref named `HEAD`; it SHALL resolve a conflict in an append-only ledger file mechanically — the remote's lines, then the local commits' lines — and, on any other failure, leave the checkout at the remote with the dropped lines logged. When no branch can be resolved (a detached or unborn remote HEAD, a `ref` the remote has no branch for, a failed `ls-remote`) the pass SHALL log it, push nothing, keep any local commit for a later pass and leave the checkout read-only for the writer until a pass resolves one. Without the flag it SHALL fetch and hard-reset exactly as before and never push. A push SHALL use a credential minted for that push, scoped to the tenant repo, passed as a one-shot header and never stored.

#### Scenario: An unpushed answer meets a remote change
- **WHEN** the checkout holds an answer commit whose push failed and the remote gained a commit meanwhile
- **THEN** the next pull rebases the answer onto the remote, pushes it, and the build reads both

#### Scenario: No `ref`, no stray branch
- **WHEN** a tenant has no `sources.tenant.ref` and the checkout holds an answer commit
- **THEN** the push lands on the branch the remote's HEAD names, the remote gains no ref named `HEAD`, and a clone of its default branch sees the lines

#### Scenario: The branch cannot be resolved
- **WHEN** the remote's HEAD is detached, or `ref` names a tag
- **THEN** the pass logs it, pushes nothing, keeps the local commit for a later pass, and `answer` is refused until a pass resolves a branch

#### Scenario: Both sides appended to one ledger
- **WHEN** the remote's `fragments.jsonl` gained lines while the checkout's unpushed commit appended others
- **THEN** the rebased file holds the remote's lines followed by the local ones, and nothing is asked of anyone

#### Scenario: Flag absent
- **WHEN** the ingest process runs without `SOURCES_TENANT_WRITE`
- **THEN** the fetch issues today's commands (`fetch --depth 1`, `reset --hard FETCH_HEAD`) and nothing is ever pushed
