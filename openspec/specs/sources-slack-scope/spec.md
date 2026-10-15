# sources-slack-scope Specification

## Purpose
Bounds which Slack conversations a project's sources store may contain, so a tenant store never holds conversations outside its tenant boundary.

## Requirements

### Requirement: Channel allow-list
When `sources.slack.channels` is set, the puller SHALL read only the listed conversations (by name or id) and skip every other conversation the token can see, including direct messages, unless a direct conversation is listed by id.

#### Scenario: Scoped tenant store
- **WHEN** `channels: ["bluefin-aven-caldora", "C0BBX082QNQ"]` is configured
- **THEN** a pull writes records only for those two conversations and the cursor file has entries only for them

#### Scenario: Unlisted conversation
- **WHEN** the user is a member of a channel not in the list
- **THEN** no record of it is written and `--verbose` logs it as skipped once per run

### Requirement: Conversation kinds filter
When `sources.slack.kinds` is set, the puller SHALL read only conversations of the listed kinds (`channel`, `group`, `im`, `mpim`); absent, every kind is read.

#### Scenario: Channels only
- **WHEN** `kinds: ["channel", "group"]` is configured
- **THEN** direct and group direct messages are not pulled

### Requirement: Default unchanged
With neither key set, the puller SHALL behave exactly as before: every conversation the user is a member of.

#### Scenario: Existing project config
- **WHEN** a project has a `slack` block without `channels`/`kinds`
- **THEN** the pulled set is unchanged from the previous release
