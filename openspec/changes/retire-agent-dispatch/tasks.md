## 1. The primitive goes

- [ ] 1.1 Delete `src/dispatch.ts`, `src/dispatchrun.ts` and `src/dispatch.test.ts`. Verify: `npm run typecheck` names every remaining importer, and each is handled below.
- [ ] 1.2 `src/hosttools.ts`: remove `propose`, `registry` and `RegistryEntry` (lines 102-155) and the dispatch import. `src/hostrouter.ts`:
  - register the `host` server only when the project has a `messaging` block;
  - drop `dispatchOn`, `dispatchEnabled` and the late-bound `propose`;
  - update the header comment (lines 5-9).

  Verify: `src/hostrouter.test.ts` and `src/hosttools.test.ts`. The tool lists for a project with and without `messaging` must equal today's with `DISPATCH` unset ("Messaging without dispatch", "Nothing is registered without the gate", "Shadow conversation").
- [ ] 1.3 `src/prompt.ts`: remove `dispatchEnabled`, the `DISPATCH_PROMPT_PARAGRAPH` import and the "propose and messaging" sentence (lines 1, 33-34, 168-175). Remove `src/tasks.ts:18, 284`. Delete the dispatch variants in `src/prompt.test.ts:150-153`. Verify: `npm test`, with every golden under `src/fixtures/prompt/` unchanged (`git diff --stat src/fixtures/prompt` is empty).
- [ ] 1.4 `src/projects.ts`: drop the `dispatch` type and validation (lines 5, 82-84, 181-188). A `dispatch` block in a loaded configuration logs one warning naming the project and is ignored. Verify: a `src/projects.test.ts` case for a configuration with a `dispatch` block (loads, warns once).
- [ ] 1.5 The `DISPATCH` environment flag. At boot, `DISPATCH` set to `1` or `true` logs `config: DISPATCH is retired — agent messaging replaces it` once, and nothing reads it. Verify: a unit test on the boot-config reader, and scenario "Retired flag" through the host router test (same tools with and without it).
- [ ] 1.6 `src/state.ts`: remove `proposals`, `dispatches` and their accessors (lines 1, 151-154, 530-558). On load, drop both keys once and log their counts. Verify: a `src/state.test.ts` case that loads a `state.json` with both keys, saves, and reloads without them.
- [ ] 1.7 Turn provenance: remove the `{slug, proposalId}` variant of `TurnOrigin` and of the queue-journal origin, keeping `{slug, taskId}` (`src/turn.ts:143, 161, 1053, 1203`; `src/queuejournal.ts:30-34`). Verify: the turn and queue-journal tests, and the messaging restart-recovery tests unchanged.
- [ ] 1.8 Update the comment at `src/claudeSession.ts:380` (an effectful host tool: `send_message`). Drop `dispatch` and `dispatchrun` from the forbidden-import list in `src/cliprobe/imports.test.ts:29`. Verify: `src/cliprobe/imports.test.ts`.

## 2. Chat surfaces

- [ ] 2.1 `src/chat/views.ts`: remove the `proposal` and `relayed` views (lines 12, 84-85, 89-91). `src/chat/slack/driver.ts` (46, 81-92) and `src/chat/teams/cards.ts` (14, 111-112, 127): remove their renderers. Verify: `src/chat/teams/cards.test.ts` without its `relayed` entry, with the `relayed` card removed from `src/fixtures/chat/teams/cards.json`. The re-capture must show that one entry gone and nothing else.
- [ ] 2.2 `src/chat/core/interactions.ts`: remove the `Dispatcher` dependency and the `dispatch_send` / `dispatch_dismiss` actions (lines 25-26, 43-44, 118-131, 157-158). The held-message actions stay. Verify: the interaction tests, and the held-card recordings unchanged.
- [ ] 2.3 Composition roots: remove building the dispatcher and the late-bound `propose` from `src/chat/slack/app.ts` (10, 248-275), `src/chat/slack/events.ts` (34, 54-55, 90) and `src/chat/teams/app.ts` (18, 112-133). Verify: `npm run typecheck`, and the Slack and Teams record tests.
- [ ] 2.4 Delete the dispatch sections of the record tests: `src/chat/slack/events.record.test.ts` (184-231), `src/chat/slack/pollers.record.test.ts` (header 3-4, dispatch setup 19-20, 86, 100-102, `withDispatch` 154-159, section 195-…), `src/chat/teams/pollers.record.test.ts` (3, 16-17, 78, 94-96, 121, 141-…). Delete their fixtures:
  - `src/fixtures/chat/interactions/dispatch_send.json` and `dispatch_dismiss.json`;
  - the 11 `dispatch-*` / `propose-*` files in `src/fixtures/chat/pollers/`;
  - the 6 in `src/fixtures/chat/teams/pollers/`.

  Verify: `npm test`; `git diff --stat src/fixtures` shows only these deletions and the one `cards.json` entry.
- [ ] 2.5 Home tab (CLAUDE.md: a Slack UI change updates the Home tab). `src/chat/slack/blocks.ts`: remove the `dispatch` option of `homeBullets` and the *Proposals* bullet (lines 8, 852-862, 926). Messaging's own Home line stays the only "reach another agent" entry. Verify: the Home tab test and its snapshot. It never showed the bullet with `DISPATCH` unset, so the snapshot is byte-identical.

## 3. Docs

- [ ] 3.1 `docs/runtime-config.md`: replace "Dispatch (`DISPATCH`)" (from line 318) with two lines: the flag is retired, and agent messaging (`docs/agent-messaging.md`) is the way to reach beyond a thread. Reviewed in the PR.
- [ ] 3.2 `CLAUDE.md:55`: drop `src/dispatchrun.ts` from the engine-side list. `docs/agent-messaging.md`: drop the `send_message`-versus-`propose` note, and add a line saying dispatch was retired by this change. Reviewed in the PR.
- [ ] 3.3 The passing mentions in `docs/how-we-work.md`, `docs/why.md`, `docs/teams.md`, `docs/teams-pitfalls.md`, `docs/memory.md`, `docs/sources.md`, `docs/attribution.md` and `docs/sandbox-drivers.md`: rewrite them so no doc describes `propose` as current. History stays history. Verify: `grep -rn "propose\|DISPATCH" docs/ CLAUDE.md README.md` shows only retirement notes and the ledger.
- [ ] 3.4 `docs/rollout.md` ledger row: removal of dead code, with the same risk as a bug fix. `DISPATCH` is set on no installation, and the goldens and recordings of every non-dispatch scenario are unchanged. Note that home's commented `.env` line can go after the restart. Verify: the public guard in CI.
- [ ] 3.5 Every changed file and the PR text pass the public guard and gitleaks. Verify: CI `verify`.

## 4. After the merge and the archives

- [ ] 4.1 On the home bot, after the restart that brings this change: delete the commented `# DISPATCH=1` line from `.env`. Verify: the boot log has no `DISPATCH is retired` warning.
- [ ] 4.2 Archive in order: `agent-messaging`, `hub-open-network`, `retire-agent-dispatch`. Then delete `openspec/specs/agent-dispatch/`, now without requirements, and edit the Purpose of `openspec/specs/agent-messaging/spec.md` to drop its sentence about dispatch. Verify: `openspec validate --specs --strict`.
