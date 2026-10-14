# Spec Delta

## Purpose
Deterministic readouts of the attention field over a project's sources store: what is waiting for a reply and what has stopped moving, computed from stored data with no model involvement, so routines can cite them as facts.

## ADDED Requirements

### Requirement: Unanswered inbound messages
The sources MCP SHALL provide an `unanswered` tool that lists inbound messages addressed to a subject that have no later reply from the subject in the same thread within a window.

- The subject is one person (`person`, resolved like `search.person`), a side (`side`: company names and/or person ids from the tenant people file, comma-separated — everyone whose company matches), or by default the account owner(s): the people whose identities are the mail accounts the store was pulled for. The result names the subject it used.
- A message is inbound when it is human (not a bot/integration) and its author is not the subject (for a side: not any member). In person mode it must also be addressed: the subject is a `to` participant (mail recipients, Slack mentions, DM/group members as the pullers record them). In side mode every message in scope counts: the store (allow-listed channels) or the `container` filter is the client scope.
- A message is answered when the subject (any side member) wrote a later message in the same thread, in the same direct conversation, or addressed to the message's author within the same source (a mail reply in any folder, an @mention in the same channel); otherwise it is unanswered. A channel post without thread or mention does not count as an answer; reactions are not stored. The tool description states both limits.
- Filters: `since`/`until` (window on the waiting message, as in `search`; default the last 14 days), `hours` (minimum age, default 24), `container` (name fragment), `source`, `limit` (default 50).
- One row per conversation (a direct container, else the thread): the oldest waiting message with `ref`, `source`, `container`, `author`, `to`, `ts`, `ageHours`, `pending` (waiting messages in that conversation, with `lastInboundTs`), `thread` (id, first/last ts, n), `subject`, `snippet`, `permalink`.

#### Scenario: A client question with no reply
- **WHEN** a message in a client channel from a non-member of the side is older than `hours` and no later message in its thread is authored by a side member
- **THEN** the row is returned with `ageHours` computed from the message ts to now and the thread summary

#### Scenario: Replied inbound message
- **WHEN** a later message in the same thread is authored by the subject (or any side member)
- **THEN** the message is not returned, even if the reply is shorter than the window

#### Scenario: Sent Items are never inbound
- **WHEN** the message's author is the subject
- **THEN** the message is not returned

#### Scenario: Side mode counts the agent's reply
- **WHEN** `side` names a company and the people file lists the project's agent under that company
- **THEN** a message answered by the agent in its thread is not returned, and a message no side member answered is

### Requirement: Stuck open tasks
The sources MCP SHALL provide a `stuck` tool that lists open tracker tasks whose last update is older than N days.

- Open = status category `todo` or `doing`, not deleted. Last activity = `updated`, or the newest comment timestamp when later. Filters: `days` (default 5), `project`, `status` (category or exact name), `assignee` (via people), `source`, `limit` (default 100; `truncated` flags a cut list).
- Rows are grouped by project then status, stalest first, and carry `ref`, `source`, `key`, `title`, `status`, `assignee`, `updated`, `lastActivity`, `daysSinceUpdate`, `due`, `url`.
- The tool states its limit in its description: age is since the last update of any kind, not time in the current status.

#### Scenario: Ticket without movement
- **WHEN** an open task's `updated` is older than `days` days
- **THEN** the task is returned under its project and status with `daysSinceUpdate`

#### Scenario: Recently commented ticket
- **WHEN** a comment was added inside the window (even if the tracker's `updated` did not move)
- **THEN** the task is not returned

### Requirement: Readouts are cited as data
`SOURCES_PROMPT_PARAGRAPH` SHALL name `unanswered` and `stuck` as the source of "waiting for reply" and "not moving" lists, so a routine quotes their rows (with permalinks) instead of reconstructing them from `search`/`tasks`.

#### Scenario: Brief lists what is waiting
- **WHEN** a routine reports unanswered items
- **THEN** every item cites a `permalink` returned by `unanswered`
