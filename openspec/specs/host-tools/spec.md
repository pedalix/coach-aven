# host-tools Specification

## Purpose
Tools implemented by the bot and served to the agent over the session's own control channel: no mount, no network path, no credential in the sandbox.

## Requirements

### Requirement: Served over the session's control channel
The bot SHALL register its tool servers with the agent's Claude Code process at session start (`initialize`, `sdkMcpServers`). It SHALL answer every `mcp_message` control request for them, handshake and tool calls alike, on the same process channel it drives turns through. The `host` server SHALL be registered when the session's project has a `messaging` configuration.

#### Scenario: A host tool call needs no transport
- **WHEN** the agent calls a `host` or `sources` tool in a sandbox on any driver
- **THEN** the call reaches the bot over the process channel and the result returns the same way, with no mount, listener or bearer involved

#### Scenario: Nothing is registered without the gate
- **WHEN** the project has neither a `sources` block nor a `messaging` configuration
- **THEN** the session registers no in-process server and the sandbox's MCP list is byte-identical to today's

#### Scenario: Messaging without dispatch
- **WHEN** the project has a `messaging` configuration
- **THEN** the session's `host` server lists the messaging tools, and no `propose` or `registry` tool exists

#### Scenario: Shadow conversation
- **WHEN** a shadow conversation's session opens for a task
- **THEN** its `host` server lists `request_input` and, if the project may send, the sending tools

#### Scenario: Retired flag
- **WHEN** an installation starts with `DISPATCH=1` in its environment
- **THEN** the bot logs one warning at boot that the flag is retired, and every session's tools and prompt are the same as without it

### Requirement: A pending call survives a bot restart
A host tool call left unanswered when the bot stops SHALL be answered after reattach by the new bot, so the agent's turn continues. Every unanswered call of the turn SHALL be answered, not only the last one. A call that the old bot already executed SHALL return the same result again, without executing twice.

#### Scenario: Restart mid-call
- **WHEN** the bot restarts while a `sources` call is pending
- **THEN** the reattached session answers it and the agent's turn finishes without a hang

#### Scenario: Several calls pending
- **WHEN** the bot restarts while three `send_message` calls of one turn are pending, one of which it had already executed
- **THEN** after reattach all three are answered, the executed one with its existing task, and the turn finishes without a hang

### Requirement: Sources over the same channel
For a project with a `sources` block the bot SHALL serve the sources tool table (search, get, transcript, tasks, meetings, calendar, activity, fragments, people, stats, unanswered, stuck) over the control channel from the replica on its own disk, off the bot's main thread, with inputs, outputs and scrub markers identical to the stdio server's.

#### Scenario: Parity
- **WHEN** the same `search` call is made through the control channel and against the stdio server over the same replica
- **THEN** the results are identical

### Requirement: A host tool call belongs to its session
The bot SHALL attribute every host tool call to the project and conversation of the session the call arrived on, and SHALL ignore any project, agent or thread named in the call's input as its sender.

#### Scenario: Spoofed sender
- **WHEN** a `send_message` input names another project as the sender
- **THEN** the task is recorded for the session's project and conversation, and the receiving agent sees the session's agent as the sender

### Requirement: Host tools read state or exchange task messages
Host tools SHALL run deterministic code in the bot. Each host tool SHALL do one of two things:
- read bot state (`agents`, `get_task`);
- exchange task messages with another agent (`send_message`, `request_input`, `cancel_task`).

The gate for task messages SHALL be the caller's project configuration and the receiving agent's acceptance. When a message would carry data from one domain to another that does not have it, the gate SHALL be a person's Send in a chat conversation, and the message SHALL be refused in a shadow conversation. Task tools SHALL act only on the caller's own tasks: `request_input` on the task of its own shadow conversation, the others on tasks its conversation started. No other host tool SHALL execute a side effect on its own.

#### Scenario: Task message without a button
- **WHEN** an agent configured to send calls `send_message` with a target that accepts it, from a conversation that carries no other domain's data
- **THEN** the message is sent without any button and the reply carries the task id; a session of a project that is not configured to send has no `send_message` tool

#### Scenario: Someone else's task
- **WHEN** a session calls `cancel_task` or `get_task` with the id of a task another conversation started, or calls `request_input` outside a shadow conversation
- **THEN** the call returns an error and the task is unchanged
