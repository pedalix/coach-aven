# Tasks

## 1. PR 1 — interface + turn path (bucket 1)

- [ ] 1.1 Recording fake Bolt (`src/chat/slack/recorder.ts`, test-only) and turn scenarios (queued → running → answer, cancel, background, question, note, in-flight + queued recovery); snapshot on unchanged code. Verify: `npm test` green before any move.
- [ ] 1.2 `src/chat/driver.ts` (interface, capabilities) and `src/chat/views.ts` (turn-path view models). Verify: `npm run typecheck`.
- [ ] 1.3 Slack driver part 1: post/update/markSeen/permalink/question rendering via `blocks.ts`; turn engine and recovery talk only to the driver. Verify: 1.1 snapshots byte-identical; `npm run typecheck && npm test`.
- [ ] 1.4 Ledger row "chat driver: turn path", bucket 1; PR labelled `feature`. Verify: CI green.

## 2. PR 2 — actions, dialogs, Home (bucket 1)

- [ ] 2.1 Recorder scenarios for every `app.action` / `app.view` / `app_home_opened` / uninstall handler; snapshot first. Verify: green on unchanged code.
- [ ] 2.2 Inbound `ChatAction` / `DialogSubmit` / `HomeOpened` / `Installed`/`Removed`; outbound `openDialog` / `updateDialog` / `postPrivate` / `publishHome`; handler logic to `src/chat/core/`; Slack wiring and `blocks.ts` to `src/chat/slack/`. Verify: snapshots identical; `blocks.test.ts` unchanged.
- [ ] 2.3 Ledger row; PR. Verify: CI green.

## 3. PR 3 — messages and commands (bucket 1)

- [ ] 3.1 Recorder scenarios for mentions, thread replies, DMs with picker, files, every `/aven` verb including denials; snapshot first. Verify: green on unchanged code.
- [ ] 3.2 `ChatMessage` / `ChatCommand` normalization; platform-neutral `/aven` router; `slackfiles.ts` as the Slack `fetchFile`; `access.ts` on opaque platform user ids. Verify: snapshots identical; `access.test.ts`, `attachments.test.ts` unchanged.
- [ ] 3.3 Ledger row; PR. Verify: CI green.

## 4. PR 4 — pollers, routines, dispatch, alerts (bucket 1)

- [ ] 4.1 Recorder scenarios: routine fire (with and without `ROUTINE_GUARD`), dream, housekeeping, auto-review, autofix, YouTrack investigation, dispatch Send/Dismiss, ops alert; snapshot first. Verify: green on unchanged code.
- [ ] 4.2 Deliveries through `projectChannel` + `post`; `channels.ts` as the Slack implementation; `pollers.ts`, `routinerun.ts`, `dispatchrun.ts` lose Bolt imports; driver selection seam in `cli.ts` with the unknown-driver error. Verify: snapshots identical; import-rule test; unknown-driver test.
- [ ] 4.3 CLAUDE.md architecture pointers for `src/chat/`; ledger row; PR. Verify: CI green.
