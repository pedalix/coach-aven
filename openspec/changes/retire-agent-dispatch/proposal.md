# Proposal

> **Status: proposed 2026-10-18.** Decision taken: agent messaging replaces the dispatch primitive. One mechanism lets agents reach beyond their own thread: the A2A-shaped tasks of `agent-messaging`, inside an installation and through the hub. The dispatch primitive is removed, with nothing kept behind a flag.

## Why

Two mechanisms now let an agent reach beyond its own thread:
- **Dispatch:** `propose` and `registry`, behind `DISPATCH=1`.
- **Agent messaging:** `send_message` and `agents`.

In the first canary between installations an agent had both tool sets. It looked for its peer with `registry`, offered `propose`, and never sent the question. Two tools for one intent make agents guess.

Dispatch has also lost its users:
- `DISPATCH=1` was set on one installation only, the operator's home bot, and was switched off there on 2026-10-18.
- No other installation ever enabled it.

So the dispatch code is dead weight. Every reader has to skip it: in the composition roots, the turn engine, `state.json`, the chat drivers and the prompt.

## What Changes

- **Removed:**
  - the `propose` and `registry` host tools;
  - proposal records and their Send / Dismiss card;
  - dispatched `message` (a post relayed into another channel) and dispatched `task` (a turn for another project in a new thread of its channel);
  - the per-project `dispatch` block (auto list, daily cap);
  - the `DISPATCH` flag and the dispatch paragraph of the system prompt;
  - the `relayed` view;
  - the Home tab's *Proposals* line;
  - `src/dispatch.ts`, `src/dispatchrun.ts`, and their tests and recorded fixtures.
- **Kept, because agent messaging uses it:**
  - the ✋ held-message card (Send once / Dismiss) and the drive gate behind it;
  - the `line` view (routines use it too);
  - the task-origin provenance on turns, queue journal and metering;
  - the `host` server, now registered only for projects with a `messaging` block.
- **Leftovers handled:**
  - A `dispatch` block in a project's configuration is ignored, with a warning naming the project.
  - `DISPATCH` set in the environment logs one warning at boot.
  - `state.json` drops its `proposals` and `dispatches` keys once, on load.
- **No successor needed for "ask another agent to do work".** Messaging is intent-agnostic: a task carries a question or a request to do work alike, and the receiving agent's accept list is the gate. The "ask, don't order" rule is removed everywhere it lived:
  - the prompt paragraph;
  - the `send_message` description;
  - the answering side's "change nothing" frame.

  The asking side keeps framing what comes back as data from another agent, not an instruction from a person (design D3).

## Out of scope

- YouTrack investigations and the pollers' own "dispatch" of a ticket to a thread. That is the word, not the primitive, and it stays.
- Any change to agent messaging beyond dropping its references to `propose` and its "ask, don't order" rule (design D3).
- Per-sender permissions on the receiving side: a possible future direction (design D3), not planned.

## Capabilities

### New Capabilities
None.

### Modified Capabilities
- `agent-dispatch`: every requirement is removed. "Mentions do not dispatch" moves to `agent-messaging` as "Mentions never create a task".
- `host-tools`: the `host` server exists for messaging only. "The caller is the session" and "Deterministic, read or gated" are replaced by requirements of the same rules without `propose` and `registry`: "A host tool call belongs to its session" and "Host tools read state or exchange task messages". OpenSpec cannot drop a scenario through MODIFIED.
- `chat-driver-interface`: "Slack installations unchanged" drops dispatch from its list of recorded scenarios.
- `agent-messaging`:
  - the shadow conversation's "no `propose` tool" clause goes;
  - its framing becomes a request from another agent, handled within the project's rules and permissions, with a new scenario "A request to do work";
  - "Mentions never create a task" is added;
  - the Purpose drops "Messages ask; they do not order" (edited in the `agent-messaging` change, which is not archived).

**Archive order:**
1. `agent-messaging`, which introduces `agent-messaging` and modifies `host-tools`, `agent-dispatch` and `chat-driver-interface`.
2. `hub-open-network`.
3. This change. Its deltas are written against the specs those two leave.

## Impact

- **Rollout:** two parts, one ledger row in `docs/rollout.md`.
  - The dispatch half is a removal of dead code, with the same risk as a bug fix. No installation sets `DISPATCH`, so no prompt, tool list, card or Slack call changes outside messaging. The prompt goldens and recorded chat calls of every non-dispatch scenario stay the same, and the tests prove it.
  - The intent-agnostic half is bucket 2. It reaches only projects with a `messaging` block, and no prod project has one: their prompt paragraph, tool descriptions and task frames change in new sessions.
- **Code:**
  - deleted: `src/dispatch.ts`, `src/dispatchrun.ts`;
  - changed: `src/hosttools.ts`, `src/hostrouter.ts`, `src/prompt.ts`, `src/tasks.ts`, `src/projects.ts`, `src/state.ts`, `src/turn.ts`, `src/queuejournal.ts`, `src/claudeSession.ts` (a comment), `src/chat/views.ts`, `src/chat/core/interactions.ts`, `src/chat/slack/{app,events,driver,blocks}.ts`, `src/chat/teams/{app,cards}.ts`;
  - tests and fixtures: the dispatch tests, about 20 recorded fixtures, and the Teams card golden's `relayed` entry.
- **Config:** `DISPATCH` and the project `dispatch` block are retired. Both only warn.
- **Docs:** `docs/runtime-config.md` ("Dispatch" goes), `CLAUDE.md` (architecture pointers), `docs/agent-messaging.md`, and the passing mentions in other docs.
