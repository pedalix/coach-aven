# sources-daemon Specification

## Purpose
Ingest and serve as one process where the data lives; the bot is its only client.

## Requirements

### Requirement: One process ingests and serves
`orch sources daemon` SHALL run the pull → build → replica ticker and the HTTP tool face for every project it is configured for, in one process, with the ticker semantics of the bot's poller (cadence, backoff, re-auth parking, daily credential check).

#### Scenario: Daemon pulls on cadence
- **WHEN** the daemon runs for a project with `intervalMinutes: 15`
- **THEN** a pass runs every 15 minutes, the replica is swapped atomically and `stats.meta` reports the pull

### Requirement: Single writer
When `SOURCES_DAEMON=1` the bot SHALL NOT run its own ticker, and the daemon SHALL hold a lock per project so that a second writer refuses to start.

#### Scenario: Two writers
- **WHEN** a second daemon starts for a locked project
- **THEN** it exits with the holder's pid in its message and nothing is pulled twice

### Requirement: The bot forwards and reads status
With `sources.daemon` set for a project, the bot SHALL forward the project's `sources` JSON-RPC to the daemon's `/mcp/<slug>` with the configured bearer and return the response verbatim, and SHALL take sync state, raw record count and tenant due-now from the daemon's `/status/<slug>` instead of local files.

#### Scenario: Forwarded call
- **WHEN** the agent calls `search` in a project configured with a daemon
- **THEN** the result is the daemon's answer, byte-identical to a direct call against the daemon

#### Scenario: Daemon unreachable
- **WHEN** the daemon does not answer within the timeout
- **THEN** the agent receives a JSON-RPC error that names the daemon, routines fire rather than skip and `/aven status` shows the daemon as unreachable since the last good read

### Requirement: Scoped and authenticated
Every daemon request SHALL carry the daemon's bearer and name its project in the path; an unknown project or a wrong bearer is refused without details.

#### Scenario: Wrong project
- **WHEN** a request names a slug the daemon is not configured for
- **THEN** the daemon answers 404 with no body details
