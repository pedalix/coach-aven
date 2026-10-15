# Spec Delta

## ADDED Requirements

### Requirement: Shadow learning is opt-in and changes nothing it does not show
The attribution layer SHALL run the learning loop only when `annotations/attribution.json` has `learn: {mode: "shadow"}`, and in shadow mode SHALL write its decisions, calibration, questions and audit sample only to its own table and readout section — the plan, the pins, the initiative index and the timelog SHALL be identical with the loop on or off.

#### Scenario: Shadow on a real tenant
- **WHEN** the home tenant switches `learn` to shadow
- **THEN** `attribution()` without `learn: true`, `timelog()` and the pins are byte-identical to the build before

### Requirement: People's answers are the only evidence
The loop SHALL learn only from people: ledger lines decided by a person (`owen` or `human:<id>`), lines of `annotations/labels.jsonl`, and audit answers. The floor's decisions, the loop's own decisions and any model output SHALL NOT move a key, a calibration, a threshold, a question's rank or a rule candidate. One answer SHALL count as one observation however many units it covered.

#### Scenario: A wrong rule the machine keeps confirming
- **WHEN** a rule decides 40 units a day and nobody answers about them
- **THEN** its calibration does not move, and only answers or audits on its units can demote it

### Requirement: Calibration and trust
Every rung instance (a rule, a tracker key, a channel, a title pattern, a host, a marker person) SHALL carry a calibration prior from its graded confidence, updated by the answers and audits on units it decided; an instance whose posterior falls below τ (.95) SHALL stop auto-deciding (its units become questions with its label as the guess). A structural decision for an initiative whose client has active sibling initiatives SHALL decide the client at the rung's confidence and the initiative only when the unit carries a cue of that initiative and none of a sibling's, or an earned key confirms it.

#### Scenario: A tracker project shared by two initiatives
- **WHEN** the registry routes a key prefix to a client's shop while the same project also carries its ERP sync
- **THEN** units without a shop cue are questions for the client ("shop or ERP sync?"), and the answers demote the route if it is wrong

### Requirement: Questions and audits
The loop SHALL publish today's questions ranked by value (uncertainty × minutes or units, plus the reach of what the answer would teach), grouped so one answer covers a client-day, a call or a key, with the loop's guess when it has one, the unit kinds taking turns; and a seeded sample of today's auto-decided units to audit (a share of the daily question budget that accrues across days).

#### Scenario: A day of items and calls
- **WHEN** a day has long open calls and a doubted item route
- **THEN** the list alternates fragment and item questions, so the item route gets answers too

### Requirement: The loop readout
`attribution({learn: true})` SHALL add a `learn` section: per-unit shadow decisions, the rung-instance calibration, the key-type table, today's questions and audit sample, and rule candidates (keys with at least three agreeing independent answers).

#### Scenario: A first look
- **WHEN** the review routine asks `attribution({learn: true})`
- **THEN** it sees what the loop would decide, why, and what it would ask today
