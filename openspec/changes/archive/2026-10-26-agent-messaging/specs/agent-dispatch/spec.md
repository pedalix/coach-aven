## MODIFIED Requirements

### Requirement: Off by default
With `DISPATCH` unset, proposals SHALL be ignored (logged), and no proposal buttons or dispatched turns SHALL appear. The held-message card of `agent-messaging` is not a proposal and does not depend on this flag.

#### Scenario: Flag off
- **WHEN** a proposal file appears while the flag is unset
- **THEN** it is logged as ignored and the agent's thread is unchanged

#### Scenario: Held message without the flag
- **WHEN** `DISPATCH` is unset and a project with a `messaging` configuration holds a message for a person's Send
- **THEN** the held-message card with its Send and Dismiss buttons appears, and no proposal is created
