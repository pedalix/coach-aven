# Spec Delta

## RENAMED Requirements
- FROM: `### Requirement: An installation moves by a documented checklist, and can move back until the old code is removed`
- TO: `### Requirement: An installation on the systemd deploy of an earlier release moves by a documented checklist`

## MODIFIED Requirements

### Requirement: An installation on the systemd deploy of an earlier release moves by a documented checklist
A compose deploy SHALL refuse while the installation's systemd unit is active. The move from the systemd deploy of v0.43.0 or earlier SHALL be documented as a checklist: stop and disable the units and remove their files by hand, install, deploy the version the box ran, rewrite the scheduled job, and remove the old code last. The documentation SHALL list what the cleanup removes, which SHALL be the code only, never configuration or state, and SHALL say that there is no way back: v0.43.0 is the last release whose tooling installs or deploys the unit.

#### Scenario: Unit still active
- **WHEN** `deploy` runs on a box whose bot unit is active
- **THEN** it refuses and names the command that stops the unit

#### Scenario: Moving back before cleanup
- **WHEN** an operator wants the unit back after the first compose deploy
- **THEN** nothing in this release's tooling does it — the checklist removed the unit files in its first step, `RUNTIME=systemd` refuses naming v0.43.0, and that release's tooling is the only way to run the unit again

#### Scenario: What the cleanup removes
- **WHEN** the operator runs the documented cleanup command
- **THEN** `src/`, `node_modules/`, `package.json` and the rest of the old code are gone, and `.env`, `state.json`, `data/`, `compose/` and the other configuration and state stay
