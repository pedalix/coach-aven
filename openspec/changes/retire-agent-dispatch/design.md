## Context

The dispatch primitive (`src/dispatch.ts`, the pure half, and `src/dispatchrun.ts`, the IO half; OpenSpec `agent-dispatch`) turns an agent's `propose` call into a side effect after a person's Send:
- a `message` relayed into another channel;
- a `task` that starts a turn for another project in a new thread of its channel.

It sits behind `DISPATCH=1`. Agent messaging (`agent-messaging`, `hub-open-network`) later gave agents a second way out of their thread: tasks between agents, answered in shadow conversations, inside an installation and through the hub. See proposal.md for why one of the two goes.

The code touches more than its two files. This is the inventory, against origin/main at b0ff816:

| Where | What |
|---|---|
| `src/dispatch.ts` (207 lines), `src/dispatchrun.ts` (184), `src/dispatch.test.ts` | the primitive, whole |
| `src/hosttools.ts:102-155` | `propose` and `registry`, and `RegistryEntry` |
| `src/hostrouter.ts:5-9, 24, 53-55, 71, 80-92` | `dispatchOn`, the late-bound `propose`, and the host server registered for `DISPATCH ∥ messaging` |
| `src/prompt.ts:1, 33-34, 168-175` and `src/tasks.ts:18, 284` | `dispatchEnabled`, `DISPATCH_PROMPT_PARAGRAPH`, and the "propose and messaging" sentence |
| `src/projects.ts:5, 82-84, 181-188` | the project `dispatch` block and its validation |
| `src/state.ts:1, 151-154, 530-558` | `proposals`, `dispatches` and their accessors |
| `src/turn.ts:143, 161, 1053, 1203` and `src/queuejournal.ts:30-34` | the `proposalId` variant of a turn's origin |
| `src/chat/views.ts:12, 84-85, 89-91` | the `proposal` and `relayed` views |
| `src/chat/core/interactions.ts:25-26, 43-44, 118-131, 157-158` | the `Dispatcher` dependency and the `dispatch_send` / `dispatch_dismiss` actions |
| `src/chat/slack/app.ts:10, 248-275`, `src/chat/slack/events.ts:34, 54-55, 90`, `src/chat/teams/app.ts:18, 112-133` | building the dispatcher in the composition roots |
| `src/chat/slack/driver.ts:46, 81-92` and `src/chat/teams/cards.ts:14, 111-112, 127` | rendering `proposal` and `relayed` |
| `src/chat/slack/blocks.ts:8, 852-862, 926` | the Home tab's *Proposals* bullet |
| `src/claudeSession.ts:380` | a comment that names `propose` as the example of a tool with an effect |
| `src/cliprobe/imports.test.ts:29` | `dispatch` and `dispatchrun` in the forbidden-import list |
| tests | `src/hostrouter.test.ts`, `src/hosttools.test.ts`, `src/prompt.test.ts:150-153`, the dispatch sections of `src/chat/slack/events.record.test.ts` (184-231), `src/chat/slack/pollers.record.test.ts` (3-4, 19-20, 86, 100-102, 154-159, 195-…) and `src/chat/teams/pollers.record.test.ts` (3, 16-17, 78, 94-96, 121, 141-…), the `relayed` entry of `src/chat/teams/cards.test.ts:45` |
| fixtures | `src/fixtures/chat/interactions/dispatch_{send,dismiss}.json`; `src/fixtures/chat/pollers/{dispatch-dismiss,dispatch-send-message,dispatch-send-task-answer,dispatch-send-task-error,dispatch-send-twice,dispatch-send-unknown,propose-auto,propose-dm,propose-gated,propose-rejected,propose-thread-elsewhere}.json`; `src/fixtures/chat/teams/pollers/{dispatch-dismiss,dispatch-send-message,dispatch-send-task-answer,dispatch-send-task-error,propose-auto,propose-gated}.json`; the `relayed` card in `src/fixtures/chat/teams/cards.json` |
| docs | `docs/runtime-config.md` "Dispatch (`DISPATCH`)" (from line 318); `CLAUDE.md:55` (`src/dispatchrun.ts`); `docs/agent-messaging.md` (`send_message` versus `propose`); the passing mentions in `docs/how-we-work.md`, `docs/why.md`, `docs/teams.md`, `docs/teams-pitfalls.md`, `docs/memory.md`, `docs/sources.md`, `docs/attribution.md`, `docs/sandbox-drivers.md` |

**Not part of the primitive, and staying:**
- the pollers' "dispatch" of a YouTrack ticket to an investigation thread (`src/pollers.ts:496, 557`, `src/state.ts:144, 399`);
- "Slack's dispatch timeout" (`src/chat/core/commands.ts:406`);
- the word "proposes" in the YouTrack investigation prompt (`src/prompts.ts:79, 120`);
- a Claude Code built-in command that mentions `--propose` in a recorded CLI fixture.

## Goals / Non-Goals

**Goals:**
- One way for an agent to reach beyond its thread: `agents` and `send_message`.
- No behaviour change on any installation in use. The tests prove it on prompts, tool lists and recorded chat calls.
- Nothing half-removed: no dead flag, view, state key or fixture is left behind.

**Non-Goals:**
- A replacement for dispatched work (D3).
- Changing agent messaging, the hub or the YouTrack pollers.

## Decisions

### D1. What disappears
Everything in the inventory that serves proposals:
- the two tools;
- the records and their state;
- the card and its two actions;
- the `relayed` view;
- dispatched turns and their `proposalId` origin;
- the project `dispatch` block;
- the flag;
- the prompt paragraph;
- the Home bullet;
- the tests and fixtures that record them.

The `host` server keeps existing for projects with a `messaging` block, so `routesFor` registers it when `m` is set, and only then.

### D2. What stays, and why
- **The ✋ held-message card** (`heldAsk` view, `interactions.ts` actions for held messages) and the drive gate behind it. Agent messaging's marks rule needs a person's Send. The card was always independent of `DISPATCH`; the `agent-dispatch` "Off by default" change made sure of that.
- **The `line` view.** Routines rewrite their parent message with it too.
- **The task-origin provenance** (`{slug, taskId}` on turns, the queue journal and metering). Only the `{slug, proposalId}` variant goes.
- **The "nobody can click there" rule for shadow conversations.** It now concerns only the held card: a message that needs Send is refused in a shadow conversation.

### D3. No successor for "ask another agent to do work", for now
Dispatch could make another project's agent do work, visibly, after a person's Send. Messaging only asks, so that ability goes with dispatch, and nobody uses it: the flag is set nowhere.

If it comes back, the shape is already there: a messaging task marked as work, which never runs on its own.
- The asking side holds it on the same ✋ card until a person sends it.
- The answering side runs it where people can see it, not in a shadow conversation.

That is a new change with its own spec, not a flag kept alive here.

### D4. Leftovers fail soft, loudly
Every leftover is handled without stopping the bot:
- **`DISPATCH` in an environment** gets one warning at boot (`config: DISPATCH is retired — agent messaging replaces it`).
- **A project's `dispatch` block** gets one warning per load, naming the project. The block is otherwise ignored.
- **`state.json`** drops its `proposals` and `dispatches` keys once, on load, and logs the counts.

A stale setting should not stop a bot from starting, and the warning reaches the operator, so the setting is never silently honoured. The house rule is to fail loudly on configuration that would change behaviour, and these change nothing any more.

### D5. The bucket, and how the tests prove it
This is a removal of dead code, with the same risk as a bug fix: no installation sets `DISPATCH`, so nothing a person sees can change. The proof is in the tests:
- The prompt goldens of every input without `dispatchEnabled` stay byte-identical. Only the dispatch variants in `src/prompt.test.ts:150-153` are deleted.
- The recorded Slack and Teams calls of every non-dispatch scenario stay byte-identical. `git diff --stat src/fixtures` shows deletions only, plus the one `relayed` entry of the Teams card golden.
- The host router tests show the same tool lists, with and without a `messaging` block, as the code before the change gives with `DISPATCH` unset.

### D6. Archive order
1. `agent-messaging`.
2. `hub-open-network`.
3. This change.

This change's `host-tools` delta is written against the version `agent-messaging` leaves. That is why it keeps the scenario names "Messaging without dispatch" and "Shadow conversation", and replaces the two requirements whose scenarios must go. After its archive, every `agent-dispatch` requirement is gone: the empty `openspec/specs/agent-dispatch/` is deleted. The Purpose of `openspec/specs/agent-messaging/spec.md` loses its sentence about dispatch. A Purpose is edited in the main spec, not through a delta.

## Risks / Trade-offs

- **[Someone relied on dispatch]** Only the operator's home bot ever had the flag, and it is off since 2026-10-18 with a `.env` backup. Bringing dispatch back would mean reverting this change. D3 describes the cleaner path.
- **[A large diff across the chat drivers]** Most of it is deletion. Every recorded non-dispatch scenario stays byte-identical, so a slip shows up as a snapshot diff, not in production.
- **[State written by an old release]** `proposals` and `dispatches` in `state.json` are pruned once (D4), and a rollback to an older release would find them empty. Nobody had pending proposals: home's agent never proposed after the flag went off.

## Migration Plan

1. Merge. Nothing changes on any installation; the boot warning appears only where `DISPATCH` is still set.
2. On the home bot, delete the commented `# DISPATCH=1` line from `.env` after the restart that brings this change. The backup stays until the next cleanup.
3. Archive in the order of D6, then delete `openspec/specs/agent-dispatch/` and edit the `agent-messaging` Purpose.

**Rollback:** revert the merge. No data needs restoring.
