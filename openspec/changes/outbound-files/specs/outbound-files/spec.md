# Spec Delta

## Purpose

Files the agent produces for the person during a turn — a chart, a screenshot, a PDF, a CSV — reach the conversation
the turn was asked in, on the surfaces that can carry them, with the same admission rules as files coming in.

## ADDED Requirements

### Requirement: An outbox is named per turn
With outbound files enabled and on a surface that delivers files, every turn's message SHALL name a directory unique
to that turn in the project's sandbox, and the agent SHALL be told that files saved there are posted into the
conversation after its answer.

#### Scenario: A chart saved for the person
- **WHEN** the agent saves `chart.png` in the turn's directory and answers
- **THEN** the answer is posted, then `chart.png` appears in the same conversation (the same thread) as a file

#### Scenario: Nothing saved
- **WHEN** a turn ends with the directory empty or absent
- **THEN** nothing but the answer is posted and no notice is shown

#### Scenario: Two turns of one project at once
- **WHEN** two conversations of the same project run turns at the same time and each saves a file
- **THEN** each conversation receives its own file and neither sees the other's

#### Scenario: Restart mid-turn
- **WHEN** the bot restarts while a turn runs and the agent had saved a file in the turn's directory
- **THEN** after the recovery the answer is followed by the file (or by the notice naming it), as it would be live

### Requirement: A conversation marked as holding another domain's data takes no file uploads
In a conversation the bot marks as holding another domain's data, outbound files SHALL not be uploaded; a marked text
notice SHALL name them instead, and the bytes SHALL stay in the sandbox.

#### Scenario: Marked thread
- **WHEN** a turn in a marked conversation saves `chart.png`
- **THEN** no upload happens and a marked notice names `chart.png` (the project's own sources skip it like every
  marked post)

### Requirement: Outbound admission matches inbound
A file in the outbox SHALL be posted only when it is of a type the inbound side accepts (images, PDFs, text, data and
office documents), at most 25 MB, and within the first 10 regular files of the directory in name order; anything
else SHALL be named in the conversation with the reason.

#### Scenario: Unsupported type
- **WHEN** the outbox holds `clip.mov` and `chart.png`
- **THEN** `chart.png` is posted and a notice names `clip.mov` as an unsupported type

#### Scenario: Over the count
- **WHEN** the outbox holds eleven supported files
- **THEN** ten are posted and the eleventh is named as over the limit

#### Scenario: Not a regular file
- **WHEN** the outbox holds a subdirectory or an empty file
- **THEN** it is ignored without a notice

### Requirement: Text files are scrubbed like answers
A text-typed outbound file (text, markdown, CSV, JSON, YAML, logs) SHALL pass the same secrets scrub an answer passes,
honouring the project's opt-out; binary files (images, PDFs, office documents) SHALL be posted as written.

#### Scenario: A token in a log excerpt
- **WHEN** the agent saves `debug.log` containing a GitHub token
- **THEN** the posted file carries the token redacted the way an answer would

#### Scenario: Project opted out
- **WHEN** the project's config turns the secrets scrub off
- **THEN** the file is posted unchanged

### Requirement: The outbox is drained
After a turn's files were read, its directory SHALL be removed from the sandbox; directories of other turns SHALL be
left alone.

#### Scenario: Next turn starts clean
- **WHEN** a turn posted its files and the next turn of the same conversation starts
- **THEN** the next turn's directory is a different one and does not contain the earlier files

### Requirement: Delivery failure never fails the turn
A failure while reading or posting outbound files SHALL leave the already delivered answer standing and SHALL be
named in the conversation; it SHALL not turn the turn into an error.

#### Scenario: The platform refuses the upload
- **WHEN** the chat platform answers the upload with an error
- **THEN** the answer stays, a notice names the file that could not be posted, and the turn settles as answered

### Requirement: Off by default and off where undeliverable
With outbound files disabled, or on a surface that reports no file delivery, no directory SHALL be named, nothing
SHALL be read from the sandbox, and prompts and posts SHALL be identical to today's.

#### Scenario: Flag unset
- **WHEN** `OUTBOUND_FILES` is unset
- **THEN** the system prompt, the turn's message and the platform calls of a turn are byte-identical to the recorded
  ones

#### Scenario: A surface without delivery
- **WHEN** the flag is set and the turn runs on a surface whose driver reports no file delivery (Teams today)
- **THEN** the turn's message names no directory, the session's prompt carries no outbox paragraph, and nothing is
  pulled after the answer

### Requirement: Slack delivers files into the thread
On Slack, outbound files SHALL be uploaded into the conversation and thread the turn ran in, so the platform's own
previews (images, PDFs, text) render there.

#### Scenario: A PNG in a channel thread
- **WHEN** a turn in a channel thread posts `chart.png`
- **THEN** the file appears as a reply in that thread with Slack's image preview

### Requirement: The web delivers files as downloads
On the web, an outbound file SHALL be stored beside the conversation and offered in the thread as a download that
only the room's members (or, in a private conversation, that person) can fetch; an image SHALL also be shown inline.

#### Scenario: A CSV in a room
- **WHEN** a turn in a room posts `orders.csv`
- **THEN** the thread shows `orders.csv` with its size, the link downloads it with a session, and a stranger's fetch
  of the same link is refused

#### Scenario: An image in a room
- **WHEN** a turn in a room posts `chart.png`
- **THEN** the thread shows the image itself

### Requirement: The Home cheat-sheet names the way back
With outbound files enabled, the Slack and web Home cheat-sheets SHALL say that files can come back to the thread
and name what to ask for; with the flag off, or on Teams, the sheet SHALL be unchanged.

#### Scenario: Flag on, Slack
- **WHEN** an operator opens the App Home on an installation with the flag set
- **THEN** the *Share files* line says the bot can send files back
