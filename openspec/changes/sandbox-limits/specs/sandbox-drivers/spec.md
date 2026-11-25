## ADDED Requirements

### Requirement: An installation caps what one project's container uses
The system SHALL keep every project container at the memory and CPU limits the installation sets with
`SANDBOX_LIMIT_MEMORY` and `SANDBOX_LIMIT_CPUS`, on a container it creates and on one that already exists,
without recreating a container. With a setting unset the system SHALL NOT set or change that limit.

#### Scenario: A new container
- **WHEN** both settings are set and the driver creates a project's container
- **THEN** the container has that memory limit, no swap beyond it, and that CPU limit

#### Scenario: A container created before the setting
- **WHEN** a setting is set and the driver prepares an existing container whose limit differs
- **THEN** the driver changes the limit in place, and the container keeps its files, its processes and its id

#### Scenario: A container already at the limit
- **WHEN** the driver prepares a container whose limits equal the settings
- **THEN** it changes nothing

#### Scenario: Nothing is set
- **WHEN** neither setting is set
- **THEN** the commands the driver runs are the ones it ran before this requirement, and a limit an operator
  set by hand stays

#### Scenario: Only one is set
- **WHEN** only the memory setting is set
- **THEN** the driver keeps the memory limit and leaves the CPU limit as it finds it

#### Scenario: The limit cannot be applied to a running container
- **WHEN** the in-place change fails, for example because the container already uses more memory than the
  new limit
- **THEN** the turn goes on in the container as it is, the failure is logged with the project, and the driver
  tries again the next time it prepares the container

#### Scenario: A value that is not a size or a number
- **WHEN** `SANDBOX_LIMIT_MEMORY` is not a size such as `6g` or `512m`, or `SANDBOX_LIMIT_CPUS` is not a
  positive number
- **THEN** the bot does not start and names the setting and the value
