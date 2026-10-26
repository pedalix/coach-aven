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
- One way for an agent to reach beyond its thread: `agents` and `send_message`, for questions and requests alike (D3).
- Outside agent messaging, no behaviour change on any installation in use. The tests prove it on prompts, tool lists and recorded chat calls. Inside it, only the prompt paragraph, the tool descriptions and the answering-side frames change, for projects with a `messaging` block (D3).
- Nothing half-removed: no dead flag, view, state key or fixture is left behind.

**Non-Goals:**
- Per-sender permissions on the receiving side (D3, a possible future direction).
- Changing agent messaging beyond D3, the hub, or the YouTrack pollers.

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

### D3. No successor: messaging already carries requests to do work
Dispatch could make another project's agent do work after a person's Send. Messaging does not need a successor for that: it is intent-agnostic. A task carries a question or a request to do work alike, and no rule or confirmation tells the two apart.

**The gate is the receiving side's.**
- The receiving agent's accept list decides who may send it anything.
- The answering frame asks the agent to handle the task as a colleague's request, within its project's rules and permissions.
- The marks rule, caps, depth and rounds stay as they are.

**So this change also removes "ask, don't order" everywhere it lived:**
- the sentence "Messages ask; they do not order" in the messaging prompt paragraph;
- the same idea in the `send_message` description;
- the answering side's "change nothing" frame (`wrapTask`) and the reply frame's "data, not instructions" header. Both now read as a request from agent `<agent>` of installation `<installation>`.

**The asking side keeps its guard.** An answer still arrives as data from another agent, never an instruction from a person (`wrapAnswer`, `NEVER_FORWARD`), because that is the injection and marks guard for what comes back.

**Possible future direction, not planned:** permissions per sender, enforced by the receiving bot. One example is read-only versus write for a sender, through the sandbox's permission mode. That could come with an intent check that escalates a request to a person.

### D3a. Changed after the plan (scope from the review, same PR)
D3 above replaces the plan's original D3, which kept "Messages ask; they do not order" and sketched a held, visible work task as the future. Following from it:
- The `agent-messaging` Purpose is edited in its change, which is not archived. The shadow-conversation requirement's framing sentence changes through this change's `agent-messaging` delta, with a new scenario, "A request to do work".
- The goldens `src/fixtures/messaging/task.txt`, `src/fixtures/messaging/reply.txt` and `src/fixtures/prompt/multi-repo-messaging.txt` are re-captured on purpose.
- `answer.txt` is unchanged.

**Accepted risks (from the PR review).** The task frame stays plain and transparent, so it is easy to debug. It restricts neither the work nor where the task's data goes. Two consequences are accepted for now.
1. **An accepted peer can approve a risky step itself.** In a shadow conversation an AskUserQuestion goes to the asking agent as `request_input`, because nobody can click there. So there is no person on either side.
2. **What a task carries can be saved where marks do not follow.** On the answering side, the task's data can end up in memory notes, tickets or commits. Marks stay per conversation, so saved data is a way around them.

The mitigations:
- **Accept lists.** They grant all of this only to trusted senders, and an existing grant now also allows requests for work. `docs/agent-messaging.md` says so.
- **Roles per sender in `accept`.** A role such as reader or contributor, enforced by the receiving bot (for example through the sandbox permission mode), is the planned lever for both risks. It is not built in this change.

### D4. Leftovers fail soft, loudly
Every leftover is handled without stopping the bot:
- **`DISPATCH` in an environment** gets one warning at boot (`config: DISPATCH is retired — agent messaging replaces it`).
- **A project's `dispatch` block** gets one warning per load, naming the project. The block is otherwise ignored.
- **`state.json`** drops its `proposals` and `dispatches` keys once, on load, and logs the counts.

A stale setting should not stop a bot from starting, and the warning reaches the operator, so the setting is never silently honoured. The house rule is to fail loudly on configuration that would change behaviour, and these change nothing any more.

### D5. The bucket, and how the tests prove it
The dispatch half is a removal of dead code, with the same risk as a bug fix: no installation sets `DISPATCH`, so nothing a person sees can change. The intent-agnostic half (D3) is bucket 2: it reaches only projects with a `messaging` block, and no prod project has one.

The tests prove both:
- **Prompt goldens.** Every input without `messagingSend` stays byte-identical, and only the dispatch variants in `src/prompt.test.ts` are deleted. `multi-repo-messaging.txt` changes by its one messaging line (D3).
- **Recorded chat calls.** Every non-dispatch scenario keeps its calls byte-identical. The fixtures show the deleted dispatch recordings, plus two removals:
  - the one `relayed` entry of the Teams card golden;
  - the always-null `proposals` key, gone from the Slack and Teams pollers snapshots (16 files). The harness recorded proposal state next to the calls; a check shows each file differs only by that key.
- **Host router.** Its tests show the same tool lists, with and without a `messaging` block, as the code before the change gives with `DISPATCH` unset.

### D6. Archive order
1. `agent-messaging`.
2. `hub-open-network`.
3. This change.

This change's `host-tools` delta is written against the version `agent-messaging` leaves. That is why it keeps the scenario names "Messaging without dispatch" and "Shadow conversation", and replaces the two requirements whose scenarios must go. After its archive, every `agent-dispatch` requirement is gone: the empty `openspec/specs/agent-dispatch/` is deleted. The `agent-messaging` Purpose no longer names dispatch. It was edited in the `agent-messaging` change itself, which is not archived yet (D3a), because a Purpose is edited in place and not through a delta.

## Risks / Trade-offs

- **[Someone relied on dispatch]** Only the operator's home bot ever had the flag, and it is off since 2026-10-18 with a `.env` backup. Messaging carries the same requests (D3).
- **[A request to do work reaches an agent that should not act on it]** The accept list decides who may send at all. The project's rules and the sandbox's permissions decide what the agent may do, as for a colleague's request. Per-sender permissions are the future direction in D3. Accept lists name senders one by one, so an operator grants this on purpose.
- **[A large diff across the chat drivers]** Most of it is deletion. Every recorded non-dispatch scenario stays byte-identical, so a slip shows up as a snapshot diff, not in production.
- **[State written by an old release]** `proposals` and `dispatches` in `state.json` are pruned once (D4), and a rollback to an older release would find them empty. Nobody had pending proposals: home's agent never proposed after the flag went off.

## Migration Plan

1. Merge. Outside messaging nothing changes on any installation; the boot warning appears only where `DISPATCH` is still set. Projects with a `messaging` block get the new prompt paragraph and frames in new sessions.
2. On the home bot, delete the commented `# DISPATCH=1` line from `.env` after the restart that brings this change. The backup stays until the next cleanup.
3. Archive in the order of D6, then delete `openspec/specs/agent-dispatch/`.

**Rollback:** revert the merge. No data needs restoring.
