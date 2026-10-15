# Spec Delta

## Purpose
The channel-served `sources` may answer from a daemon elsewhere instead of the bot host's replica.

## MODIFIED Requirements

### Requirement: Project opts in by config
A project with a `sources` block SHALL reach its store through the `sources` server the bot serves over the session's control channel; the bot SHALL answer from the replica on its own disk or, when `sources.daemon` is set, by forwarding to that daemon. No replica is mounted and no sources server runs in the sandbox. A project whose `mcp` list declares a server named `sources` with a `url` SHALL use that URL instead and receives no channel-served `sources`.

#### Scenario: Nothing declared
- **WHEN** a project has a `sources` block and no `sources` entry in `mcp`
- **THEN** the sandbox has no `/data/sources` mount and no stdio sources server, and the sources tools answer over the control channel

#### Scenario: Daemon configured
- **WHEN** `sources.daemon: { url, tokenEnv }` is set
- **THEN** the control-channel `sources` answers with the daemon's responses and the bot host holds no replica for the project

#### Scenario: Remote sources declared
- **WHEN** `mcp: [{ "name": "sources", "url": "https://…", "auth": "gateway-m2m" }]` is set
- **THEN** the sandbox reaches the store through that URL and the bot registers no `sources` server for the session
