# sandbox-drivers Specification

## Purpose
Which driver runs a project's sandbox, how an installation selects it, what a setting that names another driver does, and what `/aven status` says about the sandboxes. ssh-docker is the only driver, and the bot never moves a project to another sandbox on a guess.

## Requirements

### Requirement: ssh-docker runs every sandbox
The bot SHALL run every project's sandbox on the ssh-docker driver: a long-lived container on the Docker host that `SANDBOX_HOST` names. `SANDBOX_DRIVER` and a project's `driver` field SHALL be optional, and `ssh-docker` SHALL be the only value either one takes; an empty `SANDBOX_DRIVER` SHALL count as unset, and a `null` field as absent. Setting either one to `ssh-docker`, or leaving both unset, SHALL give the same sandbox: the same container name, image and flags.

#### Scenario: Every setting names ssh-docker
- **WHEN** an installation sets `SANDBOX_DRIVER=ssh-docker` and every project in its configuration has `"driver": "ssh-docker"`
- **THEN** the bot starts, and every project's sandbox is created from `SANDBOX_IMAGE` on the host that `SANDBOX_HOST` names, then woken and driven over ssh-docker

#### Scenario: Nothing names a driver
- **WHEN** neither `SANDBOX_DRIVER` nor a project's `driver` is set
- **THEN** the project's sandbox runs on ssh-docker
- **AND** without `SANDBOX_HOST`, the project's first use of its sandbox fails with an error naming `SANDBOX_HOST`

### Requirement: A driver other than ssh-docker is a configuration error
A non-empty `SANDBOX_DRIVER` other than `ssh-docker` SHALL stop the bot at boot with one sentence: the value, that the Daytona driver was removed after v0.42.0, and that ssh-docker is the only sandbox driver. A project's `driver` other than `ssh-docker` SHALL fail the projects configuration with the same words and the project's name, like any invalid project setting: the boot SHALL fail, and `/aven reload` SHALL keep the previous configuration, never running the project on another driver.

#### Scenario: SANDBOX_DRIVER still names Daytona
- **WHEN** the bot starts with `SANDBOX_DRIVER=daytona`
- **THEN** it does not start, and its error reads `SANDBOX_DRIVER=daytona: the Daytona driver was removed after v0.42.0; ssh-docker is the only sandbox driver`

#### Scenario: A project names Daytona
- **WHEN** the projects configuration gives project `acme-shop` `"driver": "daytona"`, at boot or at `/aven reload`
- **THEN** the load fails with an error that names `acme-shop` and its `driver` value
- **AND** at boot the bot does not start, a reload keeps the previous configuration active, and the `orch sources` commands refuse it in the same words

#### Scenario: A misspelt driver
- **WHEN** a project has `"driver": "ssh-dokcer"`
- **THEN** the configuration is refused with an error naming the project, and the project is not run on any driver in its place

### Requirement: Settings only the removed driver read change nothing
The settings that only the Daytona driver or its SDK read — every variable whose name starts with `DAYTONA_`, `SNAPSHOT_NAME`, `SANDBOX_CPU`, `SANDBOX_MEMORY` and `SANDBOX_DISK` — SHALL change nothing, and the bot SHALL NOT warn about them. `SANDBOX_AUTOSTOP_MINUTES` is not one of them: it SHALL keep setting the idle stop of ssh-docker containers (capability `sandbox-idle-stop`).

#### Scenario: Leftover Daytona keys
- **WHEN** the bot starts with `SANDBOX_DRIVER=ssh-docker` and `DAYTONA_API_URL`, `SNAPSHOT_NAME` and `SANDBOX_CPU` still set
- **THEN** it starts with the same configuration as without them, and logs nothing about them

#### Scenario: A leftover URL without SANDBOX_DRIVER
- **WHEN** the bot starts with `DAYTONA_API_URL` set and `SANDBOX_DRIVER` unset
- **THEN** every project without a `driver` field runs on ssh-docker

### Requirement: The status report names sandboxes, not a provider
`/aven status` SHALL report whether the sandbox listing answered, under a name that is not a provider's: on Slack "Sandboxes", as the Teams status card already says "sandboxes". A listing whose Docker host cannot be reached, or whose command exits non-zero, SHALL count as a failed listing, not as an empty one: each project's sandbox SHALL then read as unknown, never as not created.

#### Scenario: The sandbox host cannot be reached
- **WHEN** `/aven status` runs on Slack and the sandbox listing fails: its Docker host cannot be reached, or the listing exits non-zero
- **THEN** the health line reads `Sandboxes ⚠️`, followed by the GitHub and Slack flags as before
- **AND** each project's sandbox reads `unknown`, not `not created`

#### Scenario: The listing answers
- **WHEN** `/aven status` runs on Slack and the sandbox listing answers
- **THEN** the health line reads `Sandboxes ✅`
- **AND** each project shows its sandbox as started, stopped or not created, as before

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
