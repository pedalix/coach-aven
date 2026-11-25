# Spec Delta

## Purpose

Housekeeping is the deterministic janitor of a project's sandbox: it reaps stale worktrees, converges the
Claude Code CLI to the pin and, on a docker-in-docker project, guards dockerd and prunes above a disk threshold.
It is part of every project and runs by itself, once a night, in one pass with the memory tidy.

## ADDED Requirements

### Requirement: Every project is kept clean without a switch
The system SHALL run housekeeping for every project of the installation with no command, routine or setting to
enable it.

#### Scenario: A project nobody configured
- **WHEN** a project had turns during the day and nobody ever ran a housekeeping command for it
- **THEN** its sandbox is cleaned that night

#### Scenario: A stored housekeeping routine
- **WHEN** the bot starts with a housekeeping routine in its stored state
- **THEN** the routine is removed and the removal is logged once

### Requirement: A pass runs only for a project that worked
The system SHALL run a project's nightly pass only when the project had a turn since its last pass.

#### Scenario: A quiet project
- **WHEN** the night hour comes and a project had no turn since its last pass
- **THEN** nothing runs for it and its stopped sandbox stays stopped

#### Scenario: A project that worked and went to sleep
- **WHEN** a project had a turn in the afternoon and its sandbox was stopped for being idle
- **THEN** the pass runs that night under the rule for a stopped container, and the sandbox sleeps again after it

#### Scenario: No sandbox yet
- **WHEN** a project has no sandbox
- **THEN** none is created for a pass

### Requirement: A pass never runs over a live turn
The system SHALL NOT run a project's pass while a turn of that project is running or queued; it SHALL try again
during the same night hour and give up for the night after it.

#### Scenario: A turn at three in the morning
- **WHEN** the night hour comes while a turn of the project is running
- **THEN** no worktree is reaped under it, and the pass runs once the turn has ended if the hour has not passed

### Requirement: Housekeeping and the memory tidy are one nightly pass
The system SHALL run a project's housekeeping before its memory tidy of the same night.

#### Scenario: Both are due
- **WHEN** a project worked during the day and its memory lint holds findings
- **THEN** the janitor runs first and the tidy turn starts in the same awake sandbox

#### Scenario: Only the tidy is due
- **WHEN** a project had no turn since its last pass and its memory lint holds a finding still due
- **THEN** the tidy runs and no housekeeping does

#### Scenario: Housekeeping fails
- **WHEN** the janitor's command fails
- **THEN** the failure is logged and kept as the last pass's summary, and the tidy still runs

### Requirement: The last pass is visible
The system SHALL keep, per project, when the last pass ran and its one-line summary, and SHALL show them to a
person who sends the bare `housekeeping` verb in a project channel.

#### Scenario: Asking after a pass
- **WHEN** a person sends `housekeeping` in a project channel
- **THEN** they get the time of the last pass and its summary, and no pass starts

#### Scenario: No pass yet
- **WHEN** the project has never had a pass
- **THEN** the answer says so and that it runs by itself at night

### Requirement: A person can run a pass now
The system SHALL run one pass when a person who may drive the agent sends `housekeeping now` in a project
channel, whether or not the project had a turn since the last one.

#### Scenario: Now
- **WHEN** a person sends `housekeeping now`
- **THEN** the pass runs under the same rules as at night, and the bare verb shows its summary afterwards

#### Scenario: A turn is running
- **WHEN** a person sends `housekeeping now` while a turn of the project runs
- **THEN** no pass starts and they are told to try again shortly

### Requirement: There is no switch
The system SHALL answer `housekeeping on` and `housekeeping off` with one line saying that housekeeping runs by
itself, and SHALL create or change nothing.

#### Scenario: The old command
- **WHEN** a person sends `housekeeping on`
- **THEN** no routine is created and the answer says housekeeping needs no switch
