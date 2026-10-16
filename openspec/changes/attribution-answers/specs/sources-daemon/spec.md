# Spec Delta

## ADDED Requirements

### Requirement: The tenant checkout keeps the platform's commits
The process that ingests a project (the daemon, or the bot's poller when there is no daemon) SHALL keep the tenant checkout a shallow clone it fetches before every build. With `SOURCES_TENANT_WRITE=1` it SHALL rebase the checkout's local commits onto the fetched head and push them, resolving a conflict in an append-only ledger file mechanically — the remote's lines, then the local commits' lines — and, on any other failure, leaving the checkout at the remote with the dropped lines logged; without the flag it SHALL fetch and hard-reset exactly as before and never push. A push SHALL use a credential minted for that push, scoped to the tenant repo, passed as a one-shot header and never stored.

#### Scenario: An unpushed answer meets a remote change
- **WHEN** the checkout holds an answer commit whose push failed and the remote gained a commit meanwhile
- **THEN** the next pull rebases the answer onto the remote, pushes it, and the build reads both

#### Scenario: Both sides appended to one ledger
- **WHEN** the remote's `fragments.jsonl` gained lines while the checkout's unpushed commit appended others
- **THEN** the rebased file holds the remote's lines followed by the local ones, and nothing is asked of anyone

#### Scenario: Flag absent
- **WHEN** the ingest process runs without `SOURCES_TENANT_WRITE`
- **THEN** the fetch issues today's commands (`fetch --depth 1`, `reset --hard FETCH_HEAD`) and nothing is ever pushed
