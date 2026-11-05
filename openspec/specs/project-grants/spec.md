# project-grants Specification

## Purpose
An operator can lift one of the agent's standing limits for one project for a short, recorded window — first the
GitHub `workflows` permission — without the agent being told any rule and without widening anything permanently.

## Requirements

### Requirement: An operator grants a project a capability for a limited time

`/aven grant <capability> [duration]` in a project's channel SHALL give that project the named capability until the
duration has passed: 30 minutes when none is given, at most 4 hours. Only an operator — whoever may run `/aven
reload` — SHALL be able to grant; anyone else, an unknown capability, an unreadable or too-long duration, or a channel
with no project SHALL be refused with nothing recorded.

#### Scenario: Default duration
- **WHEN** an operator runs `/aven grant workflows` in the channel of project `atlas` at 14:00
- **THEN** `atlas` holds `workflows` until 14:30

#### Scenario: Explicit duration
- **WHEN** an operator runs `/aven grant workflows 2h`
- **THEN** the grant lasts two hours

#### Scenario: Too long
- **WHEN** an operator runs `/aven grant workflows 6h`
- **THEN** the command is refused, naming the 4-hour limit, and no grant is recorded

#### Scenario: Not an operator
- **WHEN** a user who may drive the agent but is not an operator runs `/aven grant workflows`
- **THEN** the command is refused and no grant is recorded

#### Scenario: Unknown capability
- **WHEN** an operator runs `/aven grant deploy`
- **THEN** the command is refused, listing the capabilities that exist (`workflows`)

#### Scenario: Granting again while active
- **WHEN** `atlas` holds `workflows` until 14:30 and an operator runs `/aven grant workflows 1h` at 14:20
- **THEN** the grant now ends at 15:20, and one grant is recorded, not two

### Requirement: A grant is recorded

Each grant SHALL be stored with the installation's state — project, capability, start, end, who granted it and the
conversation it was granted in — and SHALL survive a restart of the bot.

#### Scenario: Restart during a grant
- **WHEN** the bot restarts while `atlas` holds `workflows` until 14:30
- **THEN** after the restart `atlas` still holds it until 14:30, and it ends then as any grant does

### Requirement: A grant is announced in the channel

Starting, ending at its time and ending early SHALL each post a message visible to the whole channel the grant was
made in, naming the project, the capability, the end time and who granted or ended it.

#### Scenario: Start
- **WHEN** Dana Reyes grants `workflows` to `atlas` until 14:30
- **THEN** the channel sees a message that Dana Reyes gave `atlas` GitHub workflows write until 14:30

#### Scenario: End at its time
- **WHEN** that grant reaches 14:30
- **THEN** the channel sees a message that `atlas`'s workflows grant has ended

### Requirement: The project's grants can be listed

`/aven grant` with no arguments SHALL list the project's active grants with their end times and who made them, to
anyone who may see the project's settings; with none active it SHALL say so.

#### Scenario: Listing
- **WHEN** a viewer runs `/aven grant` in `atlas`'s channel while `workflows` is held until 14:30
- **THEN** the reply names `workflows`, 14:30 and who granted it

### Requirement: A grant can be ended early

`/aven grant <capability> off` by an operator SHALL end that grant at once, exactly as if its time had passed.

#### Scenario: Ending early
- **WHEN** an operator runs `/aven grant workflows off` in `atlas`'s channel at 14:10
- **THEN** the grant ends, the channel is told, and the next turn's token has no `workflows`

### Requirement: An active workflows grant widens the sandbox's GitHub token

While a project holds `workflows`, the GitHub token the bot seeds into that project's sandbox SHALL also request
`workflows: write`, from the next turn on, for every turn of that project. Tokens the bot uses for its own reads
outside the sandbox SHALL stay as they are.

#### Scenario: Next turn after the grant
- **WHEN** `atlas` holds `workflows` and a message starts a turn in any of its threads
- **THEN** the token seeded for that turn requests `workflows: write` beside the usual permissions, scoped to `atlas`'s
  repositories as before

#### Scenario: The agent retries a refused push
- **WHEN** a push of `.github/workflows/ci.yml` was refused for missing `workflows` permission, then an operator grants
  `workflows`, and the user asks the agent to push again
- **THEN** the push succeeds, with no change to the agent's prompt or tools

#### Scenario: Pollers' own reads
- **WHEN** a poller lists `atlas`'s open pull requests while the grant is active
- **THEN** its token requests the same permissions as without a grant

### Requirement: Without a grant the token is unchanged

A project holding no grant SHALL be minted exactly the permissions it is minted today, and nothing SHALL be posted.

#### Scenario: No grant
- **WHEN** a turn starts for a project with no grant recorded
- **THEN** the requested permissions are exactly contents write, pull requests write, checks read and metadata read

### Requirement: An ended grant stops widening new tokens

From the moment a grant's time has passed or it was ended with `off`, every token minted for the project's sandbox
SHALL request today's permissions again, whether or not the end has been announced yet. Tokens minted during the grant
are not revoked; they expire on their own within an hour, and the end notice SHALL say so.

#### Scenario: Turn right after the end
- **WHEN** `atlas`'s grant ended at 14:30 and a turn starts at 14:30:20, before the end notice is posted
- **THEN** the token seeded for that turn requests no `workflows`

#### Scenario: Sandbox asleep at the end
- **WHEN** `atlas`'s grant ends while its sandbox is stopped
- **THEN** the sandbox is not started; the next turn that wakes it seeds a token without `workflows` before the agent
  runs

#### Scenario: Bot down at the end
- **WHEN** the bot is not running at 14:30 and starts at 14:45
- **THEN** within a minute of start-up the grant is removed and its end announced, and no turn after 14:30 got
  `workflows`

### Requirement: The grant's reply says when it cannot take effect

When granting `workflows`, the reply SHALL say so if the installation does not use GitHub App auth, or if the App
installation that holds the project's repositories has not granted `workflows`; the grant is still recorded.

#### Scenario: Token mode
- **WHEN** an operator grants `workflows` on an installation that authenticates to GitHub with a static token
- **THEN** the reply says the grant changes nothing there, because the static token's own scopes apply

#### Scenario: Installation without the permission
- **WHEN** the App installation for `atlas`'s repositories has not approved `workflows`
- **THEN** the reply says an organization owner must approve it first
