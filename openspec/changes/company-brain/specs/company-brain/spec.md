# Spec Delta

## Purpose

The company brain turns a project's agent-written memory into records a team can rely on: each record has a kind,
an investigation has a status and a log of what was answered, a person can confirm a record, and a nightly pass
keeps the set consistent. Everything here exists only on an installation that sets `BRAIN=1`.

## ADDED Requirements

### Requirement: The flag gates every behaviour
The system SHALL add no prompt text, control, command form, host tool, file or dream instruction of this capability
unless the installation sets `BRAIN=1`.

#### Scenario: Flag unset
- **WHEN** an installation runs without `BRAIN=1`
- **THEN** the system prompt, the dream prompt, the Home text and every recorded turn are byte-identical to the
  ones before this capability
- **AND** no `brain/` directory is created

### Requirement: A record names its kind
The system SHALL tell the agent, in the system prompt, that a memory record carries a `kind` of `investigation`,
`domain`, `method` or `decision` in its frontmatter, and what each kind is for.

#### Scenario: The four kinds
- **WHEN** the agent writes a record about one ticket or incident
- **THEN** the prompt asks for `kind: investigation`
- **AND** for how a business concept or flow works it asks for `domain`, for how to count, query or check
  something `method`, and for why something was built or changed `decision`

#### Scenario: A record without a kind stays readable
- **WHEN** a record written before the flag has no `kind`
- **THEN** the agent can still read it, and the lint report lists it

### Requirement: An investigation carries a ticket and a status
The system SHALL ask for a `status` of `open`, `answered`, `fixed` or `closed` on every `investigation` record, and
for a `ticket` when the investigation belongs to one.

#### Scenario: Status is in the frontmatter, not the prose
- **WHEN** an investigation's outcome changes
- **THEN** the agent is asked to change the `status` value rather than append a paragraph that contradicts the
  record's opening

### Requirement: The host mirrors memory after a turn
The system SHALL copy the project's changed memory records to the host when a turn ends, and keep each version it
copied.

#### Scenario: A turn changed a record
- **WHEN** a turn ends and a record's content differs from the host's copy
- **THEN** the host's copy is updated before the next turn of that project starts
- **AND** the earlier version stays retrievable

#### Scenario: A turn changed nothing
- **WHEN** a turn ends and no record differs
- **THEN** no file is read back from the sandbox beyond the listing that showed it

#### Scenario: The mirror fails
- **WHEN** the listing or a read-back fails
- **THEN** the turn's answer is delivered as usual and the failure is logged

### Requirement: The host keeps an index and a lint report
The system SHALL derive, from the mirrored records alone and without a model, an index of every record (name,
kind, status, ticket, confirmation, last change) and a lint report.

#### Scenario: What the lint reports
- **WHEN** the index is rebuilt
- **THEN** the lint lists records without a kind, investigations without a status, investigations `open` for more
  than 30 days, several records for one ticket, index lines without a file and files without an index line, and
  records in which a personal-data pattern (an e-mail address, a phone number) is found

### Requirement: The host logs what was answered
The system SHALL append one entry to the project's answer log for every turn that read or changed an
`investigation` record: the time, the conversation, the asker, the question as the agent received it, the answer
as posted, and the records involved.

#### Scenario: A turn about a ticket
- **WHEN** a turn reads the record of a ticket and posts an answer
- **THEN** the answer log gains an entry that names that record and links the thread

#### Scenario: A turn that touched no investigation
- **WHEN** a turn reads only `domain` or `method` records, or none
- **THEN** nothing is logged

#### Scenario: A marked conversation
- **WHEN** the turn belongs to a marked (cross-domain) or shadow conversation
- **THEN** nothing is logged

### Requirement: The agent can ask for a ticket's history
The system SHALL serve the agent a host tool that, for a ticket or a record name, returns the logged answers
oldest first, each with its date, its thread link, its text and the number of later turns in that conversation.

#### Scenario: A ticket answered before
- **WHEN** the agent asks for the history of a ticket with two logged answers
- **THEN** both are returned, and the second shows that the first conversation had no later turn

#### Scenario: Another project's ticket
- **WHEN** the agent asks for a ticket whose answers were logged for a different project
- **THEN** nothing is returned

### Requirement: A person can confirm the records a turn changed
The system SHALL show a *Confirm* control on the answer of a turn that created or changed memory records, and on
its use by a person who may drive the agent SHALL mark exactly those records confirmed at their current content.

#### Scenario: Confirming
- **WHEN** a turn changed two records and a person uses *Confirm*
- **THEN** both records show a confirmation date, and the host keeps who confirmed which version

#### Scenario: No record changed
- **WHEN** a turn changed no record
- **THEN** its answer carries no *Confirm* control

#### Scenario: A viewer
- **WHEN** a person who may not drive the agent uses the control
- **THEN** nothing is marked and they get the usual denial

### Requirement: A confirmation holds for one version
The system SHALL treat a record as confirmed only while its content equals the content that was confirmed.

#### Scenario: The agent edits a confirmed record
- **WHEN** a confirmed record's content changes
- **THEN** the mark is removed at the next mirror and the lint lists the record as changed since confirmation

#### Scenario: A mark nobody gave
- **WHEN** a record carries a confirmation mark the host has no entry for
- **THEN** the mark is removed at the next mirror

### Requirement: The agent says when an answer rests on an unconfirmed record
The system SHALL tell the agent, in the system prompt, to say so in its answer when a figure or a rule it states
comes from a record without a confirmation mark.

#### Scenario: An unconfirmed counting method
- **WHEN** the agent answers with a figure it derived by an unconfirmed `method` record
- **THEN** the prompt has asked it to name the record as unconfirmed in the first lines of the answer

### Requirement: The dream tidies from the lint
The system SHALL give the dream turn the current lint report and ask it to resolve the listed findings in memory
only, at most 15 records per dream.

#### Scenario: Two records for one ticket
- **WHEN** the lint lists two records for one ticket
- **THEN** the dream is asked to merge them or to state in each what the other covers

#### Scenario: Personal data
- **WHEN** the lint lists a record with a personal-data pattern
- **THEN** the dream is asked to remove the personal data and keep the finding

#### Scenario: Still memory-only
- **WHEN** a dream runs with the flag
- **THEN** its prompt still forbids changing code, branches and pull requests

### Requirement: People can list open and unconfirmed records
The system SHALL answer `memory open` and `memory unconfirmed` from the host index, without starting the project's
sandbox.

#### Scenario: Open investigations
- **WHEN** a person runs the `memory open` form in a project channel
- **THEN** they get the project's investigations with status `open`, oldest first, each with its ticket and age

#### Scenario: The sandbox is stopped
- **WHEN** the project's sandbox is stopped by the idle stop
- **THEN** both forms answer and the sandbox stays stopped
