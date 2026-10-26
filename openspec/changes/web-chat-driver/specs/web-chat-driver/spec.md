## Purpose

Lets people reach a project's coding agent through a web chat that the installation serves itself, behind a login, with the Slack feature set and no third-party workspace or tenant in between.

## ADDED Requirements

### Requirement: Web surface
An installation SHALL serve its projects through the web chat as its default surface (web mode) or as an additional surface beside Slack or Teams, and SHALL refuse to start the web surface without its login settings.

#### Scenario: Web mode
- **WHEN** an installation starts in web mode and names no other surface
- **THEN** it serves the web chat and opens no Slack or Teams connection

#### Scenario: Web beside Teams
- **WHEN** a Teams installation names the web as an additional surface
- **THEN** its projects with a room are reachable on the web, and a conversation started on the web stays on the web

#### Scenario: Missing login settings
- **WHEN** web mode starts without its identity provider settings and is not bound to localhost with login explicitly disabled
- **THEN** it refuses to start with an error naming the missing setting

### Requirement: Login and access
Every page, stream and action SHALL require a logged-in user from the configured identity provider. Who may use the chat SHALL be an allow-list of e-mail addresses or identity provider groups; operators listed in the config are admins.

#### Scenario: Not logged in
- **WHEN** a request without a valid session reaches any page or endpoint
- **THEN** pages redirect to login and endpoints answer 401

#### Scenario: Not allowed
- **WHEN** a user logs in successfully but is not on the allow-list
- **THEN** they see an access-denied page and no room

#### Scenario: Forged action
- **WHEN** a state-changing request arrives without the session's CSRF token
- **THEN** it is rejected and nothing changes

### Requirement: Rooms, threads and private conversations
Each project SHALL appear as a room to every allowed user. A top-level post in a room SHALL start a thread and a turn, unless it starts with `!`. Replies in a thread SHALL continue that thread's session. Each user SHALL have one private conversation per project, invisible to others.

#### Scenario: New thread
- **WHEN** a user posts a top-level message in a room
- **THEN** a thread opens with the message, a status entry appears, and the answer arrives in that thread

#### Scenario: Shared view
- **WHEN** two users have the same room open
- **THEN** both see new threads, status updates and answers live

#### Scenario: Private conversation
- **WHEN** a user writes in their private conversation of a project
- **THEN** only that user sees the messages and the answers

#### Scenario: Note
- **WHEN** a post starts with `!`
- **THEN** it is stored and shown, and no turn starts

### Requirement: History
Rooms, threads, private conversations and every bot message, including its final edited state, SHALL be stored by the installation and survive restarts. Opening a room SHALL show its threads newest first; opening a thread SHALL show its full history.

#### Scenario: Reload after restart
- **WHEN** the installation restarts and a user reopens a thread
- **THEN** the thread shows every message and the final state of every status entry

### Requirement: Live status and controls
While a turn is queued or running, its status entry SHALL update live for everyone viewing the thread, with Cancel, Show steps and Restart session. Long and background turns SHALL behave as on Slack.

#### Scenario: Cancel
- **WHEN** a user presses Cancel
- **THEN** the turn is aborted and the status entry says it was canceled for every viewer

#### Scenario: Show steps
- **WHEN** a user presses Show steps
- **THEN** a dialog shows the step trail, live while the turn runs

#### Scenario: Reconnect
- **WHEN** a viewer's connection drops and comes back
- **THEN** the thread catches up to the current state without a page reload

### Requirement: Answers and feedback
Answers SHALL render as sanitized markdown (no raw HTML, only http, https and mailto links), with PR links, Helped / Missed showing a live count, a reason dialog on Missed, and a Session panel.

#### Scenario: Hostile markdown
- **WHEN** an answer contains a `<script>` tag, an `onerror` attribute or a `javascript:` link
- **THEN** it is shown as text or dropped, and no script runs

#### Scenario: Rating
- **WHEN** a user presses Missed
- **THEN** the count updates for every viewer, a dialog asks what went wrong, and one feedback record is written

### Requirement: Agent questions
Agent questions SHALL render with their options, accept single- and multi-select answers and resume the turn. An already answered question SHALL show the answer and accept no second one.

#### Scenario: Answered twice
- **WHEN** a second user submits an already answered question
- **THEN** they are told it was answered and the turn is not affected

### Requirement: Commands
Every `/aven` verb SHALL be available by typing `/<verb> …` in a room or private conversation, with the same arguments, permissions and effects. Replies that are ephemeral on Slack SHALL be visible only to the caller. `/` followed by text that is not a verb SHALL be a private question answered where it was asked, visible only to the caller.

#### Scenario: Status privately
- **WHEN** a user types `/status` in a room
- **THEN** only that user sees the report

#### Scenario: Command list
- **WHEN** a user types `/`
- **THEN** the composer suggests the available verbs

### Requirement: Background deliveries
Routines, dreams, housekeeping, auto-reviews, autofix notices with Fix, YouTrack investigations with the ticket card and dialogs, the held-message card of agent messaging, and ops alerts SHALL be delivered into the project's room with the same content and actions as on Slack. Mentioned users SHALL see the thread highlighted.

#### Scenario: Routine fires
- **WHEN** a routine fires
- **THEN** a new thread with its answer appears in the project's room and replies there continue its session

### Requirement: Files
Users SHALL be able to attach files to a post. Attached files SHALL be passed to the turn as on Slack, within a configured size limit, and a rejected file SHALL be named with the reason.

#### Scenario: Too large
- **WHEN** a user attaches a file above the limit
- **THEN** the post is not sent and the user sees which file is too large

### Requirement: Home page
The web chat SHALL have a Home page listing the user's rooms and the cheat-sheet, built from the same source as the Slack App Home tab.

#### Scenario: Landing
- **WHEN** an allowed user opens the root URL
- **THEN** the Home page shows their rooms and the cheat-sheet

### Requirement: Restart recovery
Turns running or queued when the installation stops SHALL resume after restart and deliver into the original thread.

#### Scenario: Restart mid-turn
- **WHEN** the installation restarts while a turn runs
- **THEN** after boot the turn is reattached or finalized and its answer or error appears in the original thread
