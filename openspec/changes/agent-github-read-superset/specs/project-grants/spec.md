# Spec Delta

## ADDED Requirements

### Requirement: An active actions grant widens the sandbox's GitHub token

While a project holds `actions`, the GitHub token the bot seeds into that project's sandbox SHALL request
`actions: write` instead of `actions: read`, from the next turn on, for every turn of that project. Tokens the bot
uses for its own reads outside the sandbox SHALL stay as they are.

#### Scenario: Dispatching a deploy
- **WHEN** `atlas` holds `actions` and the agent dispatches a workflow run of one of `atlas`'s repositories
- **THEN** GitHub accepts it, where without the grant it answered 403

#### Scenario: Both capabilities at once
- **WHEN** `atlas` holds `workflows` and `actions`
- **THEN** the token seeded for the next turn requests `workflows: write` and `actions: write`

#### Scenario: Separate from workflow files
- **WHEN** `atlas` holds `actions` but not `workflows`, and the agent pushes a change to `.github/workflows/ci.yml`
- **THEN** the push is refused for missing `workflows` permission, as without any grant

### Requirement: Secret-bearing reads stay out of the token

The sandbox token SHALL NOT request secret scanning alerts or repository webhooks, with or without a grant.

#### Scenario: Secret scanning alerts
- **WHEN** the agent asks GitHub for a repository's secret scanning alerts
- **THEN** GitHub refuses it for missing permission, because those alerts carry the detected secrets in clear

#### Scenario: Webhooks
- **WHEN** the agent lists a repository's webhooks
- **THEN** GitHub refuses it for missing permission, because hook URLs can embed tokens

## MODIFIED Requirements

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
- **THEN** the command is refused, listing the capabilities that exist (`workflows`, `actions`)

#### Scenario: Granting again while active
- **WHEN** `atlas` holds `workflows` until 14:30 and an operator runs `/aven grant workflows 1h` at 14:20
- **THEN** the grant now ends at 15:20, and one grant is recorded, not two

### Requirement: Without a grant the token is unchanged

A project holding no grant SHALL be minted exactly the agent's standing permissions — contents write, pull requests
write, checks read, actions read, metadata read, deployments read, environments read, administration read,
Dependabot alerts read and code scanning alerts read — and nothing SHALL be posted.

#### Scenario: No grant
- **WHEN** a turn starts for a project with no grant recorded
- **THEN** the requested permissions are exactly contents write, pull requests write, checks read, actions read,
  metadata read, deployments read, environments read, administration read, Dependabot alerts read and code scanning
  alerts read

#### Scenario: Reading why CI failed
- **WHEN** a check of the project's pull request failed and the agent asks GitHub for that run's job log
- **THEN** it gets the log, with no grant, while a push of a workflow file is still refused

#### Scenario: Installation without Actions access
- **WHEN** the App installation holding the project's repositories has not approved `actions`
- **THEN** the token is minted without it, and every other permission is requested as before

#### Scenario: Installation that has not approved the newer reads
- **WHEN** the App installation holding the project's repositories approved none of deployments, environments,
  administration, Dependabot alerts and code scanning alerts
- **THEN** the token is minted with the permissions it did approve, exactly as before this change, and the turn runs

#### Scenario: Branch protection in view
- **WHEN** the agent reads the default branch's protection of one of the project's repositories
- **THEN** GitHub answers it, and every attempt to change it is refused

### Requirement: The grant's reply says when it cannot take effect

When granting any capability, the reply SHALL say so if the installation does not use GitHub App auth, or if the App
installation that holds the project's repositories has not granted the permission the capability needs; the grant is
still recorded.

#### Scenario: Token mode
- **WHEN** an operator grants `workflows` on an installation that authenticates to GitHub with a static token
- **THEN** the reply says the grant changes nothing there, because the static token's own scopes apply

#### Scenario: Installation without the permission
- **WHEN** the App installation for `atlas`'s repositories has not approved `workflows`
- **THEN** the reply says an organization owner must approve it first

#### Scenario: Actions approved only for reading
- **WHEN** the App installation for `atlas`'s repositories approved `actions` read but not write, and an operator
  grants `actions`
- **THEN** the reply says an organization owner must approve Actions write first

### Requirement: The agent knows how a refused workflow push is lifted

On an installation that mints GitHub App tokens, the agent's system prompt SHALL say that a refused push of a workflow
file, and a refused dispatch, re-run or cancel of a workflow run, are deliberate, name the grant that lifts each, and
SHALL tell it not to ask for the App's permissions to be changed. Other installations' prompts SHALL NOT mention it.

#### Scenario: App installation, refused workflow push
- **WHEN** on an App-auth installation the agent's push of `.github/workflows/ci.yml` is refused for missing
  `workflows` permission
- **THEN** its reply says the refusal is deliberate and that an operator can run `/aven grant workflows`, and it does
  not ask anyone to change the GitHub App's permissions

#### Scenario: App installation, refused dispatch
- **WHEN** on an App-auth installation the agent's dispatch of a deploy workflow is refused with 403
- **THEN** its reply says the refusal is deliberate and that an operator can run `/aven grant actions`

#### Scenario: Static token
- **WHEN** an installation authenticates to GitHub with a static token
- **THEN** the system prompt has no paragraph about granting `workflows`
