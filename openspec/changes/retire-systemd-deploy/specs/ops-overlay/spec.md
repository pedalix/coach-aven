# Spec Delta

## RENAMED Requirements
- FROM: `### Requirement: The overlay names the runtime`
- TO: `### Requirement: The overlay has one runtime`

## MODIFIED Requirements

### Requirement: The overlay names the chat driver the service runs
`deploy.env` SHALL name the installation's chat driver (`CHAT_DRIVER`, one of the build's drivers; absent = `slack`). `deploy.sh install` SHALL render that driver into the bot container's command, and the deploy health check SHALL wait for that driver's "bot running" line.

#### Scenario: Default stays Slack
- **WHEN** an overlay's `deploy.env` has no `CHAT_DRIVER`
- **THEN** the bot container runs `orch slack` and the health check waits for `Slack bot running`

#### Scenario: Teams installation
- **WHEN** `deploy.env` says `CHAT_DRIVER=teams` and `install` then `deploy` run
- **THEN** the bot container runs `orch teams` and the deploy reports healthy once `Teams bot running` appears in the bot's log

#### Scenario: Unknown driver
- **WHEN** `CHAT_DRIVER` names a driver the build does not have
- **THEN** `install` exits non-zero naming the drivers available

#### Scenario: Compose installation
- **WHEN** `deploy.env` says `CHAT_DRIVER=teams`, with or without a leftover `RUNTIME=compose`
- **THEN** the bot container runs `orch teams` and the deploy reports healthy once `Teams bot running` appears in the bot's log

### Requirement: The overlay has one runtime
The overlay SHALL name no runtime: the published image under Docker Compose (`container-deploy`) is the only one, and the `RUNTIME` key is retired. A leftover `RUNTIME=compose` SHALL be accepted. `RUNTIME=systemd` SHALL make every `deploy.sh` command exit non-zero with a sentence naming the last release whose tooling had that path (v0.43.0) and the move checklist. Any other value SHALL make every command exit non-zero, naming `compose`.

#### Scenario: No runtime named
- **WHEN** an overlay's `deploy.env` has no `RUNTIME`
- **THEN** `install` renders the compose file, and `deploy` takes a version and uploads nothing

#### Scenario: Compose
- **WHEN** `deploy.env` says `RUNTIME=compose`
- **THEN** every command behaves exactly as with no `RUNTIME`

#### Scenario: The retired runtime
- **WHEN** `deploy.env` says `RUNTIME=systemd`
- **THEN** every command exits non-zero, names v0.43.0 and points at the move checklist

#### Scenario: Unknown runtime
- **WHEN** `deploy.env` says `RUNTIME=docker`
- **THEN** every command exits non-zero and names `compose`
