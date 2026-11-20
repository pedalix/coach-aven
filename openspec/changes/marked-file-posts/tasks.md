# Tasks

## 1. The probe (gates everything below)

- [x] 1.1 Run the probe against a real Slack workspace: one parent message, one `files.uploadV2` into its thread with
      `blocks: [{ type: 'context', block_id: 'aven_marked', … }]`, read the thread back with
      `conversations.replies({ include_all_metadata: true })`, delete the file and the parent. Verify the output
      says the upload was accepted and `block_id` is on the file message. Done 2026-11-20: accepted, `block_id`
      kept, no `subtype`, no `metadata`, `text` = the block's line (`design.md` D1); both posts deleted.

## 2. The source

- [ ] 2.1 `src/sources/slack/normalise.ts`: `RawMessage.blocks?: { block_id?: string }[]`; `isMarked` is true for the
      metadata event type or a block with `block_id === MARKED_EVENT`; `normaliseFiles` returns `[]` for a marked
      message. Verify in `src/sources/slack/normalise.test.ts`: a file post with the marker block yields no message
      and no file record; the same post without it yields both, as today; the existing metadata test is unchanged
      (`npm test -- src/sources/slack/normalise.test.ts`).

## 3. The Slack driver

- [ ] 3.1 `src/chat/slack/driver.ts`: `postFiles` passes the marker block when `to.marked`, nothing otherwise; the
      block builder lives in `src/chat/slack/blocks.ts` with the line's text. Fix the comment that says the file
      post goes unmarked, and the `marked` comment in `src/chat/driver.ts`. Verify a blocks test pins the block
      byte-exact and the recorded turn `outbox` (unmarked) is byte-identical (`npm test -- src/chat/slack`).

## 4. The engine

- [ ] 4.1 `src/turn.ts`: remove the marked branch in `postOutbox` — every target goes through `chat.postFiles`.
      `src/outbox.ts`: remove `outboxMarkedNotice` and its assertion in `src/outbox.test.ts`. Verify
      `npm run typecheck` and `npm test -- src/outbox.test.ts`.
- [ ] 4.2 Re-record `src/fixtures/chat/turn/outbox-marked.json` on purpose
      (`UPDATE_SNAPSHOTS=1 npm test -- src/chat/slack/turn.record.test.ts`) and rename the test to say what it
      pins now. Verify the snapshot shows the three upload calls with the marker block in
      `files.completeUploadExternal` and no notice; the "flag off" test and every other recorded turn stay
      byte-identical.
- [ ] 4.3 Add a recorded case for the restart recovery of a marked conversation, or extend the existing recovery
      test, so the marker on that path is pinned. Verify `npm test -- src/chat/slack/turn.record.test.ts`.

## 5. Docs and the ledger

- [ ] 5.1 `docs/rollout.md`: in the `outbound-files` row replace "a marked (cross-domain) conversation gets a marked
      notice instead of an upload" with the new behaviour, add this change's PR, and add the watch item: a file
      asked for in a thread that holds another domain's answer arrives with the 🔒 line, and `search` in the
      project's sources does not find its name afterwards. Verify the row renders as one table row.
- [ ] 5.2 `docs/agent-messaging.md` and `docs/sources.md`: where the marker is described, name both carriers
      (message metadata, block id on a file post). Verify with `grep -n aven_marked docs/`.
- [ ] 5.3 Home tab: no change. Verify `homeBlocks` in `src/chat/slack/blocks.ts` and `src/chat/web/webhome.ts`
      say nothing about marked conversations (`grep -n -i marked` on both files returns nothing).

## 6. Before the PR

- [ ] 6.1 `npm run typecheck` and `npm test` pass; `openspec validate marked-file-posts --strict` and
      `openspec validate outbound-files --type spec --strict` pass.
- [ ] 6.2 On the canary after `npm run ship -- home`: in a thread that received another installation's answer, ask
      for a file. Verify it arrives with the 🔒 line, and after the next Slack pull `search` for the file's name in
      the project's sources returns nothing from that thread.
