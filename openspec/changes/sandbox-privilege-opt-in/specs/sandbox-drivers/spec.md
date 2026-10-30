# Spec Delta

## ADDED Requirements

### Requirement: A project chooses its image and its privilege
A project's `sandbox.image` SHALL name the image its container is created from; without it the container SHALL use `SANDBOX_IMAGE`. A project's `"dind": true` SHALL make its container privileged docker-in-docker even without `privileged`. While a project has no `sandbox` block it SHALL run as privileged docker-in-docker as before, and the boot SHALL log one warning naming such projects and the `"dind": true` fix.

#### Scenario: Today's prod configuration
- **WHEN** eleven projects have no `sandbox` block
- **THEN** each runs privileged docker-in-docker from `SANDBOX_IMAGE` exactly as before, and the boot logs one warning naming the eleven slugs

#### Scenario: A project with its own image
- **WHEN** a project's block is `{ "dind": true, "image": "registry.example/laravel:1" }`
- **THEN** its container is created privileged from that image, and other projects keep the installation image

### Requirement: The sandbox settings have SANDBOX_ names
The installation SHALL read `SANDBOX_IMAGE`, `SANDBOX_HOST` and `SANDBOX_DIND_RUNTIME`. When a new name is unset, its old name (`SNAPSHOT_IMAGE`, `SSHDOCKER_HOST`, `SSHDOCKER_RUNTIME`) SHALL be read in its place, and the boot SHALL log one line naming the old names in use.

#### Scenario: An installation not yet renamed
- **WHEN** `.env` sets only `SNAPSHOT_IMAGE` and `SSHDOCKER_HOST`
- **THEN** the bot runs as before and logs one line naming both with their new names

### Requirement: A privileged sandbox on the bot's machine is confirmed
With `SANDBOX_HOST=local`, when some project resolves to privileged and `SANDBOX_LOCAL_PRIVILEGED` is not `1`, the boot SHALL log one warning saying the container is root-equivalent on the machine that holds the bot's secrets and Docker socket.

#### Scenario: Local mode with plain projects
- **WHEN** `SANDBOX_HOST=local` and every project resolves to `privileged: false`
- **THEN** nothing is logged about privilege
