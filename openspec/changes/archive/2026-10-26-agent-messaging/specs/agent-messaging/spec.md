## Purpose
Any agent the bot runs can ask any agent that accepts it, in its own installation or in another one, and receive the answer inside its own session: in the turn it is running, or as a new turn. The answering turn runs in a shadow conversation that never posts to chat. Messages between installations are readable only by those two installations. Data from one domain (one tenant of one installation) does not reach another domain without a person. The agent-facing tools mirror the A2A operations. Messaging carries questions and requests to do work alike: the receiving agent's accept list is the gate.

## ADDED Requirements

### Requirement: Off unless configured
A project without a `messaging` configuration SHALL behave exactly as before, including on an installation where other projects use messaging. An installation with no such project and no `HUB_URL` SHALL register no messaging tool, open no hub connection and add no `/aven asks` verb, so `/aven asks …` stays a question to the agent there.

#### Scenario: Installation without configuration
- **WHEN** an installation starts with no project configured for messaging and without `HUB_URL`
- **THEN** no outbound hub connection is attempted, every session's `host` tool list and process arguments are byte-identical to today's, and `/aven asks why?` is answered by the agent as before

#### Scenario: Project not configured
- **WHEN** owen-ops on `home` is configured to send and another `home` project has no `messaging` configuration
- **THEN** that other project's sessions have today's tools and process arguments, and a task addressed to it is refused as not accepted

### Requirement: The receiving agent decides who may ask it
A session SHALL have the sending tools only when its project is configured to send. A task message SHALL reach an agent only when that agent's configuration accepts the sender. An entry is an exact `<installation>/<agent>`, a bare agent name for the agent's own installation, or `*` for every agent of the agent's own domain; no entry SHALL match a whole other domain. The receiving installation SHALL check this for every message of a task, new or reply. It SHALL answer anything else with `rejected: not accepted` and start no turn. Accepting a sender gives the sender, and whoever may drive it, what the accepting agent answers. Configuration SHALL be read at call time, so a project that no longer may send cannot start a task from a session opened before the change. A project that several tenants share SHALL be refused a `messaging` configuration, because its domain would be ambiguous.

#### Scenario: Accepted in the same installation
- **WHEN** a person's own agent `bluefin/nora`, configured to send, asks `bluefin-ops`, which accepts `nora`
- **THEN** the task runs in a shadow conversation of bluefin-ops on `bluefin`, and the hub plays no part in it

#### Scenario: Not accepted
- **WHEN** `home/owen-ops` asks `bluefin/caldora`, which accepts only `*`, that is, the agents of its own domain
- **THEN** caldora starts no turn and owen-ops is told the task was rejected as not accepted

#### Scenario: Answer-only project
- **WHEN** a project accepts `home/owen-ops` and is not configured to send
- **THEN** its sessions have no `send_message` tool, and it answers tasks from owen-ops

#### Scenario: Acceptance withdrawn
- **WHEN** the operator removes `home/owen-ops` from caldora's accepted senders and runs `/aven reload` while a task from owen-ops is open
- **THEN** that task ends `canceled: not accepted`, a shadow turn running for it is canceled, and owen-ops is told

#### Scenario: Shared project
- **WHEN** a project listed for two tenants is given a `messaging` configuration
- **THEN** the configuration is refused at load with an error naming the project, and the project behaves as before

#### Scenario: Sending withdrawn
- **WHEN** the operator removes `send` from owen-ops and runs `/aven reload` while a session of owen-ops is open
- **THEN** a later `send_message` from that session is refused, and the tasks already open finish

### Requirement: Agent tools mirror A2A operations
A sending session SHALL have these tools:
- `send_message(target, text, {taskId?})`: A2A SendMessage, a new task or a reply on an existing one;
- `get_task(taskId)`: GetTask, the state and the last message;
- `cancel_task(taskId)`: CancelTask;
- `agents(installation?)`: the agent cards it may address.

A session answering a task SHALL have `request_input(question, {options?})`, which moves the task of its own conversation to `input-required`. A target SHALL be `<installation>/<agent>`, or `<agent>` for an agent of the caller's own installation. Every one of these tools SHALL return without waiting for the other agent. A `send_message` call that the bot serves twice SHALL start one task, for example when a restart re-serves a pending call. `get_task`, `cancel_task` and replies SHALL act only on tasks the calling conversation started, so a task's content never reaches another conversation through them. A conversation that is neither a chat conversation nor a shadow conversation SHALL NOT start tasks, because answers would have nowhere to go; one-off `/aven` answers and dreams are such conversations.

#### Scenario: Send returns at once
- **WHEN** owen-ops on `home` calls `send_message("bluefin/caldora", "why did orders drop on 2026-10-16?")`
- **THEN** the tool returns `{taskId, state: "submitted"}` within a second

#### Scenario: Unknown installation
- **WHEN** the target names an installation that is not a known peer
- **THEN** the tool returns an error naming the valid forms and the known peers, and nothing is sent

#### Scenario: Agent that does not accept the caller
- **WHEN** the target names an agent that does not exist or does not accept the caller
- **THEN** one of two things happens, and the answer does not say whether the agent exists:
  - in the caller's own installation, the tool returns an error listing the local agents that accept the caller;
  - at a peer, the task ends `rejected: not accepted`

#### Scenario: Status on demand
- **WHEN** owen-ops calls `get_task(taskId)` while caldora is working on it
- **THEN** it receives `working` (sent when caldora's turn started) and the times, from local state without a round trip

#### Scenario: Another thread asks for the answer
- **WHEN** a second thread of owen-ops calls `get_task` with the id of a task the first thread started
- **THEN** the call returns an error, and nothing of the task's messages is returned

#### Scenario: Call served again after a restart
- **WHEN** the bot restarts after starting a task for a `send_message` call but before answering the call, and serves the call again on reattach
- **THEN** the call returns the task already started, and no second task or shadow turn exists

### Requirement: Only the task's counterpart speaks on it
An installation SHALL accept a message on an existing task only from that task's counterpart: its target for answers and status, its origin for replies and cancels. Anything else SHALL be dropped and logged. Incoming tasks SHALL be kept apart by origin, so two senders can never address the same record.

#### Scenario: Answer from someone else
- **WHEN** an `answer` for owen-ops' task to `bluefin/caldora` arrives from `northwind`
- **THEN** it is dropped, the task is unchanged, and a warning names the sender and the task

### Requirement: Incoming messages reach the running turn or start one
Every incoming task message SHALL be delivered to the conversation it belongs to: an answer, an `input-required` question, a reply to one, or a terminal state. That conversation is the one that sent the task, or the task's shadow conversation. The message SHALL be quoted as data with its source and task id, never as an instruction from a person.

When a turn is running in that conversation and can take the message, the message SHALL go into that turn, and the agent sees it at its next tool step. A turn can take it when all of these hold:
- the turn was started by a person, a routine or a task;
- it is younger than the soft deadline;
- it has not taken its limit of such messages yet;
- the session was started with the delivery accounting, on a CLI that passed the contract check.

Otherwise the message SHALL start a new turn in that conversation, after the running one. A running turn SHALL NOT be interrupted. People's messages to the agent SHALL keep working as ordinary turns while a task is open.

#### Scenario: Answer while the asker is idle
- **WHEN** caldora's answer arrives and owen-ops' thread has no running turn
- **THEN** a turn starts in owen-ops' session with "Answer from bluefin/caldora (task …)", the original question and the answer, and owen-ops writes its reply in the thread

#### Scenario: Answer while the asker is working
- **WHEN** caldora's answer arrives while owen-ops runs a turn for a person in the same thread
- **THEN** owen-ops sees the answer at its next tool step inside that turn and may use it in its reply to the person; that turn produces one answer, and no extra turn is started

#### Scenario: People keep talking while the task is open
- **WHEN** a person writes to owen-ops in the thread after it asked and before the answer arrived
- **THEN** that message is an ordinary turn answered at once, and the task is unaffected

#### Scenario: Turn ends just as the message arrives
- **WHEN** a message is delivered into a turn that finishes before reaching another tool step
- **THEN** the message is handled as a new turn in the same session, exactly once, and its answer is posted like any answer in that conversation

#### Scenario: Automatic turn running
- **WHEN** an answer arrives while the conversation runs an automatic turn that posts to a tracker without a person
- **THEN** the answer waits for that turn to end and runs as its own turn, so it never reaches the tracker unseen

#### Scenario: Asker in a direct message or a Teams chat
- **WHEN** owen-ops asked from a direct message (or a Teams reply chain) and the answer arrives after the turn ended
- **THEN** the answer turn runs in that same direct message or reply chain

#### Scenario: The person sees the fold
- **WHEN** an answer is folded into a running turn
- **THEN** the turn's steps show a line naming the source and the task id

#### Scenario: Fan-out
- **WHEN** an agent sent three tasks from one conversation and the first answer arrives
- **THEN** the delivered message lists the tasks from that conversation that are still open, with their states, so the agent can wait for the rest or answer now

#### Scenario: Routine gathers answers
- **WHEN** a scheduled routine's turn sends tasks to three agents and ends
- **THEN** each answer arrives as a turn in that run's thread, or folds into the run's turn if it is still running; the run's recorded outcome is its own turn's, and a run that failed after sending them is not retried, because its answers continue in its thread

#### Scenario: Session gone
- **WHEN** the asking thread's session was restarted before the answer arrived
- **THEN** the answer turn runs in the new session and is understandable on its own, because it repeats the question

#### Scenario: Answer after the asker's bot restarted
- **WHEN** the asking bot restarts while a task is open and the answer arrives afterwards
- **THEN** the answer is delivered in the original thread exactly once

### Requirement: Delivery is confirmed by the agent, not by the write
A message written into a running turn SHALL count as delivered only once the agent's process has taken it up. When the process dies before that, the message SHALL be delivered again as a new turn. While the process lives, a message SHALL NOT be written a second time, however long its pickup takes. If the process is idle and has not taken a written message up within 2 minutes, the bot SHALL restart the session and deliver the message as a new turn, since a restarted process no longer holds it. A message SHALL NOT be acknowledged to the sender's side before it counts as delivered or a turn for it is journaled.

#### Scenario: Process dies before the next tool step
- **WHEN** an answer was written into a running turn and the sandbox process is killed before the agent reached its next tool step
- **THEN** after recovery the answer is delivered as a turn in the same session, exactly once

#### Scenario: A long tool
- **WHEN** an answer is written while a tool runs for twenty minutes
- **THEN** the agent takes it up when the tool ends, it is delivered once, and a warning names how long it waited

#### Scenario: Message stuck on an idle process
- **WHEN** the agent's process is idle and has not taken up a written answer after 2 minutes
- **THEN** an error is logged, the session is restarted, and the answer is delivered as a new turn, exactly once

#### Scenario: Bot restarts after the write
- **WHEN** the bot restarts after writing an answer into a running turn and before the agent took it up
- **THEN** on reattaching, the bot learns from the session's own output whether the agent took it up; the answer is delivered again only if the process died first

#### Scenario: Nowhere to deliver
- **WHEN** an answer arrives for a sending project that `/aven reload` removed
- **THEN** the task ends `failed: nowhere to deliver`, the message is acknowledged, and an error naming the task and the project is logged

### Requirement: The answering turn runs in a shadow conversation
An installation receiving a task SHALL run it as a turn of the target agent in a conversation of its own, one per task, under the target project's tenant. The turn SHALL use the target's prompt and sandbox. It SHALL go through the same queue, metering and restart recovery as chat turns, including the task's origin in metering after a restart. It SHALL post nothing to any chat conversation, and SHALL have no `propose` tool, since nobody could approve a proposal there. The question SHALL be framed to the agent as a question from another agent, to be answered without changing anything. Shadow turns SHALL use at most half of the installation's concurrent turn slots (at least one), so incoming tasks never take every slot from people. A shadow conversation's session SHALL be closed once its task has ended.

#### Scenario: Nothing in the channel
- **WHEN** bluefin answers a task for caldora
- **THEN** caldora's channel shows no message, and metering records the turn with its task id and origin `home/owen-ops`

#### Scenario: Restart mid-answer
- **WHEN** the bluefin bot restarts while the shadow turn runs
- **THEN** the turn is recovered like a chat turn, the answer is still sent once, and metering still carries the task's origin

#### Scenario: Recovery fails
- **WHEN** the bluefin bot restarts and the shadow turn can be neither reattached nor replayed
- **THEN** the task ends `failed` with the answering side's error, and the asker is told

#### Scenario: Incoming burst
- **WHEN** ten tasks arrive at once on an installation with four turn slots, while people are using it
- **THEN** at most two shadow turns run at a time, the others wait for a shadow slot, and a person's turn still gets a slot

### Requirement: A task completes when its shadow conversation has nothing outstanding
The shadow conversation's final answer SHALL complete the task only when nothing is outstanding in that conversation:
- no `request_input` without a reply;
- no task the conversation started that is still open;
- no message delivered to the conversation that the agent has not taken up yet;
- no background work that the agent's process reports as running.

Otherwise the answer SHALL become the task's latest status message, readable through `get_task`, and the task SHALL stay open. The first final answer after the last outstanding item resolves SHALL complete the task. When the last outstanding item resolves and no turn follows, the bot SHALL start one turn that asks the agent for its final answer, at most once per task. If the conversation is idle again with nothing outstanding and still no completing answer, the task SHALL end `failed: no answer`. Background work SHALL count as resolved when the agent's process ends.

#### Scenario: Background subagent
- **WHEN** caldora's agent starts a background subagent and ends its turn saying it will report back
- **THEN** the task stays `working`; when the subagent's report arrives and the agent answers, that answer completes the task

#### Scenario: Asked back and ended the turn
- **WHEN** caldora's agent calls `request_input` and its turn ends before a reply
- **THEN** the task stays `input-required`, and the turn's text is kept as the task's status message

#### Scenario: Sub-question
- **WHEN** bluefin-ops, answering a task from `bluefin/nora`, asks `bluefin/caldora` and ends its turn
- **THEN** nora's task stays `working`; caldora's answer starts a turn in bluefin-ops' shadow conversation, and the answer written in that turn completes nora's task

#### Scenario: Answer arrives during the final text
- **WHEN** caldora's answer to bluefin-ops' sub-question is delivered while bluefin-ops writes a final text that does not use it
- **THEN** that text does not complete nora's task; the turn that takes up caldora's answer does

#### Scenario: Nothing outstanding and no turn comes
- **WHEN** the last background task of a shadow conversation ends and the agent's process starts no turn for it
- **THEN** the bot starts one turn asking for the final answer, and that answer completes the task

#### Scenario: Nudge gives no answer
- **WHEN** the turn the bot started for the final answer ends with only a progress note and nothing outstanding
- **THEN** the task ends `failed: no answer` without a second such turn

### Requirement: Clarifications do not end the turn
The answering agent can ask back with `request_input` and keep working in the same turn. The asker SHALL receive the question like an answer, in its running turn or as a new one, and can reply with `send_message` on the task id. The reply SHALL reach the shadow conversation the same way: into its running turn, or as a new turn when that turn has ended. No turn SHALL stay open to wait for the other side; the wait SHALL be bounded only by the task's expiry. A task SHALL allow at most the answering project's `maxRounds` clarifications (default 5); a further `request_input` SHALL end it `failed: too many rounds`.

#### Scenario: Clarification answered while still working
- **WHEN** caldora's agent calls `request_input("B2C or B2B?")` and goes on reading logs, and owen-ops replies "B2C" a minute later
- **THEN** caldora's agent sees the reply at its next tool step in the same turn, and its answer completes the task

#### Scenario: Clarification needs a person
- **WHEN** owen-ops cannot answer the clarification, asks the person in its thread, and the person replies the next morning, long after caldora's turn ended
- **THEN** owen-ops sends the reply with the task id, the reply starts a new turn in caldora's shadow conversation, and nothing timed out in between

#### Scenario: Task outlives the hub
- **WHEN** an open task receives no message for longer than the hub's expiry plus one day
- **THEN** each side ends it `failed: expired` on its own: the asking side tells the asker, and the answering side closes the shadow session and tells the other side

#### Scenario: Agents loop
- **WHEN** caldora's agent calls `request_input` a sixth time on a task with the default limit
- **THEN** the task ends `failed: too many rounds`, and both sides record it

#### Scenario: Asker gives up
- **WHEN** owen-ops calls `cancel_task(taskId)`, or an operator runs `/aven asks cancel <taskId>`
- **THEN** the task ends `canceled` on both sides, and a turn running for it is canceled

### Requirement: Chains are bounded
A shadow conversation MAY send tasks of its own when its project is configured to send. Every task SHALL carry its depth:
- 0 when a conversation with a person or a routine starts it;
- the parent task's depth plus one when a shadow conversation starts it.

A task deeper than 3 SHALL be refused by the sending tool and rejected by the receiver. When a task ends without completing, the open tasks its shadow conversation started SHALL be canceled.

#### Scenario: Depth exceeded
- **WHEN** a shadow conversation answering a task of depth 3 calls `send_message`
- **THEN** the tool refuses it naming the limit, and nothing is sent

#### Scenario: Parent canceled
- **WHEN** nora cancels her task while bluefin-ops' shadow conversation waits for caldora
- **THEN** the sub-task to caldora is canceled too, and caldora's running turn for it stops

### Requirement: A task that has ended takes no more messages
A message that arrives for a task in a terminal state SHALL be acknowledged, logged and not delivered, and SHALL start no turn.

#### Scenario: Late answer
- **WHEN** caldora's answer arrives after owen-ops canceled the task
- **THEN** no turn starts in owen-ops' thread, and the log names the task and its state

### Requirement: Data from one domain does not reach another without a person
A domain SHALL be one tenant of one installation. An installation that serves one workspace is one domain. A conversation SHALL be marked with every other domain whose content reached it, directly or through any number of hops. Content is a task's question, an answer, an `input-required` question or a reply. States and fixed reasons are not content. Each mark SHALL record which domains already have that data. A message that goes out to a domain, sent or released by a person, SHALL add that domain to the holders of every mark.

The marks SHALL last as long as the conversation's record, until the conversation starts a fresh session with `🔄 Restart session`. Compaction and resume SHALL keep them.

A message from that conversation to an agent of domain Z SHALL go out only when every mark is Z, or Z already has that data. This covers a new task, a reply and an answer. A target whose domain is not known yet SHALL count as a domain that has nothing. When the message may not go out:
- in a chat conversation, it SHALL wait for a person's Send in that conversation;
- in a shadow conversation, it SHALL be refused, and a refused answer SHALL end its task `failed: refused by marks`.

Dismissing a held reply SHALL tell the conversation, and the task SHALL keep waiting for a reply.

Messages to agents of the conversation's own domain SHALL go out and carry the marks.

A domain claimed by another installation SHALL name that installation; a message whose claimed domain names any other installation SHALL be dropped. A message SHALL carry the target domain its sender assumed, and the receiver SHALL refuse it if that is not the target's domain.

The bot's posts in a marked conversation SHALL carry a marker, and the chat sources SHALL NOT ingest them, so a project's own store does not carry another domain's data to its unmarked conversations.

#### Scenario: Forwarding waits for a person
- **WHEN** owen-ops received bluefin's answer in a thread and later, in the same thread, calls `send_message("northwind/…", …)`
- **THEN** the tool returns the task as held, the thread shows the target and the text with Send and Dismiss, and nothing reaches northwind until a person clicks Send; Dismiss ends the task `canceled: dismissed`

#### Scenario: A released message can be answered
- **WHEN** a person released owen-ops' message to northwind although the thread carries bluefin's data
- **THEN** northwind's answer goes back to home, because everything in northwind's conversation came from home or is home's own

#### Scenario: Second message to the same domain
- **WHEN** a person released one message from that thread to northwind, and owen-ops sends northwind another before any answer
- **THEN** the second message goes out without a Send, because northwind already has that data

#### Scenario: Two clients in one installation
- **WHEN** owen-ops received an answer from an agent of one client workspace on bluefin, and then sends to an agent of another client workspace on the same installation
- **THEN** the message waits for a person's Send, as if the two were different installations

#### Scenario: No laundering through a local agent
- **WHEN** owen-ops, marked with bluefin, asks an agent of its own domain, and that agent's shadow conversation then tries to send to northwind
- **THEN** the shadow conversation carries the bluefin mark, and its send is refused

#### Scenario: A peer claims another domain
- **WHEN** an envelope authenticated as `bluefin` claims that its sender's domain is `northwind`
- **THEN** it is dropped and logged, and no conversation is marked or answered with northwind's holders

#### Scenario: Answer posted in a thread is not ingested
- **WHEN** owen-ops posts its reply built on bluefin's answer in a thread of a workspace that owen-ops' sources ingest
- **THEN** the sources store skips that post, and another thread of owen-ops cannot find it there

#### Scenario: Compaction keeps the marks
- **WHEN** the session of a marked thread is compacted and gets a new session id
- **THEN** the thread is still marked

#### Scenario: Fresh session
- **WHEN** the thread's session is restarted with `🔄 Restart session`
- **THEN** the new session carries no mark

### Requirement: Failures are loud
Every one of these SHALL be logged with its task id and reason:
- a refused connection, a bad signature or a replaced connection;
- a message that cannot be delivered, one taken up late, one lost by a dead process;
- a mismatched result;
- an exceeded limit, an expiry;
- a message from the wrong counterpart, one for an ended task;
- a held or refused message under the marks.

Those at warning level or above SHALL be sent to error tracking explicitly, whether or not logs are forwarded there.

#### Scenario: Process lost a message
- **WHEN** the agent's process dies before taking up a message written into its turn
- **THEN** an error with the task, the session key and the CLI version is logged and sent to error tracking, and the message is delivered again as a turn

### Requirement: Discovery through agent cards
`agents(installation?)` SHALL return the agents of that installation (the caller's own when omitted) that accept the caller. Each card SHALL give the agent id, the one-line description from its messaging configuration, and whether it would take a new task from the caller now (its daily limit for the caller is not reached). For a peer installation that is not connected, it SHALL return `offline`.

#### Scenario: Listing a peer
- **WHEN** owen-ops calls `agents("bluefin")` while bluefin is connected
- **THEN** it receives one card for each bluefin agent that accepts `home/owen-ops`, and none for the others

### Requirement: Terminal states are reported
A task SHALL end in exactly one of `completed`, `failed`, `canceled` or `rejected`. The asker SHALL be told the state and the reason for every state except `completed`, which delivers the answer. `rejected` SHALL apply only to a task's first message; a later message refused by the hub or the receiver SHALL end the task `failed` with that reason. The reasons are:
- `rejected`: not accepted, budget, too deep, backlog, unknown installation, unsupported version, domain changed;
- `failed`:
  - expired, too many rounds, no answer;
  - an error on the answering side;
  - peer removed, nowhere to deliver, refused by marks;
  - a later message refused;
- `canceled`: by the asker, by an operator, not accepted any more, dismissed, parent ended.

#### Scenario: Receiver rejects
- **WHEN** the hub or the answering installation rejects a task's first message
- **THEN** the asker receives one message saying that the task to the target was rejected, and why

#### Scenario: Reply bounced
- **WHEN** owen-ops replies to caldora's clarification and the hub answers `rejected: backlog`
- **THEN** the task ends `failed: backlog`, and owen-ops is told

#### Scenario: Peer removed
- **WHEN** the hub reports `northwind` removed while owen-ops has a task open with it
- **THEN** the task ends `failed: peer removed` and owen-ops is told

### Requirement: Encrypted between installations
Question and answer texts SHALL leave an installation only encrypted to the receiving installation's pinned public key and signed by the sender's key. An installation SHALL discard an envelope whose signature does not verify against the sender's pinned key. Messages between agents of one installation SHALL never leave its bot process.

#### Scenario: Tampered envelope
- **WHEN** an envelope's ciphertext or sender is altered in transit
- **THEN** the receiver drops it, logs `bad signature from <from>`, and starts no turn

### Requirement: Installations on different releases interoperate
Every envelope SHALL carry its protocol version. A receiver SHALL ignore payload fields it does not know, SHALL reject an envelope of a version it does not support with `rejected: unsupported version`, and SHALL log it. Changes within one version SHALL be additive only.

#### Scenario: Prod on the last tag
- **WHEN** the home bot runs `main` with a payload field that prod's tagged release does not know, and asks a prod agent
- **THEN** prod answers the task and ignores the field

#### Scenario: Unknown version
- **WHEN** an envelope arrives with a version the receiver does not support
- **THEN** no turn starts, the sender is told `rejected: unsupported version`, and a warning names both versions

### Requirement: Asks are auditable
`/aven asks` SHALL be for the installation's operators. It SHALL list the recent tasks of every tenant, in both directions, including those inside the installation and held ones. Each line SHALL show:
- the tenant of the local agent;
- the target or origin;
- the state and the times;
- the cost of the answering turns (for tasks to another installation, as reported back with the result);
- the first line of the question and of the answer.

`/aven asks <taskId>` SHALL show a shadow conversation's transcript. `/aven asks cancel <taskId>` SHALL cancel a task. Both SHALL be for operators only.

#### Scenario: Operator audit
- **WHEN** an operator on bluefin runs `/aven asks`
- **THEN** they see each incoming ask from `home/owen-ops` with its tenant, state and cost, and can open the transcript of its shadow turns

#### Scenario: Not an operator
- **WHEN** a member who is not an operator runs `/aven asks`
- **THEN** they are told the verb is for operators, and nothing is listed

### Requirement: Tasks are capped on both sides
An answering agent SHALL accept at most a configurable number of new tasks per sender per day (default 30); beyond that it SHALL answer `rejected: budget` without starting a turn. A sending agent SHALL start at most a configurable number of tasks per day (default 50); beyond that `send_message` SHALL refuse.

#### Scenario: Cap reached
- **WHEN** `home/owen-ops` sends its 31st task of the day to caldora
- **THEN** caldora starts no turn, and owen-ops' thread is told the task was rejected for budget
