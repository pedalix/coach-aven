## MODIFIED Requirements

### Requirement: One chat driver per installation
An installation SHALL run exactly one chat driver for people, chosen by its run mode, and SHALL NOT open connections or listeners of any other chat driver. The shadow driver of `agent-messaging` serves no people and opens no connection or listener. It MAY run beside the chat driver for conversations with an `a2a:` key, after the tenant prefix.

#### Scenario: Slack mode
- **WHEN** an installation starts with `orch slack`
- **THEN** it connects to Slack exactly as before and opens no other chat listener

#### Scenario: Unknown driver
- **WHEN** an installation is started with a run mode for a driver that does not exist
- **THEN** it exits with an error listing the available drivers

#### Scenario: Shadow conversations beside Slack
- **WHEN** a Slack installation answers a task from another agent
- **THEN** the turn renders through the shadow driver, and the installation still has exactly one chat connection
