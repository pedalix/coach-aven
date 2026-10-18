## REMOVED Requirements

### Requirement: Proposals are records, not messages
**Reason**: Agent messaging replaces the dispatch primitive. One mechanism for reaching beyond the thread: two tool sets for one intent made agents guess, and `DISPATCH` is set on no installation.
**Migration**: To ask another agent, use `agents` and `send_message` (`agent-messaging`). A message that would carry one domain's data to another still waits for a person's Send, on the held-message card.

### Requirement: Approval executes exactly once
**Reason**: Proposals no longer exist, so there is nothing to approve.
**Migration**: The held-message card of `agent-messaging` keeps the property for the one gate that remains: Send executes once, and Dismiss records.

### Requirement: Dispatch carries provenance and answers back
**Reason**: Dispatched turns, a task run in a new thread of another project's channel, are removed with the primitive.
**Migration**: A task between agents runs in the answering agent's shadow conversation, with its origin on the turn, the queue journal and metering (`agent-messaging`). Work in another project's channel is started by a person there.

### Requirement: Mentions do not dispatch
**Reason**: There is no dispatch left to trigger.
**Migration**: The invariant moves to `agent-messaging` as "Mentions never create a task".

### Requirement: Budget and auto mode
**Reason**: The auto list and the daily cap belonged to proposals.
**Migration**: Agent messaging has its own caps (`sendPerDay`, `acceptPerDay`, `maxRounds`). A project's `dispatch` block is ignored, with a warning naming the project.

### Requirement: Off by default
**Reason**: The flag has nothing left to switch.
**Migration**: `DISPATCH` in the environment logs one warning at boot and changes nothing. The held-message card never depended on the flag and stays.
