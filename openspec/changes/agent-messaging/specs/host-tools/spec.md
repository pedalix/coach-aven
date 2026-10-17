## MODIFIED Requirements

### Requirement: Served over the session's control channel
The bot SHALL register its tool servers with the agent's Claude Code process at session start (`initialize`, `sdkMcpServers`) and SHALL answer every `mcp_message` control request for them — handshake and tool calls — on the same process channel it drives turns through. The `host` server SHALL be registered when `DISPATCH` is set or the session's project has a `messaging` configuration.

#### Scenario: A host tool call needs no transport
- **WHEN** the agent calls a `host` or `sources` tool in a sandbox on any driver
- **THEN** the call reaches the bot over the process channel and the result returns the same way, with no mount, listener or bearer involved

#### Scenario: Nothing is registered without the gate
- **WHEN** `DISPATCH` is unset and the project has neither a `sources` block nor a `messaging` configuration
- **THEN** the session registers no in-process server and the sandbox's MCP list is byte-identical to today's

#### Scenario: Messaging without dispatch
- **WHEN** `DISPATCH` is unset and the project has a `messaging` configuration
- **THEN** the session's `host` server lists the messaging tools only, without `propose` or `registry`

#### Scenario: Shadow conversation
- **WHEN** `DISPATCH` is set and a shadow conversation's session opens for a task
- **THEN** its `host` server lists `request_input` and, if the project may send, the sending tools, but never `propose` or `registry`

### Requirement: Deterministic, read or gated
Host tools SHALL run deterministic code in the bot. Each host tool SHALL do one of three things:
- read bot state (`registry`, `agents`, `get_task`);
- submit a record whose effect waits for a button (`propose`);
- exchange task messages with another agent (`send_message`, `request_input`, `cancel_task`).

The gate for task messages SHALL be the caller's project configuration and the receiving agent's acceptance. When a message would carry data from one domain to another that does not have it, the gate SHALL be a person's Send in a chat conversation, and the message SHALL be refused in a shadow conversation. Task tools SHALL act only on the caller's own tasks: `request_input` on the task of its own shadow conversation, the others on tasks its conversation started. No other host tool SHALL execute a side effect on its own.

#### Scenario: Propose returns the gate
- **WHEN** the agent calls `propose` with a valid record
- **THEN** the reply carries the proposal id and whether it waits for Send or is auto-approved, and nothing has executed

#### Scenario: Task message without a button
- **WHEN** an agent configured to send calls `send_message` with a target that accepts it, from a conversation that carries no other domain's data
- **THEN** the message is sent without any button and the reply carries the task id. A session of a project that is not configured to send has no `send_message` tool.

#### Scenario: Someone else's task
- **WHEN** a session calls `cancel_task` or `get_task` with the id of a task another conversation started, or calls `request_input` outside a shadow conversation
- **THEN** the call returns an error and the task is unchanged

### Requirement: A pending call survives a bot restart
A host tool call left unanswered when the bot stops SHALL be answered after reattach by the new bot, so the agent's turn continues. Every unanswered call of the turn SHALL be answered, not only the last one. A call that the old bot already executed SHALL return the same result again, without executing twice.

#### Scenario: Restart mid-call
- **WHEN** the bot restarts while a `sources` call is pending
- **THEN** the reattached session answers it and the agent's turn finishes without a hang

#### Scenario: Several calls pending
- **WHEN** the bot restarts while three `send_message` calls of one turn are pending, one of which it had already executed
- **THEN** after reattach all three are answered, the executed one with its existing task, and the turn finishes without a hang
