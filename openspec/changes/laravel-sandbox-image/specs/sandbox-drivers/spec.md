# Spec Delta

## ADDED Requirements

### Requirement: The inner dockerd starts with its cgroups nested
Before the bot's guard starts the inner dockerd of a docker-in-docker container on a cgroup-v2 host, it SHALL move the container's processes out of its root cgroup and enable the available controllers for the subtree, unless the subtree already has every controller. A running dockerd SHALL be left as it is.

#### Scenario: A privileged container on a cgroup-v2 host
- **WHEN** the guard starts dockerd in a `--privileged` container that was just started, and the agent then runs `docker run -m 64m alpine true`
- **THEN** the inner container starts and exits 0 (without the step: `cannot enter cgroupv2 "/sys/fs/cgroup/docker" with domain controllers`)

#### Scenario: A sysbox container
- **WHEN** the guard runs in a sysbox container, whose subtree already has every controller
- **THEN** no process is moved and no cgroup file is written

#### Scenario: A cgroup-v1 host
- **WHEN** `/sys/fs/cgroup/cgroup.controllers` does not exist
- **THEN** the guard starts dockerd as before

#### Scenario: A container whose dockerd once started without the step
- **WHEN** the guard restarts dockerd in a container where an earlier dockerd left child cgroups behind, and the write is refused
- **THEN** the guard still starts dockerd and reports its marker; the container gets the nesting at its next start
