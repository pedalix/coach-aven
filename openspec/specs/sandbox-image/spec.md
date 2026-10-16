# sandbox-image Specification

## Purpose
Pins the toolchain each sandbox image variant guarantees to the agent, so a project can rely on it without a per-project provisioning step.

## Requirements

### Requirement: Plain image toolchain
The plain sandbox image SHALL provide, on both `amd64` and `arm64`: `bash`, `git`, `gh`, `curl`, `jq`, `ssh`, `rg`, `node` (22), `npm`, `python3`, `pip` (as `pip3`), `make`, `unzip`, `rsync`, and the pinned Claude Code CLI. It SHALL NOT provide a Docker daemon.

#### Scenario: Tool check inside a fresh sandbox
- **WHEN** a sandbox is created from the plain image and `command -v` runs for each listed tool
- **THEN** every tool resolves, and `docker` does not

#### Scenario: Multi-arch build
- **WHEN** `snapshot/build-and-push.sh plain` runs with `PUSH=0`
- **THEN** the image builds for `linux/amd64` and `linux/arm64`
