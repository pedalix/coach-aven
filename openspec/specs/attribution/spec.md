# attribution Specification

## Purpose
Deterministic attribution of a subject's calls, message runs and work blocks to the tenant's initiatives, computed in the store build from tenant data and served as a readout.

## Requirements

### Requirement: Opt-in by tenant data
The store build SHALL compute the attribution layer only for a project whose tenant checkout contains `annotations/attribution.json`, and SHALL read every tenant-specific input — subject, horizon, time zone, rules, markers, registry, admin buckets — from the tenant's files, never from code.

#### Scenario: Tenant without the config
- **WHEN** a sources project's tenant has no `annotations/attribution.json`
- **THEN** the build writes no attribution rows and the `attribution` tool answers that the layer is not configured

### Requirement: Fragments are deterministic and stable
The layer SHALL cut the subject's days into fragments — one per call (one per summary topic when there are several), one per run of the subject's own messages in a container with gaps of at most the configured minutes, one per work block — with ids that depend only on the underlying records, so the same inputs always yield the same ids and decisions recorded against an id stay attached.

#### Scenario: Rebuild
- **WHEN** the store is rebuilt from raw with the same records
- **THEN** every fragment id is the same as before

### Requirement: The ladder decides or narrows, never guesses
Each fragment the ledger does not decide SHALL go through the ladder in order — tenant rules, admin bucket, exclusive markers, registry routing, narrow markers, broad markers — and SHALL be decided only by a rule, an admin match with one umbrella, agreeing exclusive markers or a single registry hit; anything else stays open with its candidates and a hint.

#### Scenario: Ambiguous registry hit
- **WHEN** a fragment's project keys match two initiatives
- **THEN** it stays open with both as candidates and no decision

### Requirement: The ledger wins
A fragment with a live record in the tenant's `fragments.jsonl` SHALL carry that record's decision, whoever made it, and the ladder SHALL NOT decide it again.

#### Scenario: A judgment exists
- **WHEN** the model or a human decided a fragment that a rule would now decide differently
- **THEN** the readout shows the recorded decision

### Requirement: The readout
The sources table SHALL offer `attribution({since, until, state})` returning the window's fragments with their effective decision (`ledger`, `rule` or `open` with candidates and hint) and the rule proposals derived from recorded judgments.

#### Scenario: Plan a window
- **WHEN** the review session asks for yesterday's open fragments
- **THEN** it receives exactly the fragments that need a judgment, each with its candidates, hint and refs

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

### Requirement: Identities readout
With the attribution layer on, the sources table SHALL offer `identities()`: the deterministic merges of unmapped identities into known people, the open identity questions most-seen first, and the counts of mapped, candidate, dormant, system and opaque identities, computed from the store's observations against the tenant's people file.

#### Scenario: A mailbox that is the glued full name
- **WHEN** mail arrives from a mailbox whose local part is a known person's first and last name glued together
- **THEN** the readout lists it as a merge into that person, and asks nothing

#### Scenario: A first name seen once
- **WHEN** an unmapped first name matches one known person but never appears together with them
- **THEN** the readout asks a yes/no question only if the identity talked with the subject at least twice or in a direct chat

### Requirement: Commitments readout
With the attribution layer on, the sources table SHALL offer `commitments({since, until})`: for the calls of those local days, every recorder copy's next steps parsed per recorder, unioned per call and deduped by text, as proposed rows with a stable id, the owner (the subject when the step names one of the subject's names or addresses) and, for the subject's steps, the single other attendee.

#### Scenario: Two recorders, one step
- **WHEN** two recorders of one call list the same step for the subject
- **THEN** the readout has one row for it, with both recorders' refs as provenance
