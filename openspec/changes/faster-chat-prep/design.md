# Design

## D1. Four at a time, not all at once

Each sandbox command over ssh-docker is its own SSH connection (no multiplexing in `src/sshdocker.ts`). sshd's
`MaxStartups` default (`10:30:100`) starts dropping connections in their handshake past ten, and the same host
serves the pollers and the other projects' turns. Four keeps a 15-repo project at roughly a quarter of today's time
and far from that limit. A constant, not a setting: nobody has asked to tune it.

Rejected: one shell script that fetches every repo with `&` and `wait`. One round trip instead of 15 × 3, but it
would duplicate in shell what `cloneRepo` does per repo (URL healing, the retry on a not-yet-propagated token in
`gitretry.ts`, the clone-or-fetch choice and its logs).

## D2. All steps settle before the error

`eachLimit` waits for every step before it rethrows. A preparation that fails while three fetches still run would
otherwise let them write into the sandbox after the caller moved on (and released the sandbox lock). The error is
the first in list order, not in time, so the message for the same failure does not depend on network timing.

## D3. Which files say "active"

`git worktree add` writes the worktree's admin dir (`.git/worktrees/<name>/`): `HEAD`, `index`, `logs/HEAD`. A
checkout rewrites `HEAD`; a checkout or a commit appends to `logs/HEAD` and rewrites `index`; `git status` and
`git diff` rewrite `index` when its cached file stats are stale. The newest of these and the HEAD commit's date is the worktree's last git activity. An agent
that only reads files in a worktree for longer than `WORKTREE_REAP_HOURS` without any git command can still lose
it; that was already true and is out of scope.

The reaper's own `git status` runs with `--no-optional-locks`, which stops it from refreshing the index, so checking
a worktree never makes it look active. The idle test now runs before `status`, so an active worktree costs one
`stat` instead of a full status.

Rejected: the mtime of the worktree directory. It changes only when a top-level entry is added or removed.
