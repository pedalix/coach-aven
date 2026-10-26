## Purpose

Lets people reach a project's coding agent from Microsoft Teams with the Slack feature set mapped to Teams, through an installation that runs the Teams chat driver.

## ADDED Requirements

### Requirement: Teams mode
An installation started in Teams mode SHALL serve its registry's projects, including background jobs, through Teams only.

#### Scenario: Teams mode
- **WHEN** an installation starts in Teams mode
- **THEN** it serves its projects through Teams and opens no Slack connection

#### Scenario: Missing Teams settings
- **WHEN** Teams mode starts without its app id, secret or tenant id
- **THEN** it refuses to start with an error naming the missing setting

### Requirement: Single tenant and authenticated requests
A Teams installation SHALL accept activities only from its configured Microsoft Entra tenant and only with a valid Bot Framework token. Guests of that tenant SHALL be treated like members.

#### Scenario: Other tenant
- **WHEN** someone in a different tenant messages the bot
- **THEN** the request is rejected, no turn starts, and the rejection is logged once with the tenant id

#### Scenario: Forged request
- **WHEN** a request reaches the endpoint without a valid Bot Framework token
- **THEN** it is answered 401 and nothing else happens

#### Scenario: Guest user
- **WHEN** a guest of the host tenant mentions the bot in a bound channel and is allowed to drive it
- **THEN** the turn runs as for a member

### Requirement: Channel binding
A Teams channel SHALL map to a project only through an explicit channel id in the project registry. A mention in an unbound channel SHALL get a short reply saying the channel is not connected, and no turn.

#### Scenario: Bound channel
- **WHEN** a project declares a Teams channel id and a user mentions the bot there
- **THEN** the turn runs in that project's sandbox

#### Scenario: Unbound channel
- **WHEN** a user mentions the bot in a channel no project declares
- **THEN** the bot replies that the channel is not connected and starts no turn

### Requirement: Conversations map to sessions
Each Teams channel thread SHALL be one Claude session. Replies in a thread the bot is part of SHALL continue the session without a new mention when the team granted channel-message consent; without it, only replies that mention the bot SHALL reach it. Each 1:1 chat SHALL be one session per project. A message starting with `!` SHALL start no turn.

#### Scenario: Thread follow-up with consent
- **WHEN** a user replies without a mention in a thread the bot answered and consent is granted
- **THEN** the turn resumes the same session

#### Scenario: Thread follow-up without consent
- **WHEN** consent is not granted
- **THEN** a reply without a mention is not seen, a reply with a mention resumes the session, and the help text explains the difference

#### Scenario: Personal chat picker
- **WHEN** a user writes in a 1:1 chat with no project chosen and the installation serves several projects
- **THEN** the bot shows a project picker; with exactly one project it answers directly

#### Scenario: Note
- **WHEN** a message starts with `!`
- **THEN** no turn starts and the bot posts nothing

### Requirement: Live status and controls
While a turn is queued or running, the bot SHALL show one status card, updated in place within Teams' rate limits, with Cancel, Show steps and Restart session. Long and background turns SHALL behave as on Slack: the card turns into a background card and the answer arrives as a new message.

#### Scenario: Queued
- **WHEN** a second message arrives in a thread whose turn is running
- **THEN** its status card says it is in queue and it runs after the first settles

#### Scenario: Cancel
- **WHEN** a user presses Cancel
- **THEN** the turn is aborted and the card says it was canceled

#### Scenario: Show steps
- **WHEN** a user presses Show steps on a running or finished turn
- **THEN** a dialog shows the step trail, marked as still running when it is

#### Scenario: Update throttling
- **WHEN** the agent streams many steps per second
- **THEN** the card is updated no more often than the configured minimum interval and the final state is always shown

### Requirement: Answers and feedback
The answer SHALL arrive in the same conversation in Teams-supported formatting, split without losing text when too long, with PR links, Helped / Missed buttons showing a live count, a reason dialog on Missed, and a Session panel action.

#### Scenario: Long answer
- **WHEN** the answer exceeds one message
- **THEN** it arrives as consecutive messages whose concatenated text equals the answer

#### Scenario: Rating
- **WHEN** a user presses Missed
- **THEN** the count on the button updates for everyone, a dialog asks what went wrong, and one feedback record is written

#### Scenario: Turn error
- **WHEN** the turn fails
- **THEN** the card shows the same error text Slack would show

### Requirement: Agent questions
Agent questions SHALL render as a card with the options, accept single- and multi-select answers, and resume the turn. A stale or already answered card SHALL say so.

#### Scenario: Answered twice
- **WHEN** a second user submits a question card that was already answered
- **THEN** the bot says it was already answered and the turn is not affected

### Requirement: Commands
Every `/aven` verb SHALL be available in Teams as a command message (`@Aven /<verb> …` in channels, `/<verb> …` in 1:1 chats) with the same arguments, permissions and effects. Replies that are ephemeral on Slack SHALL be visible only to the invoking user: as a targeted message where available, otherwise in the user's 1:1 chat with a pointer in the channel.

#### Scenario: Status privately
- **WHEN** a user sends `@Aven /status` in a project channel
- **THEN** only that user sees the status report

#### Scenario: Private question
- **WHEN** a user sends `@Aven /why is the build red?`, whose first word is not a known verb
- **THEN** it runs as a private question and the answer arrives in the user's 1:1 chat with the bot, as the Slack `/aven <question>` does

#### Scenario: Help
- **WHEN** a user sends `/help`
- **THEN** the bot replies with the command list

### Requirement: Background deliveries
Scheduled routines, dreams, housekeeping reports, auto-reviews, autofix notices with the Fix button, YouTrack investigations with the ticket card, Full ticket and Report-to-YouTrack dialogs, and ops alerts SHALL be delivered into the bound Teams channel of their project, with the same content and actions as on Slack.

#### Scenario: Routine fires
- **WHEN** a routine's schedule fires
- **THEN** a new thread with the routine's answer appears in the project's channel and replies there continue its session

#### Scenario: YouTrack ticket
- **WHEN** a tagged ticket is picked up
- **THEN** the ticket card and the investigation appear in a new thread, the configured owners are mentioned, and Report to YouTrack opens a dialog

### Requirement: Files
Files shared with a message SHALL be passed to the turn as on Slack: images and documents in 1:1 chats, pasted images and attached documents in channels. A file the bot cannot read SHALL be named in a reply with the reason.

#### Scenario: Document in a channel thread
- **WHEN** a user attaches a PDF to a thread reply
- **THEN** the turn receives the file in the sandbox

### Requirement: Access control
Who may drive the agent SHALL follow the Slack rules with Teams identities: open by default, an allow-list managed with `/users`, admins being the installation's operators and the owners of the bound team.

#### Scenario: Restricted
- **WHEN** the allow-list is active and a user who is not on it mentions the bot
- **THEN** no turn starts and the user privately gets the same denial text as on Slack

### Requirement: Home card
The bot SHALL send a Home card (projects, their channels, the cheat-sheet) on personal install and on `/home`, built from the same source as the Slack App Home tab, with Teams-specific wording where the mechanism differs.

#### Scenario: First contact
- **WHEN** a user installs the app in personal scope
- **THEN** the Home card arrives once

### Requirement: Restart recovery
Turns running or queued when a Teams installation stops SHALL resume after restart and deliver into the original Teams conversation and thread.

#### Scenario: Restart mid-turn
- **WHEN** the installation restarts while a turn runs
- **THEN** after boot the turn is reattached or finalized and its answer or error lands in the original thread

#### Scenario: Queued message survives
- **WHEN** the installation restarts while a message waits in the queue
- **THEN** it runs after boot and its answer lands in the original thread
