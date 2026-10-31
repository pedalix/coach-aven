# Spec Delta

## ADDED Requirements

### Requirement: A project chooses its image and its privilege
A project's `sandbox.image` SHALL name the image its container is created from; without it the container SHALL use `SANDBOX_IMAGE`. A project's `"dind": true` SHALL make its container privileged docker-in-docker even without `privileged`. A project without a `sandbox` block, or without `dind`, SHALL run as a plain container: no `--privileged`, no runtime flag, no dockerd guard, no Sail paragraph in its prompt.

#### Scenario: A project without a block
- **WHEN** a project has no `sandbox` block
- **THEN** its container is created from `SANDBOX_IMAGE` without `--privileged` or a runtime flag, and no dockerd guard runs for it at chat preparation, in housekeeping or at the idle stop

#### Scenario: Prod's projects
- **WHEN** eleven projects say `"sandbox": { "dind": true }` and `SANDBOX_DIND_RUNTIME=sysbox-runc`
- **THEN** each runs docker-in-docker under sysbox exactly as before the change

#### Scenario: A project with its own image
- **WHEN** a project's block is `{ "dind": true, "image": "registry.example/laravel:1" }`
- **THEN** its container is created privileged from that image, and other projects keep the installation image

### Requirement: The sandbox settings have SANDBOX_ names
The installation SHALL read `SANDBOX_IMAGE`, `SANDBOX_HOST` and `SANDBOX_DIND_RUNTIME`, and SHALL NOT read their retired names (`SNAPSHOT_IMAGE`, `SSHDOCKER_HOST`, `SSHDOCKER_RUNTIME`).

#### Scenario: An installation not yet renamed
- **WHEN** `.env` sets only `SNAPSHOT_IMAGE`
- **THEN** the boot stops naming `SANDBOX_IMAGE`

### Requirement: A privileged sandbox on the bot's machine is confirmed
With `SANDBOX_HOST=local`, when some project resolves to privileged and `SANDBOX_LOCAL_PRIVILEGED` is not `1`, the boot SHALL log one warning saying the container is root-equivalent on the machine that holds the bot's secrets and Docker socket.

#### Scenario: Local mode with plain projects
- **WHEN** `SANDBOX_HOST=local` and every project resolves to `privileged: false`
- **THEN** nothing is logged about privilege
