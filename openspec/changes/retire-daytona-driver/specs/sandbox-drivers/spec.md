## Purpose

Which driver runs a project's sandbox, how an installation selects it, and what the bot does with a setting for a driver it no longer has. Such a setting is refused with the fix, or warned about and ignored. The bot never moves a project to another sandbox on its own.

## ADDED Requirements

### Requirement: ssh-docker runs every sandbox
The bot SHALL run every project's sandbox on the ssh-docker driver: a long-lived container on the Docker host named by `SSHDOCKER_HOST`, or on the bot's own host. `SANDBOX_DRIVER` and a project's `driver` field SHALL be optional, and SHALL accept only `ssh-docker`. Setting either one to `ssh-docker`, or leaving both unset, SHALL give the same sandbox: the same container name, image and container flags.

#### Scenario: Every setting names ssh-docker
- **WHEN** an installation sets `SANDBOX_DRIVER=ssh-docker`, every project in its configuration has `"driver": "ssh-docker"`, and none of the retired Daytona settings is present
- **THEN** the bot starts without a warning, and every project's sandbox is created from `SNAPSHOT_IMAGE` on that host, then woken and driven over ssh-docker

#### Scenario: Nothing names a driver
- **WHEN** neither `SANDBOX_DRIVER` nor a project's `driver` is set, and `DAYTONA_API_URL` is not set
- **THEN** the project's sandbox runs on ssh-docker
- **AND** without `SSHDOCKER_HOST`, the project's first use of its sandbox fails with an error naming `SSHDOCKER_HOST`

### Requirement: A setting that names a removed or unknown driver is refused
The Daytona driver is removed. When `SANDBOX_DRIVER` or a project's `driver` names any value other than `ssh-docker`, the configuration SHALL be refused, and no project SHALL run on another driver in its place:
- at boot, the bot SHALL NOT start;
- when a project's `driver` arrives through `/aven reload`, the reload SHALL fail, and the previous configuration SHALL stay active.

The error SHALL name the setting and the accepted value. The setting is the variable, or the project and its `driver` field. For `daytona`, the error SHALL also say that the driver was removed, and name the fix: move the project to ssh-docker and change or drop the setting, or keep running the last release that has the driver. The CLI probe's sandbox transport SHALL refuse the same values in its own environment, before it creates a sandbox.

#### Scenario: A project still names Daytona at boot
- **WHEN** the bot starts with a configuration in which project `acme-shop` has `"driver": "daytona"`
- **THEN** the bot does not start, and the error names `acme-shop`, its `driver` field, the removal and the fix

#### Scenario: A project names Daytona at reload
- **WHEN** an operator runs `/aven reload` after adding `"driver": "daytona"` to project `acme-shop`
- **THEN** the reply carries the same error and says the previous configuration stays active
- **AND** every project keeps its sandbox and its sessions

#### Scenario: The installation default names Daytona
- **WHEN** the bot starts with `SANDBOX_DRIVER=daytona`
- **THEN** the bot does not start, and the error names `SANDBOX_DRIVER`, the removal and the fix

#### Scenario: A misspelt driver
- **WHEN** a project has `"driver": "ssh-dokcer"`
- **THEN** the configuration is refused with an error that names the project and the accepted value `ssh-docker`, and the project is not run on any other driver in its place

#### Scenario: The CLI probe
- **WHEN** an operator runs the CLI probe with the sandbox transport and `SANDBOX_DRIVER=daytona` in the probe's environment
- **THEN** the probe stops with the same error, and no sandbox is created

### Requirement: Daytona by default is stopped, not moved
When `SANDBOX_DRIVER` is not set and `DAYTONA_API_URL` is set, the bot SHALL NOT start. Under that configuration, the projects without a `driver` field ran on Daytona, and starting would move them to new sandboxes. The error SHALL name both variables and the fix: set `SANDBOX_DRIVER=ssh-docker` once the projects run on ssh-docker, or keep running the last release that has the driver.

#### Scenario: Daytona by default
- **WHEN** the bot starts with `DAYTONA_API_URL` set, no `SANDBOX_DRIVER`, and projects without a `driver` field
- **THEN** the bot does not start, no sandbox is created, and the error names `DAYTONA_API_URL`, `SANDBOX_DRIVER` and the fix

#### Scenario: A leftover URL after the move
- **WHEN** the bot starts with `DAYTONA_API_URL` set and `SANDBOX_DRIVER=ssh-docker`
- **THEN** the bot starts, and its boot warning names `DAYTONA_API_URL` as a retired setting

### Requirement: Retired Daytona settings warn and change nothing
These settings were read only by the Daytona driver: `DAYTONA_API_URL`, `DAYTONA_API_KEY`, `DAYTONA_ORGANIZATION_ID`, `SNAPSHOT_NAME`, `SANDBOX_CPU`, `SANDBOX_MEMORY`, `SANDBOX_DISK` and `SANDBOX_AUTOSTOP_MINUTES`. They SHALL change nothing. When the bot starts with any of them set, it SHALL log one warning that names the ones present and asks the operator to remove them, and it SHALL start. The one exception is the refusal for Daytona by default.

#### Scenario: An idle-stop setting left in the environment
- **WHEN** the bot starts with `SANDBOX_DRIVER=ssh-docker` and `SANDBOX_AUTOSTOP_MINUTES=30`
- **THEN** it logs one warning naming `SANDBOX_AUTOSTOP_MINUTES` and starts
- **AND** its sandboxes are created and kept exactly as without the setting

#### Scenario: Several leftovers
- **WHEN** the bot starts with `SANDBOX_DRIVER=ssh-docker`, `SNAPSHOT_NAME`, `SANDBOX_CPU` and `DAYTONA_API_KEY` set
- **THEN** it logs one warning that names all three, and starts

#### Scenario: A clean environment
- **WHEN** none of these settings is set
- **THEN** the bot logs no warning about them

### Requirement: The status report names sandboxes, not a provider
`/aven status` SHALL report whether the sandbox listing answered under a name that is not a provider's: "Sandboxes" on Slack, as the Teams status card already does with "sandboxes".

#### Scenario: The listing fails
- **WHEN** `/aven status` runs on Slack and the sandbox listing fails
- **THEN** the health line reads `Sandboxes ⚠️`, followed by the GitHub and Slack flags as before

#### Scenario: The listing answers
- **WHEN** `/aven status` runs on Slack and the sandbox listing answers
- **THEN** the health line reads `Sandboxes ✅`, and each project shows its sandbox as started, stopped or not created, as before
