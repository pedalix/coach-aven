# Spec Delta

## MODIFIED Requirements

### Requirement: One chat driver per installation
An installation SHALL run one *default* chat driver for people, chosen by its run mode, and MAY run additional chat drivers named in its configuration; each running driver is a *surface*. The installation SHALL NOT open connections or listeners of a driver that is neither its default nor configured. The shadow driver of `agent-messaging` serves no people and opens no connection or listener. It MAY run beside the chat drivers for conversations with an `a2a:` key, after the tenant prefix.

#### Scenario: Slack mode
- **WHEN** an installation starts with `orch slack` and names no additional surface
- **THEN** it connects to Slack exactly as before and opens no other chat listener

#### Scenario: Unknown driver
- **WHEN** an installation is started with a run mode for a driver that does not exist, or names an unknown driver as an additional surface
- **THEN** it exits with an error listing the available drivers

#### Scenario: Shadow conversations beside Slack
- **WHEN** a Slack installation answers a task from another agent
- **THEN** the turn renders through the shadow driver, and the installation still has exactly one chat connection

#### Scenario: Two surfaces
- **WHEN** an installation starts with `orch teams` and names `slack` as an additional surface
- **THEN** it serves people on Teams and on Slack over one turn engine, one set of pollers and one agent-messaging identity, and a project bound on both is reachable from both

#### Scenario: A surface that cannot start
- **WHEN** an additional surface's settings are missing or its connection is refused at boot
- **THEN** the installation exits with an error naming that surface and what it lacks, and starts no surface at all

## ADDED Requirements

### Requirement: A conversation belongs to one surface
Every conversation SHALL belong to the surface it started on, for its whole life: its session, its queued turns, its recovery after a restart, its private replies and its agent-messaging answers SHALL render through that surface's driver. Conversations of the default surface SHALL keep the key shapes of a single-driver installation unchanged; conversations of an additional surface SHALL carry the surface in their key.

#### Scenario: Default surface keys unchanged
- **WHEN** an installation that ran one driver gains an additional surface
- **THEN** every conversation, routine and binding recorded before still resolves to the default surface without migration

#### Scenario: Restart with conversations on two surfaces
- **WHEN** the installation restarts while a turn runs on each surface
- **THEN** each turn is reattached or finalized and its answer or error appears in its own conversation on its own surface

#### Scenario: Answer from another agent
- **WHEN** a conversation on an additional surface asked another installation's agent and the answer arrives after a restart
- **THEN** the answer is delivered into that conversation on that surface

### Requirement: Projects and background deliveries across surfaces
A project SHALL be reachable from every surface where it is bound, with one sandbox serving all of them. A routine SHALL deliver on the surface and into the conversation it was created from. Deliveries that no conversation started — auto-reviews, autofix notices, ticket investigations, operator alerts — SHALL go to the project's channel on its default surface, or on every surface the project names for deliveries.

#### Scenario: One project, two surfaces
- **WHEN** people start a thread with a project on Teams and another on Slack
- **THEN** both threads run in the project's one sandbox as separate sessions, and `/status` on either surface lists both

#### Scenario: Routine created on an additional surface
- **WHEN** a routine scheduled from a conversation on an additional surface fires
- **THEN** it posts into that conversation's channel on that surface, and nowhere else

#### Scenario: Review delivery
- **WHEN** an auto-review of a project bound on two surfaces finishes and the project names both surfaces for deliveries
- **THEN** the review appears in the project's channel on each surface; without that setting it appears on the default surface only

### Requirement: Identities, access and operators are per surface
A person's identity, the access gate that decides whether they may drive a project, the operators list, the command prefix, the Home surface and the alert channel SHALL be those of the surface a request arrives on. Access granted on one surface SHALL NOT grant anything on another.

#### Scenario: Allow-list on one surface
- **WHEN** an operator allows a person on Teams
- **THEN** the same person is not allowed on Slack until an operator allows them there

#### Scenario: Private reply on the right surface
- **WHEN** a person types a command in a conversation on an additional surface
- **THEN** the ephemeral reply reaches only them, on that surface, in that surface's form
