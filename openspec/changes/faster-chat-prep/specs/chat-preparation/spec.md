## ADDED Requirements

### Requirement: Repos are fetched concurrently, with a cap

Preparing a conversation SHALL fetch, or clone when absent, every repo of the project, with at most four repos in
progress at once. When a repo fails, the others SHALL still finish before the preparation fails with the failure of
the first repo in the project's list.

#### Scenario: Fifteen repos

- **WHEN** a conversation of a project with 15 repos is prepared
- **THEN** all 15 repos are fetched, never more than four at the same time

#### Scenario: One repo fails

- **WHEN** the third repo of five cannot be fetched
- **THEN** the other four are still fetched, and the preparation fails with the third repo's error

### Requirement: Worktree idle time counts from the worktree's own activity

The reaper SHALL measure a worktree's idle time from the newest of its HEAD commit and the files git keeps for that
worktree (`HEAD`, `index`, `logs/HEAD`), and SHALL reap only a worktree idle longer than `WORKTREE_REAP_HOURS`.
Its own check of the worktree SHALL NOT update those files.

#### Scenario: A fresh worktree on an old commit

- **WHEN** an agent made a worktree an hour ago on a commit from ten days ago, and leaves it clean
- **THEN** the reaper keeps it

#### Scenario: A worktree nobody touched

- **WHEN** a clean, fully pushed worktree has had no git activity for longer than `WORKTREE_REAP_HOURS`
- **THEN** the reaper removes it

#### Scenario: The check is not activity

- **WHEN** the reaper checks an idle worktree that has uncommitted work
- **THEN** it keeps the worktree and its `index` file keeps its modification time

### Requirement: An unreadable worktree is kept

The reaper SHALL keep a worktree whose `git status` fails.

#### Scenario: Status fails

- **WHEN** `git status` exits with an error in an idle worktree
- **THEN** the reaper keeps it, as it is not known to be clean
