# Spec Delta

## ADDED Requirements

### Requirement: The review asks through a numbered post
Wherever the learning loop is on, the sources table SHALL offer `ask({questions?, audits?, max?})`: it SHALL take question ids from the loop's ranked queue and/or `audits: true` for the day's audit sample, number them in that order, persist the numbered post — with the loop's guess, each unit's confidence and rung instance and the covered units as they stand at that moment — outside the tenant repo on the ingest host (`data/<slug>/attribution/asks.jsonl`), and return the post id and the list: ids, form, guess, and per unit its day and a heading — a fragment's title as the attribution readout holds it; an item's structural fields only (`type`, `source`, `container`, sender class, `case`, the floor's hint, the ref), exactly as the item readout shows them — and never message text: the store's `subject` column SHALL NOT appear unless the store marks it as the mail's own subject, and a derived one (a channel reply's `re:` line, built from its parent's body) SHALL never appear.

#### Scenario: A post survives a lost session
- **WHEN** the evening review posts the numbered list and the bot restarts before the person replies
- **THEN** `answer({post, text})` in the person's reply turn still resolves the numbers against the stored post

#### Scenario: A Teams channel reply
- **WHEN** a question covers a Teams channel reply whose stored subject the normaliser derived from the parent's body (`re: <the parent's first line>`)
- **THEN** the post on disk and the tool's reply carry the reply's day, type, source, container, sender class, case and hint, no `subject`, and no word of the parent's body

#### Scenario: A question the queue does not have
- **WHEN** `ask` names a question id that today's queue does not hold
- **THEN** the reply lists it as unknown and numbers the rest

### Requirement: A reply is resolved mechanically
`answer({post, text})` SHALL resolve the person's reply by a fixed grammar — numbered items, ranges and lists; a confirm word for an item that has a guess; a label that is an exact id of the label space, a token matching exactly one entry by its last segment or registry name, or a special label — and SHALL return everything else unresolved with its text, writing nothing for it. `answer({post, items: [{question, label | confirm}]})` SHALL accept the agent's structured reading against the same post, and a line written from it SHALL say so in its rationale. `post` is required in both forms — the post is the only source of a line's guess, confidence, rung and day — and a call without one SHALL be refused with nothing written.

#### Scenario: Yes, no, a name
- **WHEN** the reply to a three-item post is "1 yes, 2 no, 3 shop" and exactly one label's last segment is `shop`
- **THEN** item 1 is answered with its guess, item 3 with that label, and item 2 comes back unresolved — a rejection without a label teaches nothing

#### Scenario: A sentence
- **WHEN** the reply says "the second one is what we discussed on Monday"
- **THEN** nothing is written and the item comes back unresolved with that text, for the agent to ask again or to pass as a structured item

#### Scenario: Items without a post
- **WHEN** the agent calls `answer({items: [{question: "<group id>", label: "x"}]})` with no `post`
- **THEN** the call is refused as malformed, nothing is written, and the reply says to `ask` first

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
While a tenant's answers go through the platform (`learn.writer: "platform"`), the tenant's own tooling SHALL NOT write `fragments.jsonl` or `labels.jsonl`; the platform SHALL append only — never rewrite, reorder or remove a line — and SHALL commit the tenant repo once per `answer` call and push it to the tenant's branch — `sources.tenant.ref`, else the remote's default branch as the pass resolved it (`sources-daemon`) — with a credential minted for that push, leaving a failed push to the next pull; while the last pass resolved no push target, `answer` SHALL refuse before writing and name `sources.tenant.ref`.

#### Scenario: The push fails
- **WHEN** the push after an answer is refused
- **THEN** the call still reports the effect, the readout carries the answer, the log names the failure, and the next pull rebases and pushes the commit

#### Scenario: No push target
- **WHEN** the last pass could not resolve the tenant's branch (a detached remote HEAD, or a `ref` the remote has no branch for)
- **THEN** `answer` is refused, nothing is appended or committed, and the message says to set `sources.tenant.ref`

### Requirement: The writer is opt-in twice and served where the checkout lives
`answer` SHALL write only when the tenant's attribution.json says `learn.writer: "platform"` and the ingest process runs with `SOURCES_TENANT_WRITE=1`, refusing otherwise and naming the missing gate; `ask` SHALL work whenever the loop is on; both SHALL be served only by the process that ingests the project (the daemon, reached by forwarding; or the bot's poller when the bot ingests), and every read-only face — the stdio server, `orch sources serve`, and the bot's channel when `SOURCES_DAEMON=1` leaves ingestion to a same-host daemon the project does not forward to — SHALL answer that it does not serve them, naming `sources.daemon` as the fix where forwarding is what is missing.

#### Scenario: Today's tenant
- **WHEN** a tenant's attribution.json has `learn` without `writer`
- **THEN** `answer` refuses and names the key, and nothing else about the loop changes

#### Scenario: Through the remote face
- **WHEN** `answer` is called against `orch sources serve`
- **THEN** it answers that the tool is not served on that face and the store is untouched

#### Scenario: A same-host daemon without forwarding
- **WHEN** the bot runs with `SOURCES_DAEMON=1` and the project has no `sources.daemon`
- **THEN** `ask` and `answer` over the channel answer that they are not served on this face and name `sources.daemon`, while `search` still answers from the replica
