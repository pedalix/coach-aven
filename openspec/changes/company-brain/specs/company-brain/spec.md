# Spec Delta

## Purpose

The company brain turns a project's agent-written memory into records a team can rely on: each record has a kind,
an investigation has a status and a log of what was answered, the host derives how each record was used and
whether a person ever corrected it, and a nightly tidy the host starts by itself keeps the set consistent. It is part of every project: no flag, no
switch, and no separate dream.

## ADDED Requirements

### Requirement: Every project has it
The system SHALL apply this capability to every project of every installation, with no flag and no per-project
switch.

#### Scenario: A project that never wrote a record
- **WHEN** a turn ends in a project whose memory holds no record
- **THEN** no `brain/` directory is created for it and no tidy ever starts

### Requirement: A record names its kind
The system SHALL tell the agent, in the system prompt, that a memory record carries a `kind` of `investigation`,
`domain`, `method` or `decision` in its frontmatter, and what each kind is for.

#### Scenario: The four kinds
- **WHEN** the agent writes a record about one ticket or incident
- **THEN** the prompt asks for `kind: investigation`
- **AND** for how a business concept or flow works it asks for `domain`, for how to count, query or check
  something `method`, and for why something was built or changed `decision`

#### Scenario: A record without a kind stays readable
- **WHEN** a record written before this capability has no `kind`
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
kind, status, ticket, provenance, last change) and a lint report.

#### Scenario: What the lint reports
- **WHEN** the index is rebuilt
- **THEN** the lint lists records without a kind, investigations without a status, investigations `open` for more
  than 30 days, several records for one ticket, index lines without a file and files without an index line, and
  records in which a personal-data pattern (an e-mail address, a phone number) is found

#### Scenario: The tracker has resolved the ticket
- **WHEN** the nightly check finds an `open` investigation whose ticket the project's tracker reports resolved
- **THEN** the lint lists it, and the host does not change the record itself

#### Scenario: No tracker
- **WHEN** the project has no tracker the host reads
- **THEN** no tracker call is made and the other findings are unaffected

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

#### Scenario: A private conversation
- **WHEN** the turn belongs to a direct message or to a command's own conversation
- **THEN** nothing is logged, so another person's `brain_history` never returns it

### Requirement: The agent can ask for a ticket's history
The system SHALL serve the agent a host tool that, for a ticket or a record name, returns the record's provenance
and the logged answers oldest first, each with its date, its thread link, its text and the number of later turns
in that conversation.

#### Scenario: A ticket answered before
- **WHEN** the agent asks for the history of a ticket with two logged answers
- **THEN** both are returned, and the second shows that the first conversation had no later turn

#### Scenario: Another project's ticket
- **WHEN** the agent asks for a ticket whose answers were logged for a different project
- **THEN** nothing is returned

### Requirement: The host logs which records a turn used
The system SHALL append one entry to the project's use log for every turn that read or changed a memory record:
the time, the conversation, what started the turn (a person, a routine, a poller) and the record names, without
any message or answer text.

#### Scenario: A turn read a method record
- **WHEN** a turn started by a person reads a `method` record and changes none
- **THEN** the use log gains an entry naming that record as read

#### Scenario: A turn touched no record
- **WHEN** a turn neither reads nor changes a record
- **THEN** nothing is logged

#### Scenario: Another conversation changed a record
- **WHEN** a turn ends and the mirror finds a changed record that no tool input of that turn named
- **THEN** the record is mirrored and the turn's entry does not name it as changed

#### Scenario: The first mirror of a project
- **WHEN** a project's first mirror copies every existing record
- **THEN** only the records that turn named are logged as used

### Requirement: The host derives a record's provenance
The system SHALL derive for each record, from the use log and the mirror alone, how many turns started by a
person used it, the date of the last one, and the date it was last revised after a person's reply.

#### Scenario: Revised after a reply
- **WHEN** a turn started by a person's message changes a record that an earlier turn of the same conversation
  read or changed
- **THEN** the record's provenance carries that date as revised after a person's reply

#### Scenario: Used without objection
- **WHEN** a record was read in twelve turns and never changed in a conversation that had used it
- **THEN** its provenance says twelve uses and no revision after a reply — it is not reported as checked

#### Scenario: A routine's turn
- **WHEN** a tidy or a routine changes a record
- **THEN** the use count and the revision date stay as they were

#### Scenario: The agent cannot set it
- **WHEN** a record's frontmatter claims a check or a revision
- **THEN** the provenance the host reports is unaffected

### Requirement: The agent says when an answer rests on an unchecked record
The system SHALL tell the agent, in the system prompt, to say so in its answer when a figure or a rule it states
comes from a record that no person's reply has revised.

#### Scenario: An unchecked counting method
- **WHEN** the agent answers with a figure it derived by a `method` record with no revision after a reply
- **THEN** the prompt has asked it to say in the first lines of the answer that the method is its own note,
  checked by nobody

### Requirement: The host tidies memory at night from the lint
The system SHALL start, once a night per project and only when that project's lint holds a finding still due,
one tidy turn that is given at most 15 findings, oldest first, and asked to resolve them in memory only.

#### Scenario: Nothing to tidy
- **WHEN** the night's check finds a project's lint empty
- **THEN** no turn starts and a stopped sandbox stays stopped

#### Scenario: Two records for one ticket
- **WHEN** the lint lists two records for one ticket
- **THEN** the tidy is asked to merge them or to state in each what the other covers

#### Scenario: Personal data
- **WHEN** the lint lists a record with a personal-data pattern
- **THEN** the tidy is asked to remove the personal data and keep the finding

#### Scenario: Memory only
- **WHEN** a tidy runs
- **THEN** its prompt forbids changing code, branches, pull requests and the repositories' instruction files
- **AND** it does not read session transcripts

#### Scenario: Nobody is told
- **WHEN** a tidy ends
- **THEN** nothing is posted to a chat; the journal holds what changed and the usage record holds its cost

### Requirement: A finding that survives three tidies stops starting them
The system SHALL count, per finding, the tidy turns it was given to, and SHALL NOT start a tidy for findings
given three times and still present; they stay in the lint report.

#### Scenario: A false positive
- **WHEN** a personal-data finding is still listed after three tidies were given it
- **THEN** it no longer starts a tidy, and `memory open` and the lint still show it

#### Scenario: The record changes
- **WHEN** a record with such a finding is changed by a later turn
- **THEN** the finding is due again

### Requirement: Changed project instructions are a finding
The system SHALL note, at each mirror, a digest of each repository's `CLAUDE.md`, and SHALL list one finding per
project when a digest differs from the one the last tidy saw.

#### Scenario: The instructions changed
- **WHEN** a repository's `CLAUDE.md` changed since the last tidy
- **THEN** the next tidy is asked to bring records that contradict it into agreement with it, never to edit it
- **AND** after that tidy the finding is gone

#### Scenario: Nothing changed
- **WHEN** no `CLAUDE.md` differs
- **THEN** there is no such finding

#### Scenario: The first digest
- **WHEN** the host notes a repository's digest for the first time
- **THEN** it is the baseline and no finding is listed

### Requirement: There is no separate dream
The system SHALL NOT offer a dream command, a dream routine or a dream schedule; a dream routine found in the
stored state SHALL be removed at boot.

#### Scenario: An installation that had a nightly dream
- **WHEN** the bot starts with a stored dream routine
- **THEN** the routine is removed, its project is tidied by the nightly check like any other, and the removal is
  logged once

#### Scenario: The old command
- **WHEN** a person sends the former `dream` verb
- **THEN** it is answered like any unknown verb

### Requirement: People can list open and unchecked records
The system SHALL answer `memory open` and `memory unchecked` from the host index, without starting the project's
sandbox.

#### Scenario: Open investigations
- **WHEN** a person runs the `memory open` form in a project channel
- **THEN** they get the project's investigations with status `open`, oldest first, each with its ticket and age

#### Scenario: Unchecked records
- **WHEN** a person runs the `memory unchecked` form in a project channel
- **THEN** they get the `method` and `domain` records never revised after a reply, most used first, each with
  its use count

#### Scenario: The sandbox is stopped
- **WHEN** the project's sandbox is stopped by the idle stop
- **THEN** both forms answer and the sandbox stays stopped
