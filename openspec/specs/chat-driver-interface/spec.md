# chat-driver-interface Specification

## Purpose
Separates what the bot does from the chat platform it does it on, so an installation can serve people through one chat driver of its choice while Slack installations keep behaving exactly as before.

## Requirements

### Requirement: Slack installations unchanged
Moving Slack behind the chat driver interface SHALL NOT change any message, block, modal, reaction, ephemeral reply, Home tab, permission check or timing a Slack user observes.

#### Scenario: Recorded Slack calls
- **WHEN** the scripted Slack scenarios run against the refactored code: turn lifecycle, every action and modal, Home, mentions, DMs, files, every `/aven` verb, pollers, routines, alerts, restart recovery
- **THEN** the outgoing Slack calls are identical to the snapshots recorded before the refactor

#### Scenario: Golden texts
- **WHEN** the existing tests for blocks, prompts and formatting run
- **THEN** they pass without re-snapshotting

### Requirement: One chat driver per installation
An installation SHALL run exactly one chat driver for people, chosen by its run mode, and SHALL NOT open connections or listeners of any other chat driver. The shadow driver of `agent-messaging` serves no people and opens no connection or listener. It MAY run beside the chat driver for conversations with an `a2a:` key, after the tenant prefix.

#### Scenario: Slack mode
- **WHEN** an installation starts with `orch slack`
- **THEN** it connects to Slack exactly as before and opens no other chat listener

#### Scenario: Unknown driver
- **WHEN** an installation is started with a run mode for a driver that does not exist
- **THEN** it exits with an error listing the available drivers

#### Scenario: Shadow conversations beside Slack
- **WHEN** a Slack installation answers a task from another agent
- **THEN** the turn renders through the shadow driver, and the installation still has exactly one chat connection

### Requirement: A driver states whether it delivers files
A chat driver SHALL declare in its capabilities whether it can post files into a conversation, and the core SHALL
offer the agent an outbox only on a surface that declares it can.

#### Scenario: Slack and web deliver, Teams does not
- **WHEN** the core asks each driver's capabilities
- **THEN** the Slack and web drivers report file delivery and the Teams driver reports none

### Requirement: A driver posts files into a conversation
A chat driver that declares file delivery SHALL post a set of named files into a conversation and thread the core
names, with each file's bytes and media type, and SHALL throw on a platform failure so the core can name the file.

#### Scenario: Several files in one post
- **WHEN** the core posts two files into a thread
- **THEN** both appear in that thread, in the order given, with their names

#### Scenario: The platform refuses
- **WHEN** the platform answers the upload with an error
- **THEN** the driver throws, and the core posts the notice (the driver posts nothing itself)

### Requirement: Driver capabilities are published in one table
The documentation SHALL carry one table of every chat driver's declared capabilities, rendered from the drivers'
own declarations, and a test SHALL fail when the table and the declarations differ.

#### Scenario: A capability is added
- **WHEN** a driver's capabilities gain a field or a driver changes a value
- **THEN** the test fails until the table in the documentation shows the new state

#### Scenario: Reading what a surface implements
- **WHEN** an operator asks whether a surface delivers outbound files
- **THEN** the table answers for Slack, Teams, the web and the shadow driver without reading code
