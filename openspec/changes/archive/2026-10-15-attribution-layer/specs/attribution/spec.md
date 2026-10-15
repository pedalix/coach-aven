# Spec Delta

## Purpose
Deterministic attribution of a subject's calls, message runs and work blocks to the tenant's initiatives, computed in the store build from tenant data and served as a readout.

## ADDED Requirements

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
