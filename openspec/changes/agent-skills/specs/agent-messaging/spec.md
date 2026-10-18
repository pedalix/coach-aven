## ADDED Requirements

### Requirement: Skills come from the project's Claude Code skills
The skills an agent can offer SHALL be the Claude Code skills its own sessions load from the project:
- every `.claude/skills/<folder>/SKILL.md` in the session's working directory, which is the repo for a single-repo project and the project folder for a multi-repo one;
- and, for a multi-repo project, every such file in each repo checkout ("A multi-repo project's sessions load their repos' skills").

When a session of a project that offers skills is prepared, the bot SHALL read these files in the sandbox and record, as the project fact `project_skills`:
- each skill's name (the frontmatter `name`, else the folder name) and `description`;
- the optional frontmatter lists `tags` and `examples`, capped at 8 tags and 5 examples;
- where it was found, with provenance (`<repo>@<commit>:<path>`).

A name defined in more than one place SHALL be recorded with every place and SHALL NOT be offered until it is renamed; a warning SHALL name the places. A malformed key SHALL be logged and skipped, never fail the scan. Bundled CLI skills and plugin skills SHALL never be offered. A failed scan SHALL keep the previous fact.

#### Scenario: A skill in the repo
- **WHEN** the repo of brand-studio has `.claude/skills/brand-profile/SKILL.md` with a name, a description, `tags: [brand]` and two examples
- **THEN** the fact lists `brand-profile` with that description, the tag and both examples, and its source names the repo and the commit

#### Scenario: Defined twice
- **WHEN** a multi-repo project defines `triage` in two of its repos
- **THEN** `triage` is offered to nobody, and a warning names both repos

#### Scenario: Malformed tags
- **WHEN** a `SKILL.md` writes `tags: brand, web` instead of a list
- **THEN** the skill is recorded without tags, and the scan logs that `tags` is not a list

### Requirement: A multi-repo project's sessions load their repos' skills
Every session of a project with more than one repo SHALL start with `--add-dir <checkout>` for each repo, so it loads each repo's own skills as a Claude Code started in that repo would. A single-repo project's session starts in its repo and SHALL be unchanged. The installation's `REPO_SKILLS=0` SHALL turn this off for every project.

#### Scenario: Multi-repo project
- **WHEN** a session of acme-suite, with repos acme-admin and acme-shop, starts
- **THEN** its command line ends with `--add-dir` and both checkouts, and the skills of both repos are available in the session

#### Scenario: Kill switch
- **WHEN** the installation sets `REPO_SKILLS=0`
- **THEN** no session gains `--add-dir`, and the repos' skills are neither loaded nor offered

### Requirement: The receiving installation decides which skills are offered
A project's `messaging.skills` SHALL list the names of the skills its card offers, or be `"*"` for all of its skills; absent, it SHALL offer none. Every sender the agent accepts SHALL see the same set. A listed name the scan did not find SHALL not be offered and SHALL be logged once. Before the project's first scan, an explicit list SHALL be offered by name, without description, so a first task does not fail; `"*"` SHALL offer nothing until the scan.

#### Scenario: Internal skills stay internal
- **WHEN** brand-studio has the skills `brand-profile` and `release`, and its `messaging.skills` lists `brand-profile`
- **THEN** its card offers `brand-profile` only

#### Scenario: No allowlist
- **WHEN** a project with skills has no `messaging.skills`
- **THEN** its card has `skills: []`

### Requirement: A task can name the skill it asks for
`send_message` SHALL take an optional `skill`, one of the ids the target's card offers; only a task's first message carries it. The receiving installation SHALL decide, after acceptance and before the daily budget:
- a skill it does not offer SHALL end the task `rejected: unknown skill`, and the rejection SHALL list the ids it offers;
- a sender it does not accept SHALL get `not accepted`, as without a skill, and learn nothing about skills.

For a target in the caller's own installation, the tool SHALL refuse at once with the same list and record nothing. The task record on both sides SHALL store the skill, and `/aven asks` SHALL show it. A task with a skill SHALL start its shadow conversation with the skill's slash invocation, `/<skill>`, followed by the plain task frame as its arguments. A release without skills ignores the field and runs a general request.

#### Scenario: Skill offered
- **WHEN** owen-ops asks `bluefin/brand-studio` with `skill: "brand-profile"`, which brand-studio offers it
- **THEN** brand-studio's shadow conversation starts with `/brand-profile` and the task frame, and both task records name the skill

#### Scenario: Skill not offered
- **WHEN** owen-ops names `release`, which brand-studio does not offer
- **THEN** the task ends `rejected: unknown skill`, listing `brand-profile`

#### Scenario: An agent without skills
- **WHEN** owen-ops asks caldora, which offers no skills, once with no skill and once with `skill: "anything"`
- **THEN** the first runs as a general request, as today, and the second is refused as an unknown skill, offering none

## MODIFIED Requirements

### Requirement: Discovery through agent cards
`agents(installation?)` SHALL return the agents of that installation that accept the caller. Without an argument, it SHALL return every installation the caller can reach: the caller's own first, then each peer pinned in `hub.peers.json`, each with its cards or `offline`. That way an agent learns its peers' names from the tool rather than having to guess them; the hub tells nobody who is on it.

Each card SHALL give:
- the agent id;
- the one-line description from its messaging configuration;
- whether the agent would take a new task from the caller now, that is, its daily limit for the caller is not reached;
- `skills`: the skills the agent offers, each with its id, name, description and tags, and its examples when given; `[]` when there are none.

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
- **WHEN** owen-ops calls `agents("bluefin")`, and brand-studio offers the skills `brand-profile` and `site-design`
- **THEN** brand-studio's card lists both skills, each with its name, description, tags and examples from its `SKILL.md`

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
- **WHEN** owen-ops names a skill that the target at a peer does not offer
- **THEN** the task ends `rejected: unknown skill`, and owen-ops is told the skill ids the target offers
