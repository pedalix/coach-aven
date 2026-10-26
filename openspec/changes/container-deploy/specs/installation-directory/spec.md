# Spec Delta

## Purpose

Keeps an installation's state and default configuration in one directory that does not depend on where the code is. That way the code can be replaced as a unit, and the state survives the replacement.

## ADDED Requirements

### Requirement: One setting names the installation directory
The bot SHALL keep every file it writes at runtime under the installation directory, named by `AVEN_DIR`. That covers `state.json`, `queue.jsonl`, `usage/`, `drafts/`, `facts/`, `memory/`, `feedback/`, `events/` and `shadow/`, and `data/` unless `AVEN_DATA_DIR` names another place.

#### Scenario: Directory set
- **WHEN** the bot runs with `AVEN_DIR=/srv/acme` and a turn completes
- **THEN** `state.json`, the month's usage file and the event journal are written under `/srv/acme`, and nothing is written beside the code

#### Scenario: Data directory set apart
- **WHEN** both `AVEN_DIR=/srv/acme` and `AVEN_DATA_DIR=/data/acme` are set
- **THEN** the sources store and the routine run requests live under `/data/acme`, and every other runtime file under `/srv/acme`

### Requirement: Unset means the package root
With `AVEN_DIR` unset or empty, the installation directory SHALL be the package root, so every runtime file stays exactly where it was before this setting existed.

#### Scenario: Today's layout
- **WHEN** the bot starts without `AVEN_DIR`
- **THEN** it reads and writes `state.json`, `queue.jsonl`, `usage/` and the other runtime files at the package root, as before

### Requirement: The projects config defaults to the installation directory
When `PROJECTS_CONFIG_PATH` is unset, the bot SHALL read `projects.config.json` from the installation directory. An explicit `PROJECTS_CONFIG_PATH` SHALL keep winning.

#### Scenario: No explicit path
- **WHEN** the bot boots with `AVEN_DIR=/srv/acme` and no `PROJECTS_CONFIG_PATH`
- **THEN** it loads `/srv/acme/projects.config.json`, with the prompts in `projects.d/` beside it

#### Scenario: Explicit path
- **WHEN** `PROJECTS_CONFIG_PATH=/etc/acme/projects.config.json` is set as well
- **THEN** that file is loaded, whatever `AVEN_DIR` says

### Requirement: The setting comes from the process environment
`AVEN_DIR` SHALL be read from the process environment and SHALL be an absolute path. A relative value, or an `AVEN_DIR` that only `.env` sets, SHALL stop the bot at boot with one sentence that names the setting.

#### Scenario: Relative path
- **WHEN** the bot starts with `AVEN_DIR=state`
- **THEN** it stops at boot with an error that names `AVEN_DIR` and says the path must be absolute

#### Scenario: Set only in .env
- **WHEN** `.env` contains `AVEN_DIR=/srv/acme` and the process environment has no `AVEN_DIR`
- **THEN** the bot stops at boot with an error that names `AVEN_DIR` and says it belongs in the service's environment

### Requirement: The boot names the directory
At boot the bot SHALL log, once and before the chat driver starts, the installation directory it uses.

#### Scenario: Boot line
- **WHEN** the bot starts, with or without `AVEN_DIR`
- **THEN** its log carries one line naming the resolved installation directory

### Requirement: No runtime file is located through the code
The release marker and the bot's own assets (fixtures, static files, workers) SHALL stay beside the code. Every other file the bot reads or writes at runtime SHALL be located through the installation directory. The test suite SHALL fail when code under `src/` builds such a path from its own location.

#### Scenario: A new journal located through the code
- **WHEN** a change adds `new URL('../journal', import.meta.url)` for a runtime file under `src/`
- **THEN** `npm test` fails and names the file and the path

#### Scenario: Release marker
- **WHEN** a deploy stamps `.release` beside the code
- **THEN** the bot reads the release from there, whatever `AVEN_DIR` says
