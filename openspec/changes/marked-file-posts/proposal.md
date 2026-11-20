# Proposal

## Why

A conversation that received another domain's answer (agent-messaging D14) refuses every outbound file: the person
gets "can't attach files in this thread … ask again in a thread without that data". For the main cross-domain use —
ask a client's agent, get a report file built on its answer — that advice cannot be followed: the file *is* that
data, so no thread without it can produce the file. Outbound files and agent messaging are therefore unusable
together. The refusal also contradicts the spec it implements: the requirement says the bytes stay in the sandbox,
while the outbox is drained before the refusal, so the file is gone.

The refusal exists for one reason: a Slack file upload cannot carry the message metadata by which the project's own
Slack source skips the bot's marked posts. What an unmarked file post would put into the store is the file's name
and record, not its content — and that gap can be closed by marking the file post in a way an upload does accept.

## What Changes

- In a marked conversation the agent's files are posted like in any other conversation. The refusal notice goes.
- The file post carries a marker the project's chat sources recognise, so neither a message nor a file record of it
  enters the project's store. On Slack the marker rides on the post's blocks (an upload takes blocks, not message
  metadata) and shows as one short line under the file.
- The Slack source skips a marked post by either carrier — message metadata (today's text posts) or the block marker
  (file posts) — and writes no file records for a marked post.
- The web chat posts files in a marked room as in any room: no chat source reads the web chat's history.
- The defect goes with the refusal: there is no path left on which the outbox is drained and nothing is delivered.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `outbound-files`: the requirement *A conversation marked as holding another domain's data takes no file uploads* is
  removed and replaced by one that posts the files with the marker the project's chat sources skip.

`agent-messaging` is not modified: its marks requirement already says the bot's posts in a marked conversation carry
a marker and the chat sources do not ingest them. File posts were the one exception; this change ends it.

## Impact

- **Rollout bucket 3, under the existing gate `OUTBOUND_FILES=1`** — no new flag. Flag unset: nothing is read from
  the sandbox and nothing is posted, as today (the recorded "flag off" turn proves it). Flag set (the canary and
  production today): only a marked conversation changes — a file post where a refusal notice is posted now. Only
  projects with a `messaging` configuration can have marked conversations. The change reaches a later stage only
  after the stage below ran it; the ledger row of `outbound-files` in `docs/rollout.md` is updated in the same PR.
- **Sources (reaches production with the next tag):** `src/sources/slack/normalise.ts` — a post is marked by metadata
  or by the block marker; a marked post yields no file records. Default-preserving: a post without either marker is
  ingested exactly as today, pinned by a test.
- **Code:** `src/turn.ts` (the refusal branch in the outbox post goes), `src/outbox.ts` (`outboxMarkedNotice` goes),
  `src/chat/slack/driver.ts` (`postFiles` adds the marker block for a marked target), `src/chat/driver.ts` (the
  comment on `marked` covers file posts), tests and the recorded turn `src/fixtures/chat/turn/outbox-marked.json`
  (re-recorded on purpose).
- **Slack app:** no manifest change (`files:write` is granted; blocks on an upload need no further scope).
- **Home tab:** no change — the *Share files* line does not mention marked conversations.
- **Out of scope:** the Teams driver (it declares no file delivery); a marker for files a *person* uploads in a
  marked thread (people's posts are never marked — a person is the release D14 relies on); Slack-side visibility of
  the file to the channel's members (the same as any upload); reading Google Drive content (a separate change).
