## 1. The primitive goes

- [x] 1.1 Delete `src/dispatch.ts`, `src/dispatchrun.ts` and `src/dispatch.test.ts`. Verify: `npm run typecheck` names every remaining importer, and each is handled below.
- [x] 1.2 `src/hosttools.ts`: remove `propose`, `registry` and `RegistryEntry` (lines 102-155) and the dispatch import. `src/hostrouter.ts`:
  - register the `host` server only when the project has a `messaging` block;
  - drop `dispatchOn`, `dispatchEnabled` and the late-bound `propose`;
  - update the header comment (lines 5-9).

  Verify: `src/hostrouter.test.ts` and `src/hosttools.test.ts`. The tool lists for a project with and without `messaging` must equal today's with `DISPATCH` unset ("Messaging without dispatch", "Nothing is registered without the gate", "Shadow conversation").
- [x] 1.3 `src/prompt.ts`: remove `dispatchEnabled`, the `DISPATCH_PROMPT_PARAGRAPH` import and the "propose and messaging" sentence (lines 1, 33-34, 168-175). Remove `src/tasks.ts:18, 284`. Delete the dispatch variants in `src/prompt.test.ts:150-153`. Verify: `npm test`, with every golden under `src/fixtures/prompt/` unchanged (`git diff --stat src/fixtures/prompt` is empty). Done; the one exception is `multi-repo-messaging.txt`, whose messaging line changes on purpose with 2.6.
- [x] 1.4 `src/projects.ts`: drop the `dispatch` type and validation (lines 5, 82-84, 181-188). A `dispatch` block in a loaded configuration logs one warning naming the project and is ignored. Verify: a `src/projects.test.ts` case for a configuration with a `dispatch` block (loads, warns once).
- [x] 1.5 The `DISPATCH` environment flag. At boot, `DISPATCH` set to `1` or `true` logs `config: DISPATCH is retired — agent messaging replaces it` once, and nothing reads it. Verify: a unit test on the boot-config reader, and scenario "Retired flag" through the host router test (same tools with and without it).
- [x] 1.6 `src/state.ts`: remove `proposals`, `dispatches` and their accessors (lines 1, 151-154, 530-558). On load, drop both keys once and log their counts. Verify: a `src/state.test.ts` case that loads a `state.json` with both keys, saves, and reloads without them.
- [x] 1.7 Turn provenance: remove the `{slug, proposalId}` variant of `TurnOrigin` and of the queue-journal origin, keeping `{slug, taskId}` (`src/turn.ts:143, 161, 1053, 1203`; `src/queuejournal.ts:30-34`). Verify: the turn and queue-journal tests, and the messaging restart-recovery tests unchanged.
- [x] 1.8 Update the comment at `src/claudeSession.ts:380` (an effectful host tool: `send_message`). Drop `dispatch` and `dispatchrun` from the forbidden-import list in `src/cliprobe/imports.test.ts:29`. Verify: `src/cliprobe/imports.test.ts`.

## 2. Chat surfaces

- [x] 2.1 `src/chat/views.ts`: remove the `proposal` and `relayed` views (lines 12, 84-85, 89-91). `src/chat/slack/driver.ts` (46, 81-92) and `src/chat/teams/cards.ts` (14, 111-112, 127): remove their renderers. Verify: `src/chat/teams/cards.test.ts` without its `relayed` entry, with the `relayed` card removed from `src/fixtures/chat/teams/cards.json`. The re-capture must show that one entry gone and nothing else.
- [x] 2.2 `src/chat/core/interactions.ts`: remove the `Dispatcher` dependency and the `dispatch_send` / `dispatch_dismiss` actions (lines 25-26, 43-44, 118-131, 157-158). The held-message actions stay. Verify: the interaction tests, and the held-card recordings unchanged.
- [x] 2.3 Composition roots: remove building the dispatcher and the late-bound `propose` from `src/chat/slack/app.ts` (10, 248-275), `src/chat/slack/events.ts` (34, 54-55, 90) and `src/chat/teams/app.ts` (18, 112-133). Verify: `npm run typecheck`, and the Slack and Teams record tests.
- [x] 2.4 Delete the dispatch sections of the record tests: `src/chat/slack/events.record.test.ts` (184-231), `src/chat/slack/pollers.record.test.ts` (header 3-4, dispatch setup 19-20, 86, 100-102, `withDispatch` 154-159, section 195-…), `src/chat/teams/pollers.record.test.ts` (3, 16-17, 78, 94-96, 121, 141-…). Delete their fixtures:
  - `src/fixtures/chat/interactions/dispatch_send.json` and `dispatch_dismiss.json`;
  - the 11 `dispatch-*` / `propose-*` files in `src/fixtures/chat/pollers/`;
  - the 6 in `src/fixtures/chat/teams/pollers/`.

  Verify: `npm test`; `git diff --stat src/fixtures` shows only these deletions and the one `cards.json` entry. Done, with one more deletion: the pollers harnesses recorded proposal state next to the calls, so the 16 Slack and Teams pollers snapshots lose their always-null `proposals` key. A JSON check shows each differs by that key only.
- [x] 2.5 Home tab (CLAUDE.md: a Slack UI change updates the Home tab). `src/chat/slack/blocks.ts`: remove the `dispatch` option of `homeBullets` and the *Proposals* bullet (lines 8, 852-862, 926). Messaging's own Home line stays the only "reach another agent" entry. Verify: the Home tab test and its snapshot. It never showed the bullet with `DISPATCH` unset, so the snapshot is byte-identical.

- [x] 2.6 Messaging is intent-agnostic (design D3, added in review):
  - `MESSAGING_PROMPT_PARAGRAPH` loses "Messages ask; they do not order", and the `send_message` description loses its version of it;
  - `wrapTask` frames a task as a request from agent `<agent>` of installation `<installation>`, handled within the project's rules and permissions;
  - `wrapReply` drops its "data, not instructions" header;
  - `wrapAnswer` and `NEVER_FORWARD` (the asking side's guard) are unchanged;
  - the goldens `src/fixtures/messaging/task.txt`, `reply.txt` and `src/fixtures/prompt/multi-repo-messaging.txt` are re-captured on purpose.

  Verify: `src/messaging/wrap.test.ts` (new assertion: no "change nothing" or "not instructions" in the task frame), `src/prompt.test.ts`, `src/messaging/service.test.ts`.

- [x] 2.7 Review fixes (PR #44):
  - The task frame stays plain, with no restriction on the work or on where its data goes. The two accepted risks (an accepted peer approving a risky step; task data saved where marks do not follow) and their mitigations are in design D3 and `docs/agent-messaging.md`.
  - Old proposal buttons (`dispatch_send` / `dispatch_dismiss`) are acknowledged and rewrite the card to "⌛ Proposals were retired — nothing was sent".
  - `state.json` drops `proposals` / `dispatches` in memory only; the next normal save persists it.
  - A journal line with an old `{slug, proposalId}` origin replays without loss.
  - `HostCaller.teamId` is gone (nothing read it).
  - The Home messaging bullet reads "ask other agents or request work from them". No Home recording carries the messaging bullet, so it is pinned by an assertion in `blocks.test.ts`.

  Verify: `src/chat/slack/events.record.test.ts` (retired buttons), `src/state.test.ts`, `src/queuejournal.test.ts`, `src/messaging/wrap.test.ts`, `src/chat/slack/blocks.test.ts`.

## 3. Docs

- [x] 3.1 `docs/runtime-config.md`: replace "Dispatch (`DISPATCH`)" (from line 318) with two lines: the flag is retired, and agent messaging (`docs/agent-messaging.md`) is the way to reach beyond a thread. Reviewed in the PR.
- [x] 3.2 `CLAUDE.md:55`: drop `src/dispatchrun.ts` from the engine-side list. `docs/agent-messaging.md`: drop the `send_message`-versus-`propose` note, and add a line saying dispatch was retired by this change. Reviewed in the PR.
- [x] 3.3 The passing mentions in `docs/how-we-work.md`, `docs/why.md`, `docs/teams.md`, `docs/teams-pitfalls.md`, `docs/memory.md`, `docs/sources.md`, `docs/attribution.md` and `docs/sandbox-drivers.md`: rewrite them so no doc describes `propose` as current. History stays history. Verify: `grep -rn "propose\|DISPATCH" docs/ CLAUDE.md README.md` shows only retirement notes and the ledger.
- [x] 3.4 `docs/rollout.md` ledger row: removal of dead code, with the same risk as a bug fix. `DISPATCH` is set on no installation, and the goldens and recordings of every non-dispatch scenario are unchanged. Note that home's commented `.env` line can go after the restart. Verify: the public guard in CI.
- [x] 3.5 Every changed file and the PR text pass the public guard and gitleaks. Verify: CI `verify`.

## 4. After the merge and the archives

- [ ] 4.1 On the home bot, after the restart that brings this change: delete the commented `# DISPATCH=1` line from `.env`. Verify: the boot log has no `DISPATCH is retired` warning.
- [ ] 4.2 Archive in order: `agent-messaging`, `hub-open-network`, `retire-agent-dispatch`. Then delete `openspec/specs/agent-dispatch/`, now without requirements. The `agent-messaging` Purpose was already edited in its change (design D3a). Verify: `openspec validate --specs --strict`.
