# Spec Delta

## Purpose
Deterministic readouts of the attention field over a project's sources store: what is waiting for a reply and what has stopped moving, computed from stored data with no model involvement, so routines can cite them as facts.

## ADDED Requirements

### Requirement: Unanswered inbound messages
The sources MCP SHALL provide an `unanswered` tool that lists inbound messages addressed to a subject that have no later reply from the subject in the same thread within a window.

- The subject is a person id (resolved like `search.person`) or a side: `side` = the tenant's own people (every person whose company is one of the tenant's companies, from the tenant people file); the default subject is the mailbox/account owner.
- A message is inbound when its author is not the subject (for a side: not any member of the side) and the subject is addressed: present in `participants`/`to`, mentioned, or the container is a direct conversation with the subject; for a side, any message in a container the tenant marks as a client container counts.
- A message is answered when a later message in the same thread is authored by the subject (any member of the side); otherwise it is unanswered. Bot/integration messages are never inbound.
- Filters: `since`/`until` (window as in `search`), `hours` (minimum age, default 24), `container`, `source`, `limit` (default 50).
- Each row carries `ref`, `source`, `container`, `author`, `ts`, `ageHours`, `thread` (first/last ts, n), `snippet`, `permalink`.

#### Scenario: A client question with no reply
- **WHEN** a message in a client channel from a non-member of the side is older than `hours` and no later message in its thread is authored by a side member
- **THEN** the row is returned with `ageHours` computed from the message ts to now (local day zone) and the thread summary

#### Scenario: Replied inbound message
- **WHEN** a later message in the same thread is authored by the subject (or any side member)
- **THEN** the message is not returned, even if the reply is shorter than the window

#### Scenario: Sent Items are never inbound
- **WHEN** the message's author is the subject
- **THEN** the message is not returned

### Requirement: Stuck open tasks
The sources MCP SHALL provide a `stuck` tool that lists open tracker tasks whose last update is older than N days.

- Open = status category `todo` or `doing`, not deleted. Filters: `days` (default 5), `project`, `status`, `assignee`, `source`, `limit` (default 100).
- Rows are grouped by project then status and carry `ref`, `key`, `title`, `status`, `assignee`, `updated`, `daysSinceUpdate`, `due`, `url`.
- The tool states its limit in its description: age is since the last update of any kind, not time in the current status.

#### Scenario: Ticket without movement
- **WHEN** an open task's `updated` is older than `days` days
- **THEN** the task is returned under its project and status with `daysSinceUpdate`

#### Scenario: Recently commented ticket
- **WHEN** a comment was added inside the window (which advances `updated`)
- **THEN** the task is not returned

### Requirement: Readouts are cited as data
`SOURCES_PROMPT_PARAGRAPH` SHALL name `unanswered` and `stuck` as the source of "waiting for reply" and "not moving" lists, so a routine quotes their rows (with permalinks) instead of reconstructing them from `search`/`tasks`.

#### Scenario: Brief lists what is waiting
- **WHEN** a routine reports unanswered items
- **THEN** every item cites a `permalink` returned by `unanswered`
