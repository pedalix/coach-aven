# Tasks

## 1. PR 1 — interface + turn path (bucket 1)

- [x] 1.1 Recording fake Bolt (`src/chat/slack/recorder.ts`, test-only) and turn scenarios (queued → running → answer, cancel, background, question, note, in-flight + queued recovery); snapshot on unchanged code. Verify: `npm test` green before any move.
- [x] 1.2 `src/chat/driver.ts` (interface, capabilities) and `src/chat/views.ts` (turn-path view models). Verify: `npm run typecheck`.
- [x] 1.3 Slack driver part 1: post/update/markSeen/permalink/question rendering via `blocks.ts`; turn engine and recovery talk only to the driver. Verify: 1.1 snapshots byte-identical; `npm run typecheck && npm test`.
- [x] 1.4 Ledger row "chat driver: turn path", bucket 1; PR labelled `feature`. Verify: CI green.

## 2. PR 2 — actions, dialogs, Home (bucket 1)

- [x] 2.1 Recorder scenarios for every `app.action` / `app.view` / `app_home_opened` / uninstall handler; snapshot first. Verify: green on unchanged code.
- [x] 2.2 Inbound `ChatAction` / `DialogSubmit` (+ home opened as an `Actor`); outbound `reply` / `postPrivate` / `openDialog` / `updateDialog` / `refreshRating` / `publishHome`; handler logic to `src/chat/core/interactions.ts` (+ the actor gate in `core/gates.ts`); Slack wiring, `events.ts` and `blocks.ts` to `src/chat/slack/`. Install lifecycle (`app_uninstalled`, `tokens_revoked`) stays in the Slack adapter — it only drops the Slack installation record, there is no core logic. Dispatch Send/Dismiss moves with `dispatchrun` in 4.2. Verify: snapshots identical; `blocks.test.ts` unchanged; `src/chat/core/interactions.test.ts` drives the core with a fake driver.
- [x] 2.3 Ledger row; PR. Verify: CI green.

## 3. PR 3 — messages and commands (bucket 1)

- [x] 3.1 Recorder scenarios for mentions, thread replies, DMs with picker, files, every `/aven` verb including denials; snapshot first. Verify: green on unchanged code.
- [x] 3.2 `ChatMessage` / `ChatCommand` normalization; platform-neutral message core (`core/messages.ts`) and `/aven` router (`core/commands.ts`); files reach the core as a lazy `files()` on the message (Slack: `slackfiles.ts` hydration with the event's token); the Connect dedupe as the message's `claim`; project resolution asks the driver only for `conversationName`; pollers' fire paths through a `FirePort` bound by the adapter; `access.ts` already works on opaque user ids (unchanged). Verify: snapshots identical; `access.test.ts`, `attachments.test.ts` unchanged.
- [x] 3.3 Ledger row; PR. Verify: CI green.

## 4. PR 4 — pollers, routines, dispatch, alerts (bucket 1)

- [x] 4.1 Recorder scenarios: routine fire (with and without `ROUTINE_GUARD`), dream, housekeeping, auto-review, autofix, YouTrack investigation, dispatch Send/Dismiss, ops alert; snapshot first. Verify: green on unchanged code.
- [x] 4.2 Deliveries through the tenant's driver (`DriverForTenant`) + `post`/`update` with views (`line`, `proposal`, `relayed`, `autofixNotice`, `ticketHeader`, `ticketCard`); `channels.ts` became platform-neutral (names via `conversationName`, slug → channel via the driver's `findConversation`); dispatch Send/Dismiss buttons move into the core with `dispatchrun`; `pollers.ts`, `routinerun.ts`, `dispatchrun.ts` lose Bolt imports; the composition root, OAuth store and twin harness move to `src/chat/slack/` (`app.ts`, `installations.ts`, `twin.ts`); `src/chat/drivers.ts` lists the run modes and an unknown command names them. Verify: snapshots identical; golden payloads for the network-gated poller posts (`src/chat/slack/driver.test.ts`); import-rule test (`src/chat/imports.test.ts`); unknown-driver test (`src/chat/drivers.test.ts`).
- [x] 4.3 CLAUDE.md architecture pointers for `src/chat/`; ledger row; PR. Verify: CI green.
