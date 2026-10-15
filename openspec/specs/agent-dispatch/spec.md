# agent-dispatch Specification

## Purpose
Turns an agent's proposal into a side effect executed by the host — a message to a channel or a task for another agent — with a human gate by default, provenance on every hop and a budget, so agents coordinate through durable records rather than chat.

## Requirements

### Requirement: Proposals are records, not messages
An agent SHALL propose a side effect by calling the host tool `propose` with a proposal record (`kind`, `target`, `text`, `refs`, `rationale`); the host SHALL validate it, reply with the proposal id and the gate decision, render it in the agent's own thread with Send and Dismiss actions and SHALL NOT execute it until approved, unless the target is in the tenant's auto list.

#### Scenario: Proposal rendered
- **WHEN** a sandbox calls `propose` with a valid record while `DISPATCH=1`
- **THEN** the reply carries the id and the agent's thread shows the proposal text, target, refs and two buttons before the agent's turn ends

#### Scenario: Invalid proposal
- **WHEN** the record lacks a kind, a target or text
- **THEN** the tool returns the validation error, nothing is rendered and no proposal is stored

### Requirement: Approval executes exactly once
Clicking Send SHALL execute the proposal once (idempotent on proposal id) and record who approved it and when; Dismiss SHALL record the dismissal; a second click SHALL change nothing.

#### Scenario: Double click
- **WHEN** Send is clicked twice
- **THEN** the side effect happens once and the message shows "sent by <user> at <time>"

### Requirement: Dispatch carries provenance and answers back
A `dispatch` SHALL start a turn for the target project in a new thread in the target's channel, with the task text wrapped as data (never as instructions from the user), the origin (source agent, turn, proposal id) recorded in the queue journal and the thread; the target's final answer SHALL be posted in that thread and a pointer SHALL be written back to the proposing thread.

#### Scenario: Investigation opened
- **WHEN** bluefin-ops proposes a dispatch to `caldora` and Owen clicks Send
- **THEN** a thread opens in the caldora channel with the task, the caldora agent answers there, and the bluefin-ops thread gets a permalink plus a one-line outcome

### Requirement: Mentions do not dispatch
Mentioning a project or an agent in text SHALL never create a dispatch; only a proposal record does.

#### Scenario: Text mention
- **WHEN** an agent's answer contains "@caldora please check"
- **THEN** no turn is created for caldora

### Requirement: Budget and auto mode
A tenant MAY list targets for which dispatch executes without the gate; the host SHALL enforce a per-day cap per source agent and SHALL fall back to the gate when the cap is reached.

#### Scenario: Cap reached
- **WHEN** a source agent has dispatched `maxPerDay` tasks today and proposes another to an auto target
- **THEN** the proposal is rendered with buttons instead of executing

### Requirement: Off by default
With `DISPATCH` unset, proposals SHALL be ignored (logged) and no buttons or turns SHALL appear.

#### Scenario: Flag off
- **WHEN** a proposal file appears while the flag is unset
- **THEN** it is logged as ignored and the agent's thread is unchanged
