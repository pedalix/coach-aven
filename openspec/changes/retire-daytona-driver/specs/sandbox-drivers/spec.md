## Purpose

Which driver runs a project's sandbox, how an installation selects it, and what the bot does with a setting for a driver it no longer has. A setting that would move a project to another sandbox is refused with the fix. A setting that moves nothing gets a warning and is ignored. The bot never moves a project to another sandbox on its own.

## ADDED Requirements

### Requirement: ssh-docker runs every sandbox
The bot SHALL run every project's sandbox on the ssh-docker driver: a long-lived container on the Docker host named by `SSHDOCKER_HOST`, where `local` names the bot's own host. `SANDBOX_DRIVER` and a project's `driver` field SHALL be optional, and `ssh-docker` SHALL be the only driver they select. The requirements below say what any other value does. An empty `SANDBOX_DRIVER` SHALL count as unset. Setting either one to `ssh-docker`, or leaving both unset, SHALL give the same sandbox: the same container name, image and container flags.

#### Scenario: Every setting names ssh-docker
- **WHEN** an installation sets `SANDBOX_DRIVER=ssh-docker`, every project in its configuration has `"driver": "ssh-docker"`, and none of the retired Daytona settings is set
- **THEN** the bot starts and logs no retired-setting warning
- **AND** every project's sandbox is created from `SNAPSHOT_IMAGE` on the host that `SSHDOCKER_HOST` names, then woken and driven over ssh-docker

#### Scenario: Nothing names a driver
- **WHEN** neither `SANDBOX_DRIVER` nor a project's `driver` is set, and `DAYTONA_API_URL` is unset or empty
- **THEN** the project's sandbox runs on ssh-docker
- **AND** without `SSHDOCKER_HOST`, the project's first use of its sandbox fails with an error naming `SSHDOCKER_HOST`

### Requirement: A setting that names a removed or unknown driver is refused
The Daytona driver is removed. When a project's `driver` field names any value other than `ssh-docker`, every command that loads the projects configuration SHALL refuse it, and no project SHALL run on another driver in its place:
- at boot, the bot SHALL NOT start;
- at `/aven reload`, the reload SHALL fail, and the previous configuration SHALL stay active;
- the `orch sources` commands SHALL refuse it in the same words.

A non-empty `SANDBOX_DRIVER` other than `ssh-docker` or `daytona` SHALL stop the bot at boot. `SANDBOX_DRIVER=daytona` is covered by the requirement "A project left on a Daytona default is refused, not moved".

The error SHALL name the setting and the accepted value. The setting is the variable, or the project and its `driver` field. For `daytona`, the error SHALL also say that the driver was removed, and name the fix: move the project to ssh-docker and change or drop the setting, or keep running the last release that has the driver. A refusal at boot SHALL be printed as one line, without a stack trace.

The CLI probe's sandbox transport SHALL keep requiring `SANDBOX_DRIVER` in its own environment, and SHALL accept only `ssh-docker`. It SHALL refuse `daytona` with the same error before it creates a sandbox.

#### Scenario: A project still names Daytona at boot
- **WHEN** the bot starts with a configuration in which project `acme-shop` has `"driver": "daytona"`
- **THEN** the bot does not start
- **AND** the one-line error names `acme-shop`, its `driver` field, the removal and the fix

#### Scenario: A project names Daytona at reload
- **WHEN** an operator runs `/aven reload` after adding `"driver": "daytona"` to project `acme-shop`
- **THEN** the reply carries the same error and says the previous configuration stays active
- **AND** every project keeps its sandbox and its sessions

#### Scenario: A misspelt driver
- **WHEN** a project has `"driver": "ssh-dokcer"`
- **THEN** the configuration is refused with an error that names the project and the accepted value `ssh-docker`
- **AND** the project is not run on any other driver in its place

#### Scenario: An unknown installation default
- **WHEN** the bot starts with `SANDBOX_DRIVER=kubernetes`
- **THEN** the bot does not start, and the error names `SANDBOX_DRIVER` and the accepted value `ssh-docker`

#### Scenario: The sources daemon
- **WHEN** `orch sources daemon` starts with a configuration in which project `acme-shop` has `"driver": "daytona"`
- **THEN** it does not start, and its error is the bot's

#### Scenario: The CLI probe
- **WHEN** an operator runs the CLI probe with the sandbox transport and `SANDBOX_DRIVER=daytona` in the probe's environment
- **THEN** the probe stops with the same error, and no sandbox is created

### Requirement: A project left on a Daytona default is refused, not moved
The installation's default driver was Daytona when `SANDBOX_DRIVER` is `daytona`, or when `SANDBOX_DRIVER` is unset or empty and `DAYTONA_API_URL` is set and non-empty. Under such a default, a project without a `driver` field was meant to run on Daytona. Every command that loads the projects configuration SHALL refuse such a project, at boot, at `/aven reload` and in the `orch sources` commands, as in the requirement "A setting that names a removed or unknown driver is refused". The error SHALL name the project, the setting that made Daytona the default, and the fix: give the project `"driver": "ssh-docker"`, or set `SANDBOX_DRIVER=ssh-docker`, once the project runs on ssh-docker; or keep running the last release that has the driver.

When every project names its driver, the old default moves nothing. The bot SHALL then start, and the setting SHALL only get the retired-setting warning.

#### Scenario: Daytona by default
- **WHEN** the bot starts with `DAYTONA_API_URL` set, no `SANDBOX_DRIVER`, and a project `acme-shop` without a `driver` field
- **THEN** the bot does not start, and no sandbox is created
- **AND** the error names `acme-shop`, `DAYTONA_API_URL`, `SANDBOX_DRIVER` and the fix

#### Scenario: An explicit Daytona default
- **WHEN** the bot starts with `SANDBOX_DRIVER=daytona` and a project without a `driver` field
- **THEN** the bot does not start, and the error names the project, `SANDBOX_DRIVER` and the fix

#### Scenario: An empty SANDBOX_DRIVER
- **WHEN** the bot starts with `SANDBOX_DRIVER` set to the empty string, `DAYTONA_API_URL` set, and a project without a `driver` field
- **THEN** the configuration is refused as if `SANDBOX_DRIVER` were unset

#### Scenario: A stale default that moves nothing
- **WHEN** the bot starts with `DAYTONA_API_URL` set, no `SANDBOX_DRIVER`, and every project has `"driver": "ssh-docker"`
- **THEN** the bot starts, and its boot warning names `DAYTONA_API_URL` as a retired setting

#### Scenario: A reload under a stale default
- **WHEN** the bot runs under such a stale default, and an operator runs `/aven reload` after adding a project without a `driver` field
- **THEN** the reload fails with an error that names the new project and the setting, and the previous configuration stays active

#### Scenario: A leftover URL after the move
- **WHEN** the bot starts with `DAYTONA_API_URL` set and `SANDBOX_DRIVER=ssh-docker`
- **THEN** the bot starts, and its boot warning names `DAYTONA_API_URL` as a retired setting

### Requirement: Retired Daytona settings warn and change nothing
These settings were read only by the Daytona driver or its SDK:
- every variable whose name starts with `DAYTONA_`;
- `SNAPSHOT_NAME`, `SANDBOX_CPU`, `SANDBOX_MEMORY` and `SANDBOX_DISK`;
- `SANDBOX_DRIVER=daytona`.

They SHALL change nothing. The one exception is the refusal in the requirement "A project left on a Daytona default is refused, not moved". When the bot starts with any of them set to a non-empty value, it SHALL log one warning that names the ones present and asks the operator to remove them. For `SANDBOX_DRIVER`, the warning SHALL ask the operator to set `ssh-docker`. Unless that refusal applies, the bot SHALL then start.

`SANDBOX_AUTOSTOP_MINUTES` is not one of them. Daytona read it, and so does the bot's idle stop of ssh-docker containers (capability `sandbox-idle-stop`). It SHALL keep that meaning, and the warning SHALL NOT name it.

#### Scenario: The idle-stop setting stays
- **WHEN** the bot starts with `SANDBOX_DRIVER=ssh-docker` and `SANDBOX_AUTOSTOP_MINUTES=45`
- **THEN** it logs no retired-setting warning, and starts
- **AND** its idle-stop line at boot says that containers stop after 45 minutes without activity

#### Scenario: Several leftovers
- **WHEN** the bot starts with `SANDBOX_DRIVER=ssh-docker`, and with `SNAPSHOT_NAME`, `SANDBOX_CPU` and `DAYTONA_API_KEY` set
- **THEN** it logs one warning that names all three, and starts

#### Scenario: A variable only the SDK read
- **WHEN** the bot starts with `SANDBOX_DRIVER=ssh-docker` and `DAYTONA_TARGET` set
- **THEN** the warning names `DAYTONA_TARGET`

#### Scenario: A clean environment
- **WHEN** none of these settings is set, or each one that is set is empty
- **THEN** the bot logs no warning about them

### Requirement: The status report names sandboxes, not a provider
`/aven status` SHALL report whether the sandbox listing answered, under a name that is not a provider's. On Slack that name is "Sandboxes", as the Teams status card already says "sandboxes". A listing whose Docker host cannot be reached, or whose command exits non-zero, SHALL count as a failed listing, not as an empty one.

#### Scenario: The sandbox host cannot be reached
- **WHEN** `/aven status` runs on Slack and the sandbox listing fails: its Docker host cannot be reached, or the listing exits non-zero
- **THEN** the health line reads `Sandboxes ⚠️`, followed by the GitHub and Slack flags as before

#### Scenario: The listing answers
- **WHEN** `/aven status` runs on Slack and the sandbox listing answers
- **THEN** the health line reads `Sandboxes ✅`
- **AND** each project shows its sandbox as started, stopped or not created, as before
