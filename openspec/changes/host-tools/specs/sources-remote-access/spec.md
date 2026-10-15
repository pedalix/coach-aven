# Spec Delta

## Purpose
The control channel replaces the replica mount as the default path from a sources project to its store.

## MODIFIED Requirements

### Requirement: Project opts in by config
A project with a `sources` block SHALL reach its store through the `sources` server the bot serves over the session's control channel from the replica on the bot host; no replica is mounted and no sources server runs in the sandbox. A project whose `mcp` list declares a server named `sources` with a `url` SHALL use that URL instead and receives no channel-served `sources`.

#### Scenario: Nothing declared
- **WHEN** a project has a `sources` block and no `sources` entry in `mcp`
- **THEN** the sandbox has no `/data/sources` mount and no stdio sources server, and the sources tools answer over the control channel

#### Scenario: Remote sources declared
- **WHEN** `mcp: [{ "name": "sources", "url": "https://…", "auth": "gateway-m2m" }]` is set
- **THEN** the sandbox reaches the store through that URL and the bot registers no `sources` server for the session
