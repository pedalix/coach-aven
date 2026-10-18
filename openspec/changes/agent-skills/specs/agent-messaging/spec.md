## ADDED Requirements

### Requirement: Skills come from the project's Claude Code skills
An agent's skills SHALL be the Claude Code skills its project defines: the `.claude/skills/*/SKILL.md` files in the project folder and in each of its repo checkouts. Each skill's name and description SHALL come from the file's frontmatter. The installation SHALL record them, with the repo, commit and path each one came from, as a project fact refreshed whenever the project's sandbox is prepared. Bundled CLI skills and plugin skills SHALL never be offered to other agents.

A skill in a repo of a multi-repo project SHALL be offered only when the project opts in with `repoSkills`. With it, the project's sessions SHALL start with `--add-dir` for each repo, so they load those skills. Without it, every project's sessions SHALL start exactly as before. A name that two origins of one project both define SHALL not be offered.

When a session's start report (`init`) does not list a skill that the project offers, the installation SHALL log it as a warning.

#### Scenario: Single-repo project
- **WHEN** caldora's only repo has `.claude/skills/order-trace/SKILL.md`
- **THEN** the project's skills fact lists `order-trace` with its description and the file at its commit

#### Scenario: Multi-repo project without the opt-in
- **WHEN** a project has two repos, one of them with `.claude/skills/brand-profile/SKILL.md`, and no `repoSkills`
- **THEN** `brand-profile` is recorded as not loadable and is never offered, and the project's sessions start exactly as before

#### Scenario: Multi-repo project with the opt-in
- **WHEN** the same project sets `repoSkills: true`
- **THEN** its sessions start with `--add-dir` for each repo, their start report lists `brand-profile`, and the skill can be offered

#### Scenario: Bundled and plugin skills
- **WHEN** a session's start report lists bundled skills such as `code-review`
- **THEN** none of them can be offered to another agent, whatever the configuration says

#### Scenario: Name clash
- **WHEN** two repos of one project both define a skill named `release-notes`
- **THEN** `release-notes` is not offered, and a warning names the project, the skill and both files

### Requirement: The receiving installation decides which skills each sender may use
A project's `messaging.skills` SHALL list the names of the skills it may offer at all. Without it, the project SHALL offer none.

An `accept` entry MAY be an object `{"from": "<pattern>", "skills": [<names>]}`, where `<pattern>` is an entry's string form; it narrows the offer for the senders it matches. A string entry SHALL mean every offered skill. The configuration SHALL be refused at load when an object entry names a skill that is not in `messaging.skills`.

For a caller, the skills it may use SHALL be the union over the entries that match it, intersected with the offered skills that are loadable and not clashing. A name in `messaging.skills` that is missing, not loadable or clashing SHALL be logged with the reason and not offered.

The same set SHALL decide both what the caller's card shows and which skill a task from that caller may name.

#### Scenario: Nothing offered by default
- **WHEN** brand-studio's repo has the skills `brand-profile` and `release`, and its `messaging` block has no `skills`
- **THEN** its card shows `skills: []`, and a task naming either skill is rejected

#### Scenario: Allowlisted skill
- **WHEN** brand-studio's `messaging.skills` is `["brand-profile"]`
- **THEN** every accepted sender sees `brand-profile` on its card, and nobody sees `release`

#### Scenario: Narrowed for one sender
- **WHEN** `messaging.skills` is `["brand-profile", "site-design"]`, and the accept list is `[{"from": "home/owen-ops", "skills": ["brand-profile"]}, "bluefin/nora"]`
- **THEN** owen-ops sees and may name only `brand-profile`, while nora sees and may name both

#### Scenario: Listed but not found
- **WHEN** `messaging.skills` lists `site-design`, and no skill folder of the project defines it
- **THEN** the card does not show it, and a warning names the project, the skill and the reason

### Requirement: A task can name the skill it asks for
`send_message` SHALL accept an optional `skill`: the id of one skill from the target's card. The receiving installation SHALL decide on it, for both transports:
- **A skill the caller may not use** SHALL get `rejected: unknown skill`, with the ids the caller may use. This includes any skill named to an agent that offers none. The check SHALL come after acceptance, so a sender the target does not accept learns nothing about its skills.
- **A message without a skill** SHALL be a general request, handled as before.
- **In the caller's own installation,** `send_message` SHALL refuse a skill the caller may not use at once, list the ones it may use, and send nothing.

When a task names a skill, the answering conversation's first message SHALL invoke that skill explicitly, in the slash form, followed by the task's usual frame. When the answering session did not load the skill, or when the pinned CLI cannot run that form, the frame SHALL instead name the skill to use, and a warning SHALL be logged.

Only a task's first message SHALL carry a skill; replies carry none. The skill SHALL be recorded on the task on both sides and shown by `/aven asks`.

#### Scenario: Skill named
- **WHEN** owen-ops calls `send_message("bluefin/brand-studio", "build a brand profile for hotel-alpenrose.example", {skill: "brand-profile"})`, and owen-ops may use `brand-profile`
- **THEN** brand-studio's answering conversation starts with `/brand-profile` followed by the task frame, and both installations record `brand-profile` on the task

#### Scenario: Unknown skill at a peer
- **WHEN** owen-ops names the skill `video-edit`, which brand-studio does not offer to it
- **THEN** the task ends `rejected: unknown skill`, and owen-ops is told the skill ids it may use

#### Scenario: Unknown skill in the same installation
- **WHEN** owen-ops names a skill that a target in its own installation does not offer to it
- **THEN** the tool returns an error listing the skills it may use, and no task is started

#### Scenario: No skill
- **WHEN** owen-ops sends a task to brand-studio without a skill
- **THEN** the task runs as a general request, its first message is today's frame byte for byte, and `/aven asks` shows no skill

#### Scenario: Agent without skills
- **WHEN** owen-ops calls `agents("bluefin")`, and caldora offers no skills
- **THEN** caldora's card has its description and `skills: []`, a general request to caldora runs as today, and a task naming any skill is rejected with an empty list

#### Scenario: Skill not loaded in the session
- **WHEN** a task names `brand-profile`, and the answering session's start report does not list it
- **THEN** the first message names the skill in the frame instead of invoking it, and a warning is logged

#### Scenario: A release without skills
- **WHEN** an installation on a release without this change receives a task naming a skill
- **THEN** it ignores the field and runs the task as a general request

## MODIFIED Requirements

### Requirement: The receiving agent decides who may ask it
A session SHALL have the sending tools only when its project is configured to send. A task message SHALL reach an agent only when that agent's configuration accepts the sender. An entry is one of these:
- an exact `<installation>/<agent>`;
- a bare agent name, for the agent's own installation;
- `*`, for every agent of the agent's own domain;
- an object `{"from": <one of the forms above>, "skills": [<names>]}`, which accepts the same senders and narrows the skills they may use ("The receiving installation decides which skills each sender may use").

No entry SHALL match a whole other domain. The receiving installation SHALL check this for every message of a task, new or reply. It SHALL answer anything else with `rejected: not accepted` and start no turn. Accepting a sender gives the sender, and whoever may drive it, what the accepting agent answers.

Configuration SHALL be read at call time, so a project that no longer may send cannot start a task from a session opened before the change. A project that several tenants share SHALL be refused a `messaging` configuration, because its domain would be ambiguous.

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

#### Scenario: An object entry
- **WHEN** caldora accepts `{"from": "home/owen-ops", "skills": ["order-trace"]}`
- **THEN** owen-ops is accepted exactly as with the string `home/owen-ops`, and may name only `order-trace`

### Requirement: Discovery through agent cards
`agents(installation?)` SHALL return the agents of that installation that accept the caller. Without an argument, it SHALL return every installation the caller can reach: the caller's own first, then each peer pinned in `hub.peers.json`, each with its cards or `offline`. That way an agent learns its peers' names from the tool rather than having to guess them; the hub tells nobody who is on it.

Each card SHALL give:
- the agent id;
- the one-line description from its messaging configuration;
- whether the agent would take a new task from the caller now, that is, its daily limit for the caller is not reached;
- `skills`: the skills the caller may use, each with its id, name, description and tags, or `[]` when there are none.

For a peer installation that is not connected, or that does not allow this installation at the hub, it SHALL return `offline` and say that the peer may also not have pinned this installation.

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
- **WHEN** owen-ops calls `agents("bluefin")`, and brand-studio offers owen-ops the skills `brand-profile` and `site-design`
- **THEN** brand-studio's card lists both skills, each with its name and description from its `SKILL.md`

### Requirement: Agent tools mirror A2A operations
A sending session SHALL have these tools:
- `send_message(target, text, {taskId?, skill?})`: A2A SendMessage. It starts a new task, which may name one skill the target offers the caller ("A task can name the skill it asks for"), or replies on an existing one;
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
- **WHEN** owen-ops names a skill that the target at a peer does not offer to it
- **THEN** the task ends `rejected: unknown skill`, and owen-ops is told the skill ids it may use
