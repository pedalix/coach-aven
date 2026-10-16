# Spec Delta

## MODIFIED Requirements

### Requirement: The ledger wins
A fragment with a live record in the tenant's `fragments.jsonl` SHALL carry that record's decision, whoever made it, and the ladder SHALL NOT decide it again. The live record of an id is its last line, except that a line by a machine (`rule`, `model`, or an unknown literal) SHALL NOT replace a line a person decided (`owner`, the tenant's owner literal, or `human:<id>`): a person's line is final until a person writes another — a later decided line, or a `superseded` line of their own.

#### Scenario: A judgment exists
- **WHEN** the model or a human decided a fragment that a rule would now decide differently
- **THEN** the readout shows the recorded decision

#### Scenario: A machine re-decides a judged fragment
- **WHEN** the review session writes a `model` line for a fragment a person decided earlier
- **THEN** the readout, the initiative index and the learning loop keep the person's decision

#### Scenario: A person corrects
- **WHEN** a person writes a later line with another initiative for the same fragment
- **THEN** that line is the decision and the earlier one is history
