# Spec Delta

## Purpose
Lets a sandbox anywhere query a project's sources store over the network with exactly the tools and limits of the in-sandbox server, without a replica.

## ADDED Requirements

### Requirement: Same tools over HTTP
`orch sources serve` SHALL expose the sources tool table (search, get, transcript, tasks, meetings, calendar, activity, fragments, people, stats, unanswered, stuck) over MCP streamable HTTP with identical inputs, outputs and scrub markers as the stdio server in the sandbox.

#### Scenario: Tool parity
- **WHEN** the same `search` call is made against the stdio server over a replica and against `serve` over the live store of the same build
- **THEN** the results are identical

### Requirement: Read-only and scrubbed
The served store SHALL be opened read-only; no tool may write, and bodies withheld by the scrubber stay withheld. A build running concurrently SHALL never make a query fail or return a torn result.

#### Scenario: Build during a query
- **WHEN** a store build commits while a `search` is executing
- **THEN** the query completes against a consistent snapshot and the next query sees the new build

### Requirement: Authenticated access only
Every request SHALL carry a bearer token the server was started with (or arrive through the gateway that enforces the project's M2M policy); an unauthenticated request is rejected without revealing whether the project exists.

#### Scenario: Missing token
- **WHEN** a request has no or a wrong bearer token
- **THEN** the server answers 401 with no body details

### Requirement: Freshness is live
`stats.meta` SHALL report the last pull per source from the live store, so a sandbox can tell a stale source from a missing one exactly as with a replica.

#### Scenario: Source older than its interval
- **WHEN** a source's last pull is older than the project's interval
- **THEN** `stats.meta` names it and its last pull time

### Requirement: Project opts in by config
A project with a `sources` block SHALL use the replica mount unless its `mcp` list declares a server named `sources` with a `url`; then no replica is mounted and the sandbox reaches the store through that URL.

#### Scenario: Remote sources declared
- **WHEN** `mcp: [{ "name": "sources", "url": "https://…/gw/<slug>/sources", "auth": "gateway-m2m" }]` is set
- **THEN** the sandbox has no `/data/sources` mount and the sources tools come from the URL

#### Scenario: Nothing declared
- **WHEN** the project has no `sources` entry in `mcp`
- **THEN** the replica mount and the stdio server are used as today
