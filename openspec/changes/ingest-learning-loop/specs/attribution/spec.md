# Spec Delta

## MODIFIED Requirements

### Requirement: The ladder decides or narrows, never guesses
Each fragment the ledger does not decide SHALL go through the ladder in order — tenant rules, exclusive markers, registry routing, admin bucket, narrow markers, broad markers — and SHALL be decided only by a rule, agreeing exclusive markers, a single registry hit or an admin match with one umbrella; anything else stays open with its candidates and a hint. Admin keywords SHALL match whole words only (Unicode-aware, with explicit inflections), and calendar title patterns of five characters or fewer SHALL match whole words only. A Slack or Teams channel entry in the registry MAY be a `{id, name}` object and SHALL then match by id first; a channel listed on two or more initiatives SHALL yield those initiatives as candidates. The narrow rung SHALL ignore broad people. Every decision SHALL carry its rung's graded confidence (repo/path .99, tracker key and tenant rule .97, exclusive marker and channel .95, single title hit .80, admin .75), which does not change what is decided.

#### Scenario: Ambiguous registry hit
- **WHEN** a fragment's project keys match two initiatives
- **THEN** it stays open with both as candidates and no decision

#### Scenario: A word that only contains a keyword
- **WHEN** a run's text says "private" (which contains `vat`) and nothing about invoices or tax
- **THEN** the admin rung does not decide it

#### Scenario: A marker before admin
- **WHEN** a run with an exclusive-marker counterpart mentions a contract
- **THEN** the exclusive marker decides it, not the admin bucket

### Requirement: Fragments are deterministic and stable
The layer SHALL cut the subject's days into fragments — one per call (one per summary topic when there are several), one per run of the subject's own messages in a container with gaps of at most the configured minutes, one per work block — with ids that depend only on the underlying records, so the same inputs always yield the same ids and decisions recorded against an id stay attached. The recorder copies of one call SHALL be one call: the copies the store's call clustering joins (`meetings.call_id`) never become two calls; the call is named by its first copy that has a window of its own (by start, then recorder priority, then id — a zero-length Gemini doc, which lands late, never renames a call), never by row order; and a ledger record or pin recorded under any one copy's own id SHALL stay attached to the merged call.

#### Scenario: Rebuild
- **WHEN** the store is rebuilt from raw with the same records
- **THEN** every fragment id is the same as before

#### Scenario: Two recorders, a zero-length Gemini window
- **WHEN** a call was recorded by Granola and by Gemini, whose copy has no end time
- **THEN** the layer cuts one call from them, as the store's call clustering does

#### Scenario: Judged, then a twin copy lands
- **WHEN** a person judged a call and later a Gemini doc of the same call lands with an earlier start
- **THEN** the call keeps its id and the judgment, and nothing new is pinned

## ADDED Requirements

### Requirement: Call participants
The people of a call fragment SHALL be resolved from every recorder copy's attendees — names as well as addresses, with a person's own name counting as an identity unless two people share it — from glued attendee strings split against the roster, the linked calendar event (start within 15 minutes, equal normalised title) and the transcript's speaker labels; a string that cannot be split is never asked about.

#### Scenario: A name-only Gemini invitee
- **WHEN** a Gemini copy lists a known person by name only
- **THEN** that person is a participant of the call, and their markers apply

### Requirement: Recipients of a run
The people of a message run SHALL include the recipients the store recorded for its messages (`role = 'to'`), and a group DM (`mpim:`) SHALL count as a direct conversation for the identities readout.

#### Scenario: A mail sent to a client
- **WHEN** the subject's run is mail to one client contact from the Sent folder
- **THEN** that contact is a participant of the run
