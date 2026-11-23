## 1. Records, index, lint (pure)

- [ ] 1.1 `src/brain/record.ts`: parse a record's frontmatter (`kind`, `status`, `ticket`, `confirmed`), the content hash without `confirmed`/`modified` — `src/brain/record.test.ts`
- [ ] 1.2 `src/brain/index.ts`: the index from a directory of records and `MEMORY.md` — `src/brain/index.test.ts` over a fixture set with invented tickets and names
- [ ] 1.3 `src/brain/lint.ts`: the seven findings of design D6, the 15-finding cap and its order — `src/brain/lint.test.ts`
- [ ] 1.4 `BRAIN` in `src/config.ts` and `docs/configuration.md` — `src/config.test.ts`, `src/configdocs.test.ts`

## 2. Mirror after a turn

- [ ] 2.1 Listing and read-back scripts and their parsing, beside the snapshot code in `src/memjournal.ts` — `src/memjournal.test.ts` (changed, unchanged, failed listing)
- [ ] 2.2 Call the mirror after the answer is posted, flag on only; rebuild `brain/<slug>/index.json` and `lint.json`; a failure is logged and never fails the turn — `src/turn.brain.test.ts`
- [ ] 2.3 Flag off: no exec, no `brain/` directory — the recorded turn snapshots stay byte-identical (`src/chat/slack/turn.record.test.ts`)

## 3. Answer log and its host tool

- [ ] 3.1 `src/brain/answers.ts`: which records a turn read (tool inputs) and changed (mirror diff), the log entry, the history query — `src/brain/answers.test.ts`
- [ ] 3.2 Append the entry at turn end for an investigation turn; skip marked and shadow conversations — `src/turn.brain.test.ts`
- [ ] 3.3 `brain_history` host tool in `src/hostrouter.ts`, project taken from the caller — `src/hostrouter.test.ts` (own project answered, another project empty)

## 4. Confirmation

- [ ] 4.1 `src/brain/confirm.ts`: the ledger, confirmed-at-version, a mark without an entry — `src/brain/confirm.test.ts`
- [ ] 4.2 The *Confirm* control in `src/chat/views.ts`, shown only when the turn changed records; the handler in `src/chat/core/interactions.ts` behind the actor gate — `src/chat/core/interactions.test.ts`
- [ ] 4.3 Write and remove the `confirmed:` line in the sandbox at confirmation and at mirror — `src/memjournal.test.ts`
- [ ] 4.4 Slack rendering in `src/chat/slack/blocks.ts`; re-snapshot on purpose (`UPDATE_SNAPSHOTS=1`) for the flag-on turn only — `src/chat/slack/turn.record.test.ts`
- [ ] 4.5 Web rendering (`src/chat/web/buttons.ts`); Teams declares no control — `src/chat/capabilities.test.ts`, `docs/chat-drivers.md` table

## 5. Prompt and dream

- [ ] 5.1 Two flagged paragraphs in `src/prompt.ts` (the record contract; unconfirmed records) — goldens for both flag states in `src/fixtures/prompt/`, `src/prompt.test.ts`
- [ ] 5.2 The flagged lint section in `dreamPrompt` (`src/dream.ts`), the "no code" guardrail unchanged — `src/dream.test.ts`
- [ ] 5.3 Pass the lint to the dream in `src/pollers.ts` (`fireDream`) — `src/routinerun.test.ts`

## 6. Commands and Home

- [ ] 6.1 `memory open` and `memory unconfirmed` from the host index, viewer forms — `src/chat/core/commands` recorded snapshots, `docs/commands.md` (`src/commandsdoc.test.ts`)
- [ ] 6.2 Home tab (`homeBlocks` in `src/chat/slack/blocks.ts`) names the control and the two forms, flag on only — Slack Home snapshot
- [ ] 6.3 Teams and web Home lists (`src/chat/teams/teamshome.ts`, `src/chat/web/webhome.ts`) — their own tests

## 7. Docs and rollout

- [ ] 7.1 `docs/memory.md`: a "Company brain" section (kinds, status, confirmation, the answer log, what the dream tidies) — `src/doclinks.test.ts`
- [ ] 7.2 `docs/security.md`: the `brain/<slug>/` row in *Retention* and what the answer log can hold
- [ ] 7.3 `docs/rollout.md`: the ledger row for `BRAIN=1` (bucket 3, canary on the home bot, what to watch: share of typed records, lint count, dream cost per run)
- [ ] 7.4 `npm run typecheck` and `npm test` pass; `openspec validate company-brain --strict` passes

## 8. Canary (after merge, on the operator's word)

- [ ] 8.1 Home bot: flag on; after two weeks record the share of typed records, the lint count and the dream's cost per run in the ledger row
- [ ] 8.2 Answer the design's open questions (expiry, a text form of confirm) from the canary before production
