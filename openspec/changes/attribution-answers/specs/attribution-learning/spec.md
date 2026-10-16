# Spec Delta

## ADDED Requirements

### Requirement: The review asks through a numbered post
Wherever the learning loop is on, the sources table SHALL offer `ask({questions?, audits?, max?})`: it SHALL take question ids from the loop's ranked queue and/or `audits: true` for the day's audit sample, number them in that order, persist the numbered post — with the loop's guess, each unit's confidence and rung instance and the covered units as they stand at that moment — outside the tenant repo on the ingest host (`data/<slug>/attribution/asks.jsonl`), and return the post id and the list: ids, form, guess, the units' days and titles or subjects, never message text.

#### Scenario: A post survives a lost session
- **WHEN** the evening review posts the numbered list and the bot restarts before the person replies
- **THEN** `answer({post, text})` in the person's reply turn still resolves the numbers against the stored post

#### Scenario: A question the queue does not have
- **WHEN** `ask` names a question id that today's queue does not hold
- **THEN** the reply lists it as unknown and numbers the rest

### Requirement: A reply is resolved mechanically
`answer({post, text})` SHALL resolve the person's reply by a fixed grammar — numbered items, ranges and lists; a confirm word for an item that has a guess; a label that is an exact id of the label space, a token matching exactly one entry by its last segment or registry name, or a special label — and SHALL return everything else unresolved with its text, writing nothing for it. `answer({post?, items: [{question, label | confirm}]})` SHALL accept the agent's structured reading, and a line written from it SHALL say so in its rationale.

#### Scenario: Yes, no, a name
- **WHEN** the reply to a three-item post is "1 yes, 2 no, 3 shop" and exactly one label's last segment is `shop`
- **THEN** item 1 is answered with its guess, item 3 with that label, and item 2 comes back unresolved — a rejection without a label teaches nothing

#### Scenario: A sentence
- **WHEN** the reply says "the second one is what we discussed on Monday"
- **THEN** nothing is written and the item comes back unresolved with that text, for the agent to ask again or to pass as a structured item

### Requirement: The decider is attested by the platform
The person of an evidence line SHALL be the author of the chat message the turn answers, as the chat driver normalised it and the turn engine recorded it, mapped to a person id through the tenant's people file — an identity of the platform user id first, else the e-mail; the tool SHALL take no `by` and SHALL ignore one in its input; an author the people file does not know, or a turn without an author, SHALL be refused with nothing written and the reply naming the identity to add.

#### Scenario: The owner answers in the thread
- **WHEN** a person whose Slack user id is listed under their person id replies in the review thread and the agent calls `answer`
- **THEN** every line written carries `decided_by: "human:<their person id>"` (`by` for an item)

#### Scenario: A stranger, or a routine
- **WHEN** the reply's author is not in the people file, or the call arrives in a scheduled turn that no person started
- **THEN** the call is refused, no line is written, and the message says which identity to add

#### Scenario: A spoofed decider
- **WHEN** the agent's input carries `by: "human:someone"` or a `_meta.actor` of its own
- **THEN** both are ignored and the person the platform attested is written

### Requirement: Answers become evidence lines and are seen at once
A resolved answer SHALL append one decided line per covered unit into the tenant checkout — `fragments.jsonl` for fragments (kind, window, refs, the label as the single attribution, `answer`, `guess`, `conf`, `rung`, `audit` when the item was an audit), `labels.jsonl` for items — carrying the guess, confidence and rung the post recorded, validating every label against the label space and refusing an outside label per item; before returning, the call SHALL recompute the derived, attribution and learning tables and publish the replica, and SHALL return the effect: units decided, units already answered, calibration instances moved, questions and audits left today, unresolved and refused items.

#### Scenario: A client-day answered
- **WHEN** a client-day question covering four fragments is answered with one label
- **THEN** four lines with one `answer` id land in `fragments.jsonl`, the reply counts four decided, and `attribution({learn: true})` in the same turn shows them `answered` and the question gone from the queue

#### Scenario: A typo
- **WHEN** an item's label is not in the label space
- **THEN** that item is refused with the nearest ids, nothing is written for it, and the other items proceed

#### Scenario: An audit confirmed
- **WHEN** the person confirms an audit item
- **THEN** its line carries `audit: true`, the loop's decision as `guess`, and the answer id `audit:<day>:<unit>`

### Requirement: Idempotent by answer and unit
The answer id of a line SHALL be the question's id and day (`q:<day>:<group>`, `audit:<day>:<unit>`), not the post's; a unit that already has a live person line with that answer id and label SHALL get no second line, and a different label SHALL be written as a correction.

#### Scenario: The same reply twice
- **WHEN** the agent calls `answer` twice with the same post and text
- **THEN** the second call writes nothing and reports the units as already answered

#### Scenario: A correction
- **WHEN** the person answers the same question again with another label
- **THEN** one more line per unit is written and the loop counts the later one

### Requirement: One writer for the ledgers
While a tenant's answers go through the platform (`learn.writer: "platform"`), the tenant's own tooling SHALL NOT write `fragments.jsonl` or `labels.jsonl`; the platform SHALL append only — never rewrite, reorder or remove a line — and SHALL commit the tenant repo once per `answer` call and push it with a credential minted for that push, leaving a failed push to the next pull.

#### Scenario: The push fails
- **WHEN** the push after an answer is refused
- **THEN** the call still reports the effect, the readout carries the answer, the log names the failure, and the next pull rebases and pushes the commit

### Requirement: The writer is opt-in twice and served where the checkout lives
`answer` SHALL write only when the tenant's attribution.json says `learn.writer: "platform"` and the ingest process runs with `SOURCES_TENANT_WRITE=1`, refusing otherwise and naming the missing gate; `ask` SHALL work whenever the loop is on; both SHALL be served only by the process that ingests the project (the daemon, or the bot's poller when there is no daemon), and every read-only face SHALL answer that it does not serve them.

#### Scenario: Today's tenant
- **WHEN** a tenant's attribution.json has `learn` without `writer`
- **THEN** `answer` refuses and names the key, and nothing else about the loop changes

#### Scenario: Through the remote face
- **WHEN** `answer` is called against `orch sources serve`
- **THEN** it answers that the tool is not served on that face and the store is untouched
