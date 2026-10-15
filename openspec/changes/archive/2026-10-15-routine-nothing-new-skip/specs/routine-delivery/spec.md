# Spec Delta

## Purpose
Defines what happens when a scheduled routine's slot arrives: whether a run is fired, skipped or deferred, and what the channel sees in each case.

## ADDED Requirements

### Requirement: Empty-slot skip
When the empty-skip flag is on and the routine's project has sources, the host SHALL skip the model run if no new source record was ingested since the routine's last delivered run and nothing in the tenant ledgers is due (no open escalation, no commitment due on or before today).

#### Scenario: Nothing happened since the last delivered run
- **WHEN** the slot comes, the store has zero new raw lines since the last delivered fire of this routine and the tenant ledgers have nothing due
- **THEN** the routine's parent message says `nothing new since <timestamp of the last delivered run>` with the sources freshness line, the outcome is recorded as `skipped-empty`, no sandbox turn runs and no usage record is written

#### Scenario: Something is due even without new records
- **WHEN** zero new raw lines were ingested but a commitment is due today or an escalation is open
- **THEN** the routine fires normally

#### Scenario: Flag off
- **WHEN** `ROUTINE_SKIP_EMPTY` is unset
- **THEN** every slot fires as before; no skip is ever recorded

### Requirement: Skips are visible and do not hide delivery gaps
A skipped run SHALL appear in the routine list with its time and reason, and the "previous run" preamble of the next fired run SHALL still reference the last *delivered* run, not the skip.

#### Scenario: Preamble after a skip
- **WHEN** the 18:30 run was skipped and the 19:30 run fires
- **THEN** the 19:30 preamble says the previous delivered run was the 08:30 one and that 18:30 was skipped as empty

### Requirement: Per-routine opt-out
A routine SHALL be able to opt out of the empty skip (`skipEmpty: false`) so reviews that must run regardless (e.g. the weekly quality report) always fire.

#### Scenario: Opted-out routine
- **WHEN** a routine has `skipEmpty: false`
- **THEN** it fires even when the fingerprint is empty
