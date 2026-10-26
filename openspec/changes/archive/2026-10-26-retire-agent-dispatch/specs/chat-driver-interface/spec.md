## MODIFIED Requirements

### Requirement: Slack installations unchanged
Moving Slack behind the chat driver interface SHALL NOT change any message, block, modal, reaction, ephemeral reply, Home tab, permission check or timing a Slack user observes.

#### Scenario: Recorded Slack calls
- **WHEN** the scripted Slack scenarios run against the refactored code: turn lifecycle, every action and modal, Home, mentions, DMs, files, every `/aven` verb, pollers, routines, alerts, restart recovery
- **THEN** the outgoing Slack calls are identical to the snapshots recorded before the refactor

#### Scenario: Golden texts
- **WHEN** the existing tests for blocks, prompts and formatting run
- **THEN** they pass without re-snapshotting
