## ADDED Requirements

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

## MODIFIED Requirements

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

## REMOVED Requirements

### Requirement: The caller is the session
**Reason**: Its only scenario is about `propose`, which is removed.
**Migration**: The same rule, with a messaging example: "A host tool call belongs to its session".

### Requirement: Deterministic, read or gated
**Reason**: It names `registry` and `propose`, which are removed, and its "Propose returns the gate" scenario goes with them.
**Migration**: The rule for the tools that remain: "Host tools read state or exchange task messages".
