# Spec Delta

## REMOVED Requirements

### Requirement: A conversation marked as holding another domain's data takes no file uploads
**Reason**: The refusal made outbound files unusable together with agent messaging — a file built on another
domain's answer can only come from a conversation that holds that answer — and its "bytes stay in the sandbox" half
contradicted *The outbox is drained*.
**Migration**: None for operators or projects. Replaced by *A marked conversation's files are posted with the
marker*: the files arrive in the conversation and the project's chat sources skip the post.

## ADDED Requirements

### Requirement: A marked conversation's files are posted with the marker
In a conversation the bot marks as holding another domain's data, outbound files SHALL be posted as in any other
conversation, and the post SHALL carry the marker the project's chat sources skip, so that neither the post nor a
record of its files enters the project's store.

#### Scenario: Marked thread on Slack
- **WHEN** a turn in a marked Slack conversation saves `chart.png`
- **THEN** `chart.png` appears in the thread after the answer, and the project's Slack source ingests neither a
  message nor a file record for that post

#### Scenario: Unmarked thread is unchanged
- **WHEN** a turn in a conversation without marks posts `chart.png`
- **THEN** the post carries no marker, and the project's Slack source ingests it as it does today

#### Scenario: Marked during the turn
- **WHEN** another domain's answer reaches the conversation while the turn runs, and the turn then saves a file
- **THEN** the file is posted with the marker

#### Scenario: Recovered after a restart
- **WHEN** the bot restarts during a turn of a marked conversation and the recovery finds a file in the turn's
  directory
- **THEN** the file is posted with the marker, as it would be live

#### Scenario: Marked room on the web
- **WHEN** a turn in a marked web room saves `orders.csv`
- **THEN** the thread offers `orders.csv` as a download, as in any room (no chat source reads the web chat)
