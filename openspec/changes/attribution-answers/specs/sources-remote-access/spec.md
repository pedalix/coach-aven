# Spec Delta

## MODIFIED Requirements

### Requirement: Same tools over HTTP
`orch sources serve` SHALL expose the sources tool table (search, get, transcript, tasks, meetings, calendar, activity, fragments, people, stats, unanswered, stuck) over MCP streamable HTTP with identical inputs, outputs and scrub markers as the stdio server in the sandbox. Parity holds for every tool except `ask` and `answer` (`attribution-learning`): both are listed with the same schemas on every face, and a read-only face SHALL answer them with `not served on this face` and touch nothing.

#### Scenario: Tool parity
- **WHEN** the same `search` call is made against the stdio server over a replica and against `serve` over the live store of the same build
- **THEN** the results are identical

#### Scenario: The two writer tools over HTTP
- **WHEN** `ask` or `answer` is called against `serve`
- **THEN** the answer is `not served on this face`, the store and the ledgers are untouched, and `tools/list` still lists both with the schemas every face shows
