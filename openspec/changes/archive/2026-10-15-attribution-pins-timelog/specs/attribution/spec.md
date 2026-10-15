# Spec Delta

## Purpose
Rule decisions are kept once their day has closed; the subject's minutes per day and initiative are a readout.

## ADDED Requirements

### Requirement: Rule decisions are pinned once the day has closed
The store build SHALL pin every `rule` decision whose fragment's local day ended at least `pinAfterDays` days before today, recording the attributions, the rule id, the rules version and the time outside the store, and SHALL thereafter present the fragment as decided by that pin, whatever the current rules say, until an explicit redo unpins it.

#### Scenario: A rule changes after the day closed
- **WHEN** a tenant edits a rule that decided a fragment of a closed day
- **THEN** the readout still shows the pinned decision with its rule id and rules version

#### Scenario: Redo
- **WHEN** the operator runs `orch sources attribution redo <slug> --since D --until D`
- **THEN** the next build decides that window's fragments with the current rules and pins them again once closed

### Requirement: The ledger still wins
A judgment recorded in the tenant ledger SHALL take precedence over a pin for the same fragment.

#### Scenario: A judgment after the pin
- **WHEN** the model or a human records a decision for a pinned fragment
- **THEN** the readout shows the recorded decision

### Requirement: Timelog readout
The sources table SHALL offer `timelog({since, until})`: for each local day of the tenant's zone and each initiative, the subject's minutes — calls in full by topic share, message runs and work blocks unioned per initiative minus call time, split aliases by weight — and the unattributed minutes with their candidates; no stored value depends on a time zone.

#### Scenario: A call and overlapping work
- **WHEN** an hour of work on one initiative overlaps a 30-minute call on another
- **THEN** the day shows 30 minutes for the call's initiative and 30 for the work's

### Requirement: Reconciliation against tenant budgets
When the tenant's attribution config lists budgets, every `timelog` answer SHALL carry the reconciliation of the month of `until`, counted from that month's first day whatever the window.

#### Scenario: A one-day window
- **WHEN** the evening close asks for today's timelog
- **THEN** the answer carries the month-to-date reconciliation, identical to the one a whole-month window returns

### Requirement: Budgets round as the frame bills
Each budget SHALL report the units used (half-days to 0.5 per breakdown key then summed, hours to 0.1 on the total), the month's cap with a month override taking precedence, and what is left; routed time without a billing code SHALL be reported as non-billable and time without an umbrella as unrouted, and no minute of the timelog SHALL change.

#### Scenario: Half-days per billing code
- **WHEN** a month holds 300 minutes on one billing code and 59 on another, with 240 minutes per half-day
- **THEN** the first counts 1.5 half-days, the second none, and the budget has used 1.5

### Requirement: The initiative index follows the plan
With the attribution layer on, the store's initiative index SHALL hold the plan's decided and rule fragments over the platform's own refs, plus the rows of ledger lines the plan does not hold; with the layer off it SHALL hold the ledger's rows alone.

#### Scenario: A judgment without refs
- **WHEN** the tenant ledger records a judgment by fragment id only
- **THEN** a search filtered by that initiative finds the fragment's messages
