# Spec Delta

## Purpose
Extends the dispatch primitive's transport so a sandbox on another host reaches the bot with the same proposal record.

## ADDED Requirements

### Requirement: Proposal transport over HTTP
When a sandbox is given a proposals url, `propose` SHALL POST the same proposal record to the host's per-project endpoint instead of writing the outbox file, and the host SHALL treat both transports identically: validate, store, render in the agent's thread with Send and Dismiss, never execute until approved unless the target is auto-listed.

#### Scenario: Remote sandbox proposes
- **WHEN** a sandbox with `HOST_PROPOSALS_URL` set calls `propose` while `DISPATCH=1`
- **THEN** the record reaches the host over HTTP with the project's gateway identity, and the agent's thread shows the proposal with buttons within seconds

#### Scenario: Retried POST
- **WHEN** the same proposal id is POSTed twice
- **THEN** one proposal exists and the second request is acknowledged without a second rendering

#### Scenario: Wrong project
- **WHEN** a record is POSTed to `/proposals/<slug>` by a sandbox of another project
- **THEN** it is refused (401/403) and nothing is stored
