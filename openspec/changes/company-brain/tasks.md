## 1. Records, index, lint (pure)

- [x] 1.1 `src/brain/record.ts`: parse a record's frontmatter (`kind`, `status`, `ticket`) — `src/brain/record.test.ts`
- [x] 1.2 `src/brain/index.ts`: the index from a directory of records and `MEMORY.md` — `src/brain/index.test.ts` over a fixture set with invented tickets and names
- [x] 1.3 `src/brain/lint.ts`: the findings of design D6, the 15-finding cap and its order — `src/brain/lint.test.ts`
- [x] 1.4 `BRAIN` in `src/config.ts` and `docs/configuration.md` — `src/config.test.ts`, `src/configdocs.test.ts`

## 2. Mirror after a turn

- [x] 2.1 Listing and read-back scripts and their parsing, beside the snapshot code in `src/memjournal.ts` — `src/memjournal.test.ts` (changed, unchanged, failed listing)
- [x] 2.2 Call the mirror after the answer is posted, flag on only; rebuild `brain/<slug>/index.json` and `lint.json`; a failure is logged and never fails the turn — `src/turn.brain.test.ts`
- [x] 2.3 Flag off: no exec, no `brain/` directory — the recorded turn snapshots stay byte-identical (`src/chat/slack/turn.record.test.ts`)

## 3. Answer log and its host tool

- [x] 3.1 `src/brain/answers.ts`: which records a turn read (tool inputs) and changed (mirror diff), the log entry, the history query — `src/brain/answers.test.ts`
- [x] 3.2 Append the entry at turn end for an investigation turn; skip marked and shadow conversations — `src/turn.brain.test.ts`
- [x] 3.3 `brain_history` host tool in `src/hostrouter.ts`, project taken from the caller — `src/hostrouter.test.ts` (own project answered, another project empty)

## 4. Use log and provenance

- [x] 4.1 `src/brain/uses.ts`: the use-log entry (names only, what started the turn), provenance per record (uses by people, last use, revised after a reply) — `src/brain/uses.test.ts` (a routine's turn does not count; a frontmatter claim changes nothing)
- [x] 4.2 Append the entry at turn end; provenance into `index.json` and into `brain_history`'s answer — `src/turn.brain.test.ts`, `src/hostrouter.test.ts`
- [ ] 4.3 Nightly tracker check in `src/pollers.ts` before the tidy: `open` investigations whose ticket `src/youtrack.ts` reports resolved go into the lint; a project without a tracker makes no call — `src/routinerun.test.ts`

## 5. Prompt

- [x] 5.1 Two flagged paragraphs in `src/prompt.ts` (the record contract; unchecked records) — goldens for both flag states in `src/fixtures/prompt/`, `src/prompt.test.ts`
- [ ] 5.2 The contract paragraph no longer says "not under `metadata`" (the CLI moves the keys there); both paragraphs unflagged — one golden set, re-recorded on purpose

## 6. Default for every project (design D9)

- [ ] 6.1 Remove `BRAIN` from `src/config.ts`, `docs/configuration.md`, `.env.example` and every `cfg.brain` branch; tests that pinned the flag-off shape go or assert the one shape
- [ ] 6.2 `docs/rollout.md`: the `BRAIN=1` and `dream-schedule` rows move to *Retired*

## 7. Nightly tidy

- [ ] 7.1 `src/brain/tidy.ts` (pure): which findings are due (the three-run rule over `tidy.json`, keyed by code + record + hash), the 15 oldest, the prompt (memory only, no transcripts, never edit `CLAUDE.md`) — `src/brain/tidy.test.ts`
- [ ] 7.2 The `CLAUDE.md` digests in the mirror's listing exec (`src/memjournal.ts`) and the `instructions-changed` finding in `src/brain/lint.ts`; the first digest is a baseline — `src/memjournal.test.ts`, `src/brain/lint.test.ts`
- [ ] 7.3 The nightly check in `src/pollers.ts`: per project, 03:00 installation time, start a tidy turn only when a finding is due; mirror, index and counts after it; usage kind `tidy`; nothing posted — `src/routinerun.test.ts` (empty lint starts nothing and no sandbox)
- [ ] 7.4 The idle stop treats a tidy like any routine turn — `src/turn.idle.test.ts`

## 8. Remove the dream

- [ ] 8.1 Delete `src/dream.ts`, `fireDream`, the routine kind `dream` (`src/state.ts`), the after-dream snapshot path in `src/memjournal.ts` that the mirror replaces, and the dream branches in `src/routineguard.ts`, `src/metering.ts`, `src/housekeeping.ts`, `src/messaging/service.ts`
- [ ] 8.2 Remove a stored dream routine at boot, logged once — `src/state.test.ts`
- [ ] 8.3 Delete the `dream` verb (`src/chat/core/commands.ts`), its views and cards (`src/chat/views.ts`, Slack blocks, Teams cards, web views); re-record the command and Home snapshots
- [ ] 8.4 Home lists of the three surfaces: no dream line; `memory open` and `memory unchecked` named (8.5)
- [ ] 8.5 `memory open` and `memory unchecked` from the host index, viewer forms — recorded snapshots, `docs/commands.md` (`src/commandsdoc.test.ts`)
- [ ] 8.6 Docs: `docs/memory.md` (a "Company brain" section: kinds, status, provenance, the logs, the tidy; the dream section goes), `docs/commands.md`, `docs/housekeeping.md`, `docs/runtime-config.md`, `docs/teams.md`, `docs/web.md`, `docs/security.md` (the `brain/<slug>/` row) — `src/doclinks.test.ts`
- [ ] 8.7 Specs of record that name dreams (`agent-messaging`, `sandbox-idle-stop`, `teams-chat-driver`): reword to "tidy" where the requirement still holds, in this change's deltas
- [ ] 8.8 `npm run typecheck` and `npm test` pass; `openspec validate company-brain --strict` passes

## 9. After the deploy (on the operator's word)

- [ ] 9.1 First night on production: the cost of one tidy turn and the lint count before and after, into `docs/memory.md`
- [ ] 9.2 After two weeks: the share of typed records, findings stopped by the three-run rule, records revised after a reply
