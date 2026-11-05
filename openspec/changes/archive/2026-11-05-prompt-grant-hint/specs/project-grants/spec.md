# Spec Delta

## MODIFIED Requirements

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
- **THEN** the push succeeds, with no change to the agent's tools

#### Scenario: Pollers' own reads
- **WHEN** a poller lists `atlas`'s open pull requests while the grant is active
- **THEN** its token requests the same permissions as without a grant

## ADDED Requirements

### Requirement: The agent knows how a refused workflow push is lifted

On an installation that mints GitHub App tokens, the agent's system prompt SHALL say that a refused push of a workflow
file is deliberate and that an operator can allow it for the project with the grant command, and SHALL tell it not to
ask for the App's permissions to be changed. Other installations' prompts SHALL NOT mention it.

#### Scenario: App installation, refused workflow push
- **WHEN** on an App-auth installation the agent's push of `.github/workflows/ci.yml` is refused for missing
  `workflows` permission
- **THEN** its reply says the refusal is deliberate and that an operator can run `/aven grant workflows`, and it does
  not ask anyone to change the GitHub App's permissions

#### Scenario: Static token
- **WHEN** an installation authenticates to GitHub with a static token
- **THEN** the system prompt has no paragraph about granting `workflows`
