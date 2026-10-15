# Spec Delta

## Purpose
Lets a project's Slack source read a workspace through the CoachAven app's own bot identity, so a tenant's store is scoped by what the tenant let the bot see, not by a person's membership.

## ADDED Requirements

### Requirement: Bot token pulls
A stored workspace entry MAY carry a bot token; with it the puller SHALL read every conversation the bot is a member of, subject to the project's allow-list, and SHALL never read direct messages.

#### Scenario: Invited to a private channel
- **WHEN** the bot was invited to a private channel listed in `channels`
- **THEN** its history is pulled like any other conversation

#### Scenario: Not a member
- **WHEN** a listed private channel has not invited the bot
- **THEN** nothing is pulled from it and the run log names it as unreadable

### Requirement: Joining public channels
With a bot token the puller SHALL join a listed public channel it is not yet a member of before reading it; with `joinPublic: true` it SHALL join every public channel of the workspace.

#### Scenario: Listed public channel
- **WHEN** `channels` names a public channel the bot is not in
- **THEN** the bot joins it (logged) and pulls it in the same run

### Requirement: User tokens unchanged
A user-token entry SHALL behave exactly as before this change.

#### Scenario: Existing store
- **WHEN** the token store holds only user tokens
- **THEN** no join is attempted and the pulled set is unchanged
