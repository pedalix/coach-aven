# Spec Delta

## Purpose

A project's `env` hands its sandbox a few low-sensitivity values — the secrets a repository's CI holds for read-only
checks — so the agent can run those checks itself, without the values reaching logs, config errors or chat output.

## ADDED Requirements

### Requirement: Values resolve from the bot's environment when the config loads
Each `env` value SHALL have its `${VAR}` refs replaced from the bot's environment when the project config loads, at
boot and on `/aven reload`.

#### Scenario: A ref resolves
- **WHEN** a project's `env` maps `PREVIEW_BYPASS` to `${EXAMPLE_HOTEL_BYPASS}` and the bot's `.env` sets that variable
- **THEN** the project's sandbox receives `PREVIEW_BYPASS` with that variable's value

#### Scenario: A literal value needs no ref
- **WHEN** a project's `env` maps `SITE` to `example-hotel`
- **THEN** the sandbox receives `SITE=example-hotel`

### Requirement: An unknown ref fails the config load
A `${VAR}` ref in `env` whose variable is not set SHALL fail the config load with an error naming the project, the
key and the variable, and never a value.

#### Scenario: Missing variable at reload
- **WHEN** `/aven reload` reads an `env` entry `${EXAMPLE_HOTEL_BYPASS}` and the bot's environment lacks it
- **THEN** the reload is refused with an error naming the project, the key and `EXAMPLE_HOTEL_BYPASS`, and the running config stays

#### Scenario: Missing variable at boot
- **WHEN** the bot starts with such an entry
- **THEN** it refuses to start with the same error, as for any other invalid project config

### Requirement: Names are checked and the bot's own names are refused
An `env` key SHALL match `[A-Z_][A-Z0-9_]*` and SHALL NOT be a name the bot sets for the agent itself; either is a
config error naming the project and the key.

#### Scenario: Reserved name
- **WHEN** a project's `env` sets `GH_TOKEN`, `IS_SANDBOX`, `AVEN_SESSION`, `PATH`, `HOME`, a `GIT_AUTHOR_*` / `GIT_COMMITTER_*` name, or a Claude Code or model-credit variable
- **THEN** the config load fails naming the project and the key

#### Scenario: Malformed name
- **WHEN** a project's `env` has the key `preview-bypass`
- **THEN** the config load fails naming the project and the key

### Requirement: The sandbox holds the current values in a private file
Before each turn of a project with `env`, the bot SHALL write the resolved values to one file in the sandbox that
only the sandbox user can read, replacing the previous content.

#### Scenario: Values change
- **WHEN** an operator changes a value in `.env`, restarts the bot, and the project's next turn starts
- **THEN** the sandbox file holds the new value before the agent acts

#### Scenario: Quoting
- **WHEN** a value contains a quote, a space or a `$`
- **THEN** reading the file in a shell yields the value byte for byte

### Requirement: A new agent process starts with the values in its environment
A Claude Code process started for a project with `env` SHALL have every value in its environment, without any value
appearing on a command line on the bot host or in the sandbox.

#### Scenario: A tool call sees the value
- **WHEN** the agent of a project with `PREVIEW_BYPASS` in `env` runs a shell command in a new session
- **THEN** `PREVIEW_BYPASS` is set in that command's environment

#### Scenario: Process listings stay clean
- **WHEN** an operator lists processes on the bot host or in the sandbox while that process runs
- **THEN** no `env` value appears in any command line

#### Scenario: A running process keeps its values
- **WHEN** a value changes while a Claude Code process of the project is running
- **THEN** that process keeps the old value in its environment and the sandbox file holds the new one

### Requirement: Chat output never carries a value
Text the bot posts or updates in a chat for a turn of a project with `env` SHALL have every value of 8 or more
characters replaced with `[redacted:<KEY>]`.

#### Scenario: The agent quotes a value
- **WHEN** the agent's answer contains the value of `PREVIEW_BYPASS`
- **THEN** the posted answer shows `[redacted:PREVIEW_BYPASS]` in its place, on every chat driver

#### Scenario: Short values are left alone
- **WHEN** a project's `env` maps `SITE` to `beta` and the answer contains the word `beta`
- **THEN** the answer is posted unchanged

### Requirement: A project without `env` runs as before
For a project whose `env` is absent or empty, the bot SHALL write no file, make no extra sandbox call, start Claude
Code with the same command as before, and post chat output unchanged.

#### Scenario: Today's projects
- **WHEN** a turn runs for a project whose config has `"env": {}`
- **THEN** the sandbox calls, the launch command and the posted text are exactly those of the previous release
