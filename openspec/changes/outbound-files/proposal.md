# Proposal

## Why

The agent can receive files but cannot hand one back: today it renders a chart or a screenshot in its sandbox, looks
at it, and then tells the person "I can only post text here" (a production thread on 2026-11-11 ended with the whole
HTML of a report pasted into Slack and a request to screenshot it themselves). Files reach the sandbox through
`/root/inbox/<turn>/`; nothing walks the other way. The newsletter work on the Teams installation deferred its
in-thread previews on exactly this gap ("a public change for outbound files").

## What Changes

- **An outbox per turn.** Behind `OUTBOUND_FILES=1`, on a chat surface that can deliver files, every turn's message
  names a directory unique to the turn (`/root/outbox/<turn>/`). When the turn ends, the bot reads what the agent
  saved there, posts it into the same conversation right after the answer, and removes the directory.
- **Same admission as inbound.** Images, PDFs, text/data/office documents; 25 MB per file, 10 files per turn; a
  refused file is named in the thread with the reason. Text-typed files pass the secrets scrub that answers pass.
- **Delivery per surface.** Slack: file uploads in the thread (Slack renders image and PDF previews itself). Web:
  the file is stored beside the conversation and downloadable through the existing per-session route, images
  shown inline. Teams: reports that it does not deliver files, so no outbox is named there and nothing changes.
- **The driver interface grows** a capability (`outboundFiles`) and one method (post files into a conversation).
- **The agent is told** once per session (the base prompt, flag on) and once per turn (the directory) — never on a
  surface that cannot deliver.
- **Home cheat-sheets** (Slack, web) say files can come back when the flag is on.
- **One capabilities table.** What each chat driver implements (reactions, private replies, thread replies, outbound
  files) is published in `docs/chat-drivers.md`, rendered from the drivers' own declarations and pinned by a test, so
  "where is this implemented" has one answer that cannot go stale.

## Capabilities

### New Capabilities
- `outbound-files`: files the agent saves for the person during a turn reach the conversation — the outbox
  convention, admission, scrubbing, draining, failure handling, and what each surface does with them.

### Modified Capabilities
- `chat-driver-interface`: a driver states whether it delivers files and, when it does, posts files into a
  conversation; the drivers' capabilities are published in one table pinned by a test (ADDED requirements; nothing
  existing changes).

## Impact

- **Rollout bucket 3**, gate `OUTBOUND_FILES=1` (env, off by default). Flag off: no prompt paragraph, no per-turn
  line, no sandbox read, no post — the recorded Slack call snapshots and the golden prompts stay byte-identical,
  which is the test that proves today's prod shape. Canary on home (Slack + web), then staging, then prod `.env`;
  ledger row in `docs/rollout.md`.
- **Code:** new `src/outbox.ts` (+ tests) — paths, the listing/read/remove scripts, admission, notices; `src/tasks.ts`
  (`ChatSession.collectOutbox`, the mirror of `ingest`); `src/turn.ts` (the per-turn line, the pull after the answer);
  `src/chat/driver.ts` (+ `DriverCapabilities.outboundFiles`, `postFiles`); `src/chat/slack/driver.ts`
  (`files.uploadV2`), `src/chat/web/driver.ts` + `files.ts` + the page (store, render), `src/chat/teams/driver.ts`
  (declares no delivery), `src/chat/shadow/driver.ts` (stub); `src/prompt.ts` + one new golden fixture;
  `src/config.ts`; Home: `src/chat/slack/blocks.ts`, `src/chat/web/webhome.ts`; the twin's `RecordingApi` learns the
  external upload POST; `src/chat/capabilities.ts` (+ test) renders the table in `docs/chat-drivers.md`. No
  sandbox-driver interface change: the read-back is `base64` over the existing `exec`.
- **Slack app:** no manifest change — `files:write` and `files:read` are already in the manifest and granted on the
  operated installations (checked against the production token's scopes on 2026-11-11).
- **Out of scope:** temporary public links for a rendered page (`publish`, a separate change — the only way to hand
  over an *interactive* HTML report; one installation's ops overlay already publishes previews over temporary links
  in its own stack, a shared change would generalise that); posting mid-turn (needs a channel from the sandbox to the bot); Teams
  delivery (Graph upload to the channel's SharePoint, the 1:1 consent card); files produced by a background
  Task that finishes after the turn; files to YouTrack; inline Block Kit `image` blocks (uploads preview on their
  own); archives, audio, video (not on the allowlist either way).
