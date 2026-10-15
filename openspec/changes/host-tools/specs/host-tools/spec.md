# Spec Delta

## Purpose
Tools implemented by the bot and served to the agent over the session's own control channel: no mount, no network path, no credential in the sandbox.

## ADDED Requirements

### Requirement: Served over the session's control channel
The bot SHALL register its tool servers with the agent's Claude Code process at session start (`initialize`, `sdkMcpServers`) and SHALL answer every `mcp_message` control request for them — handshake and tool calls — on the same process channel it drives turns through.

#### Scenario: A host tool call needs no transport
- **WHEN** the agent calls a `host` or `sources` tool in a sandbox on any driver
- **THEN** the call reaches the bot over the process channel and the result returns the same way, with no mount, listener or bearer involved

#### Scenario: Nothing is registered without the gate
- **WHEN** `HOST_TOOLS` is unset and the project has no `sources` block
- **THEN** the session registers no in-process server and the sandbox's MCP list is byte-identical to today's

### Requirement: The caller is the session
The bot SHALL attribute every host tool call to the project and conversation of the session the call arrived on, and SHALL ignore any project or thread named in the call's input.

#### Scenario: Spoofed target
- **WHEN** a `propose` input names another project as the proposer
- **THEN** the proposal is recorded for the session's project and rendered in the session's thread

### Requirement: Deterministic, read or gated
Host tools SHALL run deterministic code in the bot: they read bot state (`registry`, `routine`) or submit a record whose effect waits for a button (`propose`). No host tool SHALL execute a side effect on its own.

#### Scenario: Propose returns the gate
- **WHEN** the agent calls `propose` with a valid record
- **THEN** the reply carries the proposal id and whether it waits for Send or is auto-approved, and nothing has executed

### Requirement: A pending call survives a bot restart
A host tool call left unanswered when the bot stops SHALL be answered after reattach with an error result, so the agent's turn continues.

#### Scenario: Restart mid-call
- **WHEN** the bot restarts while a `sources` call is pending
- **THEN** the reattached session answers it with a JSON-RPC error naming the restart and the agent's turn finishes without a hang

### Requirement: Sources over the same channel
For a project with a `sources` block the bot SHALL serve the sources tool table (search, get, transcript, tasks, meetings, calendar, activity, fragments, people, stats, unanswered, stuck) over the control channel from the replica on its own disk, with inputs, outputs and scrub markers identical to the stdio server's.

#### Scenario: Parity
- **WHEN** the same `search` call is made through the control channel and against the stdio server over the same replica
- **THEN** the results are identical
