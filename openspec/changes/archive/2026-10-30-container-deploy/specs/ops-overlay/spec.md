# Spec Delta

## MODIFIED Requirements

### Requirement: The overlay names the chat driver the service runs
`deploy.env` SHALL name the installation's chat driver (`CHAT_DRIVER`, one of the build's drivers; absent = `slack`). On a systemd installation `deploy.sh install` SHALL render that driver into the service unit's run command. On a compose installation it SHALL be the bot container's command. Either way, the deploy health check SHALL wait for that driver's "bot running" line.

#### Scenario: Default stays Slack
- **WHEN** an overlay's `deploy.env` has no `CHAT_DRIVER`
- **THEN** the rendered unit runs `orch slack` exactly as before and the health check waits for `Slack bot running`

#### Scenario: Teams installation
- **WHEN** `deploy.env` says `CHAT_DRIVER=teams` and `install` then `deploy` run
- **THEN** the unit runs `orch teams` and the deploy reports healthy once `Teams bot running` appears in the journal

#### Scenario: Unknown driver
- **WHEN** `CHAT_DRIVER` names a driver the build does not have
- **THEN** `install` exits non-zero naming the drivers available

#### Scenario: Compose installation
- **WHEN** `deploy.env` says `RUNTIME=compose` and `CHAT_DRIVER=teams`
- **THEN** the bot container runs `orch teams` and the deploy reports healthy once `Teams bot running` appears in the bot's log

## ADDED Requirements

### Requirement: The overlay names the runtime
`deploy.env` SHALL name how the installation runs: `RUNTIME=systemd`, the default when the key is absent (the systemd unit and the tar deploy), or `RUNTIME=compose` (`container-deploy`). When `RUNTIME` has any other value, every `deploy.sh` command SHALL exit non-zero, naming the two values.

#### Scenario: No runtime named
- **WHEN** an overlay's `deploy.env` has no `RUNTIME`
- **THEN** `install`, `deploy` and the other commands do exactly what they did before this setting existed

#### Scenario: Compose
- **WHEN** `deploy.env` says `RUNTIME=compose`
- **THEN** `install` prepares the box's deploy command, and `deploy` takes a version and uploads nothing

#### Scenario: Unknown runtime
- **WHEN** `deploy.env` says `RUNTIME=docker`
- **THEN** every command exits non-zero and names `systemd` and `compose`

### Requirement: The overlay marks a canary installation
`deploy.env` SHALL mark a canary installation with `CANARY=1`. Only an installation marked this way SHALL accept a `main` commit's image, from `deploy.sh` and from the ops workflow alike.

#### Scenario: Canary
- **WHEN** `deploy.env` says `CANARY=1` and `deploy.sh <slug> deploy sha-<commit>` runs
- **THEN** that commit's image is deployed

#### Scenario: Release installation
- **WHEN** `deploy.env` has no `CANARY` and a `sha-<commit>` deploy is requested
- **THEN** the deploy is refused before anything changes on the box
