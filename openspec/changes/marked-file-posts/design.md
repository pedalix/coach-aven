# Design

## Context

See `proposal.md` for the motivation. The facts the approach rests on:

- The engine refuses in one place: `postOutbox` in `src/turn.ts` posts `outboxMarkedNotice` when the target is
  marked. `collectOutbox` (`src/outbox.ts`) has already read the files and removed the turn's directory by then.
- A marked text post carries Slack message metadata (`event_type: aven_marked`); the Slack source drops such a
  message in `normaliseMessage` (`src/sources/slack/normalise.ts`). `normaliseFiles` has no such check — it never
  needed one, since a marked post had no files.
- The Slack upload is `files.uploadV2` → `files.completeUploadExternal`. In `@slack/web-api` 7.17.0 (the version
  in `package-lock.json`) that call takes `files`, the destination, `initial_comment` and `blocks`; no `metadata`.
  The SDK forwards a top-level `blocks` of `uploadV2` to it (`dist/file-upload.js`).
- What an unmarked file post puts into the store today: `[file: <title or name>]` in the message text and one file
  record (name, type, size, permalink). The file's content is not ingested.
- No source reads the web chat's history. The Teams driver declares no file delivery.

## Goals / Non-Goals

**Goals:** files reach a marked conversation; the project's store learns nothing from that post; one marker name
for both carriers; no new flag, option or driver method.

**Non-Goals:** changing how text posts are marked; a marker on people's uploads; Teams delivery.

## Decisions

### D1. The marker of a file post is a block id

In a marked target, `postFiles` on Slack passes one block with the upload:

```
{ type: 'context', block_id: 'aven_marked', elements: [{ type: 'mrkdwn', text: '<one short line>' }] }
```

`block_id` is the carrier: the bot sets it, Slack returns it with the message, and the reader needs no state. The
value is `MARKED_EVENT`, the same constant the metadata marker uses. The block has to render something, so it shows
one line under the file — "🔒 Built on another domain's data — kept out of this project's sources." (the recorded
turn pins the text). The line is honest rather than cosmetic: it tells the person why this file will not show up in
a later search of the project's sources.

**Verified on 2026-11-20** against a development Slack workspace (task 1.1): one `files.uploadV2` into a thread
with that block, then `conversations.replies({ include_all_metadata: true })`. Slack accepted the `context` block
(the SDK's comment says "rich text blocks"; that is not a limit) and returned the file message with
`blocks: [{ type: 'context', block_id: 'aven_marked' }]`. Three things the read-back showed that the code relies
on or must not assume:

- the file message has `files`, `upload: true` and no `subtype` — the source cannot tell it by a subtype;
- its `metadata` is absent — the block is the only carrier on a file post;
- its `text` is the block's line, so an unmarked reader would ingest that line too; a marked reader skips the
  whole message.

Alternatives considered:
- *Upload without a destination, then `chat.postMessage` with the file's permalink and the metadata marker.* Keeps
  one marker carrier, but costs a second call, relies on Slack sharing a private file through a permalink, and gives
  an unfurl instead of the upload's own preview. Not needed: the probe passed.
- *Drop the check and let the file post go unmarked.* The file's name is chosen by the agent, so an instruction
  hidden in another domain's data could move text into the store through it — the channel D14 closes.
- *The source skips the bot's file posts in threads it knows are marked.* The source normalises one message at a
  time and would need per-thread state, or the bot's marks; more machinery for the same result.

### D2. The source knows one predicate and applies it to files too

`isMarked(msg)` becomes: the metadata event type is `aven_marked`, or any block of the message has that
`block_id`. `RawMessage` gains `blocks?: { block_id?: string }[]` (the puller already passes Slack's message object
through unchanged, and both history calls already ask for metadata). `normaliseFiles` returns nothing for a marked
message, so the two call sites in `pull.ts` need no change.

A person can put that block id on their own message through the API; the effect is that the source skips their
message — the same as the metadata marker today, and not a way to get data in.

### D3. The engine posts; the refusal and its notice go

`postOutbox` calls `chat.postFiles(where, files)` for every target. `where` already carries `marked` on both paths
(the live turn reads the marks after the answer; the restart recovery passes them). `outboxMarkedNotice` and its
test are removed. The failure path is unchanged: a refused upload is a notice and an error-tracking issue, and that
notice is a text post to the same marked target.

The drain stays where it is — after the read, before the post. With the refusal gone, a drained outbox is always
followed by a post or by a failure notice that names the files.

### D4. Other drivers

- **Web:** `postFiles` ignores `marked`. Nothing ingests the web chat.
- **Teams:** declares no file delivery; never reached.
- **Shadow:** journals names, posts nothing; unchanged.

The driver contract is the existing one: `ConvTarget.marked` means "mark this post so the installation's chat
sources skip it". It now applies to `postFiles` as well; the comment in `src/chat/driver.ts` says so.

## Risks / Trade-offs

- [Slack stops returning `block_id` on file messages] → the canary check (task 6.2) is the place it would show: the
  file's name turns up in the project's sources. The permalink alternative of D1 is the way out.
- [A sources daemon older than the bot reads the workspace] → it does not know the block marker and stores the
  file post's name and record. Bot and daemon ship as one image and one pin per installation, so the window is a
  deploy in which only one of the two was recreated; `ship` recreates both.
- [The visible line under every such file] → one short line, only in marked conversations.
- [A person forwards the file elsewhere in Slack] → out of the bot's hands, as with any text of a marked answer;
  D14 guards the agent's paths, a person is its release.

## Migration Plan

No data or config migration. The recorded turn `outbox-marked` is re-recorded on purpose. Rollback is the previous
version: marked conversations refuse files again; a file posted meanwhile stays in Slack and stays skipped by a
source of this or a later version.
