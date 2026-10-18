## ADDED Requirements

### Requirement: Skills are declared in the messaging configuration
A project's `messaging` block MAY declare `skills`: a list of objects with `id`, `name`, `description`, and optionally `examples` and `tags`. The configuration SHALL be refused at load, with an error that names the project and the skill, when any of these holds:
- an id is not kebab-case (`[a-z0-9][a-z0-9-]{0,62}`), or appears twice;
- a name or a description is missing, is longer than one line, or is over its cap: 80 characters for a name, 300 for a description;
- there are more than 16 skills, more than 5 examples for one skill, or more than 8 tags for one skill;
- an example is not one line of at most 200 characters, or a tag is not kebab-case of at most 32 characters.

A project without `skills` SHALL behave exactly as before: the same card, the same prompt and the same framing of its answering turns.

#### Scenario: Duplicate skill id
- **WHEN** brand-studio's configuration declares two skills with the id `site-design`
- **THEN** the configuration is refused at load with an error naming brand-studio and `site-design`, and the project behaves as before

#### Scenario: No skills
- **WHEN** a project has a `messaging` block without `skills`
- **THEN** its card and the framing of its answering turns are byte-identical to today's

### Requirement: A task can name the skill it asks for
`send_message` SHALL accept an optional `skill`: the id of one skill from the target's card. The receiving installation SHALL decide on it, for both transports:
- A first message naming a skill the target does not declare, or naming something that is not a skill id, SHALL be answered `rejected: unknown skill`. The rejection SHALL list the skill ids the target declares. The check SHALL come after acceptance, so a sender the target does not accept learns nothing about its skills.
- A message without a skill SHALL be a general request, handled as before.
- In the caller's own installation, `send_message` SHALL refuse an unknown skill at once, list the target's skills, and send nothing.

Only a task's first message SHALL carry a skill; replies carry none. The skill SHALL be recorded on the task on both sides, shown by `/aven asks`, and named in the framing of the answering turn together with its name and description. Naming a skill SHALL NOT change what the answering agent may do: nothing is routed or permitted by skill.

#### Scenario: Skill named
- **WHEN** owen-ops calls `send_message("bluefin/brand-studio", "build a brand profile for hotel-alpenrose.example", {skill: "brand-profile"})`, and brand-studio declares `brand-profile`
- **THEN** the task starts, both installations record `brand-profile` on it, and the framing of brand-studio's answering turn names the skill, its name and its description

#### Scenario: Unknown skill at a peer
- **WHEN** owen-ops names the skill `video-edit`, which brand-studio does not declare
- **THEN** the task ends `rejected: unknown skill`, and owen-ops is told the skill ids that brand-studio declares

#### Scenario: Unknown skill in the same installation
- **WHEN** owen-ops names a skill that a target in its own installation does not declare
- **THEN** the tool returns an error listing that target's skills, and no task is started

#### Scenario: No skill
- **WHEN** owen-ops sends a task to brand-studio without a skill
- **THEN** the task runs as a general request, the answering framing is byte-identical to a framing without skills, and `/aven asks` shows no skill

#### Scenario: A release without skills
- **WHEN** an installation on a release without this change receives a task naming a skill
- **THEN** it ignores the field and runs the task as a general request

## MODIFIED Requirements

### Requirement: Discovery through agent cards
`agents(installation?)` SHALL return the agents of that installation that accept the caller. Without an argument it SHALL return every installation the caller can reach: the caller's own first, then each peer pinned in `hub.peers.json`, each with its cards or `offline`. That way an agent learns its peers' names from the tool rather than having to guess them (the hub tells nobody who is on it). Each card SHALL give:
- the agent id;
- the one-line description from its messaging configuration;
- whether the agent would take a new task from the caller now, that is, its daily limit for the caller is not reached;
- its skills, when it declares any: for each, the id, name, description, examples and tags.

A card without skills SHALL be unchanged. For a peer installation that is not connected, or that does not allow this installation at the hub, it SHALL return `offline` and say that the peer may also not have pinned this installation.

#### Scenario: Listing a peer
- **WHEN** owen-ops calls `agents("bluefin")` while `bluefin` is connected, and `home` and `bluefin` allow each other
- **THEN** it receives one card for each bluefin agent that accepts `home/owen-ops`, and none for the others

#### Scenario: Peer has not pinned us
- **WHEN** owen-ops calls `agents("northwind")`, and `northwind` has not pinned `home`
- **THEN** it receives `offline` at once, with the note that `northwind` may not have pinned `home`

#### Scenario: Every reachable installation
- **WHEN** owen-ops on `home`, which has pinned `bluefin` and `northwind`, calls `agents()` without an argument
- **THEN** it receives `home` with its own accepting agents first, then `bluefin` and `northwind`, each with its cards or `offline`

#### Scenario: Card with skills
- **WHEN** owen-ops calls `agents("bluefin")`, and brand-studio declares the skills `brand-profile` and `site-design`
- **THEN** brand-studio's card lists both skills, each with its name, description and examples

### Requirement: Agent tools mirror A2A operations
A sending session SHALL have these tools:
- `send_message(target, text, {taskId?, skill?})`: A2A SendMessage. It starts a new task, which may name one skill of the target ("A task can name the skill it asks for"), or replies on an existing one;
- `get_task(taskId)`: GetTask, the state and the last message;
- `cancel_task(taskId)`: CancelTask;
- `agents(installation?)`: the agent cards it may address.

A session answering a task SHALL have `request_input(question, {options?})`, which moves the task of its own conversation to `input-required`.

A target SHALL be `<installation>/<agent>`, or `<agent>` for an agent of the caller's own installation. Every one of these tools SHALL return without waiting for the other agent. A `send_message` call that the bot serves twice SHALL start one task, for example when a restart re-serves a pending call. `get_task`, `cancel_task` and replies SHALL act only on tasks the calling conversation started, so a task's content never reaches another conversation through them.

A conversation that is neither a chat conversation nor a shadow conversation SHALL NOT start tasks, because answers would have nowhere to go; one-off `/aven` answers and dreams are such conversations.

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

### Requirement: Terminal states are reported
A task SHALL end in exactly one of `completed`, `failed`, `canceled` or `rejected`. The asker SHALL be told the state and the reason for every state except `completed`, which delivers the answer. `rejected` SHALL apply only to a task's first message; a later message refused by the hub or the receiver SHALL end the task `failed` with that reason. The reasons are:
- `rejected`: not accepted, budget, too deep, backlog, unknown installation, unsupported version, domain changed, unknown skill;
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

#### Scenario: Unknown skill
- **WHEN** owen-ops names a skill that the target at a peer does not declare
- **THEN** the task ends `rejected: unknown skill`, and owen-ops is told, with the skill ids the target declares
