# Spec Delta

## ADDED Requirements

### Requirement: The overlay names the chat driver the service runs
`deploy.env` SHALL name the installation's chat driver (`CHAT_DRIVER`, one of the build's drivers; absent = `slack`); `deploy.sh install` SHALL render that driver into the service unit's run command, and the deploy health check SHALL wait for that driver's "bot running" line.

#### Scenario: Default stays Slack
- **WHEN** an overlay's `deploy.env` has no `CHAT_DRIVER`
- **THEN** the rendered unit runs `orch slack` exactly as before and the health check waits for `Slack bot running`

#### Scenario: Teams installation
- **WHEN** `deploy.env` says `CHAT_DRIVER=teams` and `install` then `deploy` run
- **THEN** the unit runs `orch teams` and the deploy reports healthy once `Teams bot running` appears in the journal

#### Scenario: Unknown driver
- **WHEN** `CHAT_DRIVER` names a driver the build does not have
- **THEN** `install` exits non-zero naming the drivers available
