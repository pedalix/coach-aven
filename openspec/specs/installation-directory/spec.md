# installation-directory Specification

## Purpose
Keeps an installation's configuration and state in one directory that depends neither on where the code is nor on where the process starts. That way the code can be replaced as a unit, and the state survives the replacement.

## Requirements

### Requirement: One setting names the installation directory
The bot SHALL keep every file it writes at runtime under the installation directory, named by `AVEN_DIR`. That covers `state.json`, `queue.jsonl`, `usage/`, `drafts/`, `facts/`, `memory/`, `feedback/`, `events/`, `shadow/` and the mirror job's `mirrors/`, and `data/` unless `AVEN_DATA_DIR` names another place.

#### Scenario: Directory set
- **WHEN** the bot runs with `AVEN_DIR=/srv/acme` and a turn completes
- **THEN** `state.json`, the month's usage file and the event journal are written under `/srv/acme`, and nothing is written beside the code

#### Scenario: Data directory set apart
- **WHEN** both `AVEN_DIR=/srv/acme` and `AVEN_DATA_DIR=/data/acme` are set
- **THEN** the sources store and the routine run requests live under `/data/acme`, and every other runtime file under `/srv/acme`

### Requirement: Unset means the package root
With `AVEN_DIR` unset or empty, the installation directory SHALL be the package root. Started from the package root, as every unit and npm script is, the bot SHALL read and write exactly the files it did before this setting existed.

#### Scenario: Today's layout
- **WHEN** the bot starts from the package root without `AVEN_DIR`
- **THEN** it reads `.env` and writes `state.json`, `queue.jsonl`, `usage/` and the other runtime files at the package root, as before

#### Scenario: Started elsewhere without the setting
- **WHEN** the bot starts without `AVEN_DIR` and with another working directory
- **THEN** it reads the package root's `.env`, not the working directory's

### Requirement: The configuration is read from the installation directory
The bot SHALL load `.env` from the installation directory. When `PROJECTS_CONFIG_PATH` is unset it SHALL read `projects.config.json` from there, with the prompts in `projects.d/` beside it. When `MIRRORS_CONFIG` is unset the mirror job SHALL read `mirrors.json` from there. An explicit path SHALL keep winning. The working directory of the process SHALL NOT change which configuration or state the bot uses.

#### Scenario: No explicit paths
- **WHEN** the bot boots with `AVEN_DIR=/srv/acme` and no `PROJECTS_CONFIG_PATH`
- **THEN** it loads `/srv/acme/.env` and `/srv/acme/projects.config.json`

#### Scenario: Explicit path
- **WHEN** `PROJECTS_CONFIG_PATH=/etc/acme/projects.config.json` is set as well
- **THEN** that file is loaded, whatever `AVEN_DIR` says

#### Scenario: Started from another directory
- **WHEN** a command of the CLI runs with `AVEN_DIR=/srv/acme` and `/tmp` as its working directory
- **THEN** it reads `/srv/acme/.env` and the state under `/srv/acme`, whatever `/tmp` holds

### Requirement: The configuration has the overlay's layout
The files the bot reads from the installation directory SHALL have the names and places an ops overlay (`ops-overlay`) keeps them under: `.env`, `projects.config.json` with `projects.d/<slug>.md` and `hub.peers.json` beside it, `mirrors.json`, and the GitHub App key under the name the template's `.env` gives it. The two layouts SHALL stay interchangeable without a rename.

#### Scenario: An overlay as the installation directory
- **WHEN** a checkout of an ops overlay, with its two secret files in place, is named as `AVEN_DIR`
- **THEN** the bot reads its configuration from that checkout without any path setting

#### Scenario: What the deploy carries is what the bot reads
- **WHEN** the names `deploy.sh runtime-files` lists are compared with the names the bot reads from the installation directory
- **THEN** they are the same names

### Requirement: A relative path in a setting resolves against the installation directory
A relative value of `PROJECTS_CONFIG_PATH`, `AVEN_DATA_DIR`, `MIRRORS_CONFIG`, `GITHUB_APP_PRIVATE_KEY_PATH` or `HUB_KEY_PATH` SHALL resolve against the installation directory, not against the working directory. An absolute value SHALL be used as it is. A path given on a command line SHALL keep resolving against the working directory of the shell, as with any command-line tool.

#### Scenario: Relative key path
- **WHEN** `/srv/acme/.env` says `GITHUB_APP_PRIVATE_KEY_PATH=github-app-private-key.pem` and the bot runs with `AVEN_DIR=/srv/acme` and another working directory
- **THEN** it reads the key from `/srv/acme/github-app-private-key.pem`

#### Scenario: Absolute path
- **WHEN** `HUB_KEY_PATH=/home/deployer/.config/coach-aven/hub.key` is set
- **THEN** the hub key is read from that path, whatever `AVEN_DIR` says

### Requirement: The setting comes from the process environment
`AVEN_DIR` SHALL be read from the process environment and SHALL be an absolute path. It names where `.env` is, so `.env` SHALL NOT set it. A relative value, or a `.env` that sets `AVEN_DIR`, SHALL stop the bot at boot with one sentence that names the setting.

#### Scenario: Relative path
- **WHEN** the bot starts with `AVEN_DIR=state`
- **THEN** it stops at boot with an error that names `AVEN_DIR` and says the path must be absolute

#### Scenario: Set in .env
- **WHEN** the `.env` the bot loads contains `AVEN_DIR=/srv/acme`
- **THEN** the bot stops at boot with an error that names `AVEN_DIR` and says it belongs in the service's environment

### Requirement: The boot names the directory
At boot the bot SHALL log, once and before the chat driver starts, the installation directory it uses.

#### Scenario: Boot line
- **WHEN** the bot starts, with or without `AVEN_DIR`
- **THEN** its log carries one line naming the resolved installation directory

### Requirement: No runtime file is located through the code or the working directory
The bot's own assets (fixtures, static files, workers) SHALL stay beside the code; nothing else SHALL be located through the code's own location. Every file the bot reads or writes at runtime SHALL be located through the installation directory. The test suite SHALL fail when code under `src/` builds such a path from its own location or from the working directory.

#### Scenario: A new journal located through the code
- **WHEN** a change adds `new URL('../journal', import.meta.url)` for a runtime file under `src/`
- **THEN** `npm test` fails and names the file and the path

#### Scenario: A cache located through the working directory
- **WHEN** a change adds `join(process.cwd(), 'cache')` under `src/`
- **THEN** `npm test` fails and names the file

#### Scenario: Release marker
- **WHEN** the error tracker's release is wanted
- **THEN** it comes from the environment the compose file sets from the pinned version, and no file beside the code is read for it
