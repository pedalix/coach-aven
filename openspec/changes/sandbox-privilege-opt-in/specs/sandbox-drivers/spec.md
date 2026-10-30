# Spec Delta

## ADDED Requirements

### Requirement: A project's privilege is an explicit choice
The installation SHALL read `SANDBOX_DEFAULT` (`dind` or `plain`) as the sandbox options of a project without a `sandbox` block. A project's own block SHALL win field by field. Any other value SHALL stop the boot naming the setting. While `SANDBOX_DEFAULT` is unset, a project without a block SHALL resolve as today (privileged docker-in-docker), and the boot SHALL log one warning naming those projects and both ways to choose.

#### Scenario: Today's prod configuration
- **WHEN** `SANDBOX_DEFAULT` is unset and eleven projects have no `sandbox` block
- **THEN** each resolves to privileged docker-in-docker exactly as before, and the boot logs one warning naming the eleven slugs

#### Scenario: Chosen plain default
- **WHEN** `SANDBOX_DEFAULT=plain` and a project has no `sandbox` block
- **THEN** its container runs without `--privileged` and without a runtime flag, no dockerd guard runs for it at chat preparation, in housekeeping or at the idle stop, its prompt has no Sail paragraph, and nothing is logged about it

#### Scenario: A docker-in-docker block under a plain default
- **WHEN** `SANDBOX_DEFAULT=plain` and a project's block is `{ "dind": true }`
- **THEN** the project resolves to privileged docker-in-docker and the boot goes on

### Requirement: A privileged sandbox names its runtime
When some project resolves to privileged and `SSHDOCKER_RUNTIME` is unset, the boot SHALL log one warning naming `sysbox-runc` and `privileged`. The container SHALL run as before.

#### Scenario: A chosen runtime
- **WHEN** `SSHDOCKER_RUNTIME=sysbox-runc` is set
- **THEN** no runtime warning is logged

### Requirement: A privileged sandbox on the bot's machine is confirmed
With `SSHDOCKER_HOST=local`, when some project resolves to privileged and `SANDBOX_LOCAL_PRIVILEGED` is not `1`, the boot SHALL log one warning saying the container is root-equivalent on the machine that holds the bot's secrets and Docker socket.

#### Scenario: Local mode with plain projects
- **WHEN** `SSHDOCKER_HOST=local` and every project resolves to `privileged: false`
- **THEN** nothing is logged about privilege
