## Purpose

Separates what the bot does from the chat platform it does it on, so an installation can serve people through one chat driver of its choice while Slack installations keep behaving exactly as before.

## ADDED Requirements

### Requirement: Slack installations unchanged
Moving Slack behind the chat driver interface SHALL NOT change any message, block, modal, reaction, ephemeral reply, Home tab, permission check or timing a Slack user observes.

#### Scenario: Recorded Slack calls
- **WHEN** the scripted Slack scenarios (turn lifecycle, every action and modal, Home, mentions, DMs, files, every `/aven` verb, pollers, routines, dispatch, alerts, restart recovery) run against the refactored code
- **THEN** the outgoing Slack calls are identical to the snapshots recorded before the refactor

#### Scenario: Golden texts
- **WHEN** the existing tests for blocks, prompts and formatting run
- **THEN** they pass without re-snapshotting

### Requirement: One chat driver per installation
An installation SHALL run exactly one chat driver, chosen by its run mode, and SHALL NOT open connections or listeners of any other chat driver.

#### Scenario: Slack mode
- **WHEN** an installation starts with `orch slack`
- **THEN** it connects to Slack exactly as before and opens no other chat listener

#### Scenario: Unknown driver
- **WHEN** an installation is started with a run mode for a driver that does not exist
- **THEN** it exits with an error listing the available drivers
