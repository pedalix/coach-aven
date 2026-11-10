## ADDED Requirements

### Requirement: Sandbox commits are authored by the account the credential acts as

The bot SHALL author and commit every sandbox commit as the GitHub account its credential acts as, with that
account's no-reply address `<id>+<login>@users.noreply.github.com`: a GitHub App's bot user `<app-slug>[bot]`, or a
personal token's owner. With `GITHUB_AUTH=none` the identity SHALL be `coach-aven[bot]`.

#### Scenario: An installation on its own GitHub App

- **WHEN** the installation's App has the slug `example-helper` and its bot user the id `123456789`
- **THEN** a commit made in a sandbox is authored by `example-helper[bot] <123456789+example-helper[bot]@users.noreply.github.com>`
- **AND** the `Co-Authored-By: CoachAven` trailer carries the same address

#### Scenario: An installation on a personal token

- **WHEN** `GITHUB_TOKEN` belongs to the user `robin-example` with the id `4242`
- **THEN** a commit made in a sandbox is authored by `robin-example <4242+robin-example@users.noreply.github.com>`

#### Scenario: No GitHub access

- **WHEN** `GITHUB_AUTH=none`
- **THEN** the identity is `coach-aven[bot]` and GitHub is not asked

### Requirement: The identity is known before the first sandbox is seeded

The bot SHALL resolve the identity once per process, as part of the first GitHub token it resolves, and SHALL NOT
seed a sandbox or start a session with a token whose identity lookup failed. A failed lookup SHALL fail that token
request with an error that names `GITHUB_BOT_LOGIN` and `GITHUB_BOT_USER_ID`, and the next request SHALL ask again.

#### Scenario: The first turn after a start

- **WHEN** the first turn resolves a token for its project
- **THEN** GitHub is asked who the credential is before the sandbox gets its git configuration
- **AND** later token requests in the same process do not ask again

#### Scenario: GitHub does not answer the lookup

- **WHEN** the lookup request fails
- **THEN** the turn fails with the lookup's error instead of committing under another account
- **AND** the next turn repeats the lookup

### Requirement: The installation can name the account by hand

When `.env` sets both `GITHUB_BOT_LOGIN` and `GITHUB_BOT_USER_ID`, the bot SHALL use them as the identity and SHALL
NOT ask GitHub. One without the other, a login that is not a GitHub login, or an id that is not a number SHALL stop
the boot.

#### Scenario: Both settings

- **WHEN** `.env` has `GITHUB_BOT_LOGIN=example-helper[bot]` and `GITHUB_BOT_USER_ID=123456789`
- **THEN** commits are authored by that account whatever credential is configured

#### Scenario: Half a pair

- **WHEN** `.env` has `GITHUB_BOT_LOGIN` and no `GITHUB_BOT_USER_ID`
- **THEN** the bot does not start and the error says the two go together

### Requirement: The bot's own pull requests are recognised by the same account

The auto-review and the autofix SHALL treat pull requests and reviews by the identity's login as the bot's own.

#### Scenario: Auto-review on an installation with its own App

- **WHEN** the bot's account is `example-helper[bot]` and it opened a pull request
- **THEN** the auto-review does not review that pull request
