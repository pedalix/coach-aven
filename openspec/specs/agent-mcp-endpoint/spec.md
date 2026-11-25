# agent-mcp-endpoint Specification

## Purpose

People working in an MCP client this project did not build — Claude, Claude Code, Langdock — can put a question or a request to an agent of the installation and read its answer there. The installation's gateway says who the person is; the agent's own configuration says whether it takes their questions; the answer is produced as for any other task, in a shadow conversation.

## Requirements

### Requirement: Off unless configured
The bot SHALL open the endpoint only when both its listen address and its bearer token are configured. Without them it SHALL open no port, and every session's tools and process arguments SHALL be what they are without this capability.

#### Scenario: Installation without the settings
- **WHEN** an installation starts with neither `AGENT_MCP_LISTEN` nor `AGENT_MCP_TOKEN`
- **THEN** no listener is opened and a recorded turn of a messaging project is byte-identical to today's

#### Scenario: Half configured
- **WHEN** the listen address is set and the token is not
- **THEN** no listener is opened and the boot log names the missing setting

### Requirement: Only the gateway may call the endpoint
Every request SHALL carry the configured bearer token. A request without it, or with another value, SHALL be answered 401 with no body and SHALL start nothing.

#### Scenario: Wrong bearer
- **WHEN** a request arrives with no `Authorization` header, or with a wrong token
- **THEN** the answer is 401 without a body and no task is created

### Requirement: The person comes from the gateway's headers
The caller of a tool SHALL be the person named by the identity headers of the request: an e-mail address, and optionally a list of groups. A request with the right bearer and no usable e-mail SHALL get a tool error naming the missing identity and SHALL create nothing. Tool inputs SHALL never name or change the caller.

#### Scenario: Identity present
- **WHEN** the gateway forwards a call with `X-MCP-User: nora@bluefin.example` and `X-MCP-Groups: support,finance`
- **THEN** the call runs as that person with those two groups

#### Scenario: Identity missing
- **WHEN** a call arrives with the right bearer and no `X-MCP-User`
- **THEN** the tool answers an error saying the gateway sent no identity, and no task is created

#### Scenario: Input tries to name someone else
- **WHEN** a `send_message` call carries an extra input field naming another person
- **THEN** the field is ignored and the task's asker is the person of the headers

### Requirement: A project accepts people by name or by group
An agent SHALL take a person's task only when its `messaging.accept` holds `user:<e-mail>` matching the person, or `group:<name>` matching one of their groups. E-mails and group names SHALL compare case-insensitively. The entry `*` and every agent entry SHALL NOT match a person, and a person entry SHALL NOT match an agent.

#### Scenario: Accepted by e-mail
- **WHEN** caldora accepts `user:nora@bluefin.example` and that person asks it
- **THEN** the task is taken

#### Scenario: Accepted by group
- **WHEN** caldora accepts `group:support` and a person whose groups include `Support` asks it
- **THEN** the task is taken

#### Scenario: A star is not people
- **WHEN** caldora accepts only `*` and a person asks it
- **THEN** the person is told no such agent accepts them, and no turn starts

#### Scenario: Malformed entry
- **WHEN** a project's accept list holds `user:` with no address, or `group:` with no name
- **THEN** the configuration is refused at load with an error naming the entry

### Requirement: A person sees only the agents that accept them
`agents` SHALL list, for the calling person, the cards of the own installation's agents that accept them and nothing else. `send_message` to an agent that does not exist or does not accept the person SHALL answer the same error for both, naming the agents that do.

#### Scenario: Two projects, one accepts
- **WHEN** caldora accepts `group:support`, bluefin-ops accepts no people, and a person of `support` calls `agents`
- **THEN** the answer holds caldora's card, with the skills it offers, and no trace of bluefin-ops

#### Scenario: Unknown and unaccepted look the same
- **WHEN** that person sends a task to `bluefin-ops`, and another to `no-such-agent`
- **THEN** both answers are the same error, listing `caldora`

#### Scenario: Another installation
- **WHEN** a person sends a task to `home/owen-ops` through bluefin's endpoint
- **THEN** it is refused: targets are agents of this installation

### Requirement: A question is a task answered in a shadow conversation
`send_message` from an accepted person SHALL create a task and start its answering turn in a shadow conversation of the target agent, under the rules that hold for a task from another agent: the skill named, the completion rule, the round limit, cancellation. Nothing SHALL be posted to any chat.

#### Scenario: Question answered
- **WHEN** an accepted person sends caldora "how many orders failed yesterday?"
- **THEN** a shadow conversation of caldora runs the turn, the task ends `completed` with the answer as its last message, and no chat message is posted

#### Scenario: A skill by name
- **WHEN** the person names `skill: "weekly-report"`, which caldora's card offers
- **THEN** the shadow conversation starts with that skill, and a skill the card does not offer is refused with the offered ids

### Requirement: The answer is read from the task
`get_task` SHALL return a task's state, times, reason and last message to the person who started it, and to nobody else. A task id that does not exist and one that belongs to another person SHALL answer the same error.

#### Scenario: Reading the answer
- **WHEN** the asker calls `get_task` after the task completed
- **THEN** the answer text and the state `completed` come back

#### Scenario: Someone else's task
- **WHEN** another accepted person calls `get_task` with that task id
- **THEN** the answer is the error given for an unknown task

### Requirement: A call can wait for the answer
`send_message` and `get_task` SHALL take `waitSeconds`. The call SHALL return when the task has an answer, a question back or an end, or when the time is up, whichever comes first; a value above the endpoint's limit SHALL be cut to it. Without `waitSeconds`, `send_message` SHALL return at once.

#### Scenario: Short answer inside the wait
- **WHEN** `send_message` is called with `waitSeconds: 40` and the agent answers after 15 seconds
- **THEN** the call returns after about 15 seconds with the state `completed` and the answer

#### Scenario: Long work
- **WHEN** the agent is still working when the wait ends
- **THEN** the call returns the task id and the state `working`, and a later `get_task` returns the answer

#### Scenario: Above the limit
- **WHEN** `waitSeconds: 600` is asked for
- **THEN** the call waits no longer than the endpoint's limit

### Requirement: The agent can ask the person back
When the answering agent asks a question back, the task SHALL read `input-required` with that question as its last message, and `send_message` with the task's id from its asker SHALL deliver the reply to the same shadow conversation.

#### Scenario: Question back and reply
- **WHEN** caldora's shadow turn asks "which shop?" and the person replies on the task with "the main one"
- **THEN** the reply reaches that shadow conversation, and the task later ends `completed`

#### Scenario: Reply from another person
- **WHEN** a different person sends a reply naming that task id
- **THEN** it is refused as an unknown task and nothing reaches the shadow conversation

### Requirement: People are capped like any sender
An agent SHALL take from one person at most its per-sender daily number of new tasks; beyond it `send_message` SHALL refuse with the limit named and start no turn.

#### Scenario: Cap reached
- **WHEN** caldora's `acceptPerDay` is 30 and a person sends a 31st task that day
- **THEN** it is refused for budget and no shadow conversation starts

### Requirement: Withdrawn acceptance ends open tasks
When a reload removes the entry that accepted a person, that person's open tasks to the agent SHALL end `canceled: not accepted`, and a shadow turn running for one SHALL be canceled.

#### Scenario: Entry removed
- **WHEN** the operator removes `group:support` from caldora and reloads while a task of a `support` person is open
- **THEN** the task reads `canceled: not accepted` and its turn stops

### Requirement: People's tasks are audited and metered by person
The operators' task list SHALL show a person's task with the person as its origin, beside agents' tasks, with the same state, cost, transcript and cancel. The usage records of its answering turns SHALL name the person.

#### Scenario: Operator audit
- **WHEN** an operator lists the recent tasks after a person asked caldora
- **THEN** the line shows the person's e-mail as the origin, the state and the cost, and the transcript opens

#### Scenario: Usage record
- **WHEN** the answering turn of that task settles
- **THEN** its usage record carries the task id and the person's e-mail
