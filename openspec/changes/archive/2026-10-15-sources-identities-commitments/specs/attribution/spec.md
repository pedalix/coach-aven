# Spec Delta

## Purpose
The subject's identity questions and promised next steps are platform readouts, like the attribution plan.

## ADDED Requirements

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
