# Spec Delta

## Purpose
Extends the dispatch primitive's transport so a sandbox on another host reaches the bot with the same proposal record.

## MODIFIED Requirements

### Requirement: Proposals are records, not messages
An agent SHALL propose a side effect by writing a proposal record (`kind`, `target`, `text`, `refs`, `rationale`) either into its outbox mount or, when the sandbox is given a proposals url, by POSTing the same record to the host's per-project endpoint; the host SHALL treat both identically: render in the agent's thread with Send and Dismiss, never execute until approved unless the target is auto-listed.

#### Scenario: Remote sandbox proposes
- **WHEN** a sandbox with `HOST_PROPOSALS_URL` set calls `propose` while `DISPATCH=1`
- **THEN** the record reaches the host over HTTP with the project's gateway identity, and the agent's thread shows the proposal with buttons within seconds

#### Scenario: Retried POST
- **WHEN** the same proposal id is POSTed twice
- **THEN** one proposal exists and the second request is acknowledged without a second rendering

#### Scenario: Wrong project
- **WHEN** a record is POSTed to `/proposals/<slug>` by a sandbox of another project
- **THEN** it is refused (401/403) and nothing is stored
