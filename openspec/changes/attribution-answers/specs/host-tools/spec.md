# Spec Delta

## MODIFIED Requirements

### Requirement: Sources over the same channel
For a project with a `sources` block the bot SHALL serve the sources tool table (search, get, transcript, tasks, meetings, calendar, activity, fragments, people, stats, unanswered, stuck) over the control channel from the replica on its own disk, off the bot's main thread, with inputs, outputs and scrub markers identical to the stdio server's. Parity holds for every tool except `ask` and `answer` (`attribution-learning`): the channel SHALL serve them only when the bot itself ingests the project or forwards to the daemon that does, and SHALL otherwise answer `not served on this face`.

#### Scenario: Parity
- **WHEN** the same `search` call is made through the control channel and against the stdio server over the same replica
- **THEN** the results are identical

#### Scenario: A writer tool on a channel without a writer
- **WHEN** the bot serves a project from a replica a same-host daemon writes (`SOURCES_DAEMON=1`, no `sources.daemon`) and the agent calls `answer`
- **THEN** the answer is `not served on this face` naming `sources.daemon`, and every other tool answers as before
