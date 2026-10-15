# Spec Delta

## Purpose
The proposal record travels as a host tool call instead of a file in a mounted outbox.

## MODIFIED Requirements

### Requirement: Proposals are records, not messages
An agent SHALL propose a side effect by calling the host tool `propose` with a proposal record (`kind`, `target`, `text`, `refs`, `rationale`); the host SHALL validate it, reply with the proposal id and the gate decision, render it in the agent's own thread with Send and Dismiss actions and SHALL NOT execute it until approved, unless the target is in the tenant's auto list.

#### Scenario: Proposal rendered
- **WHEN** a sandbox calls `propose` with a valid record while `DISPATCH=1`
- **THEN** the reply carries the id and the agent's thread shows the proposal text, target, refs and two buttons before the agent's turn ends

#### Scenario: Invalid proposal
- **WHEN** the record lacks a kind, a target or text
- **THEN** the tool returns the validation error, nothing is rendered and no proposal is stored
