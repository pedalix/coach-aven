# Spec Delta

## ADDED Requirements

### Requirement: A repo entry names its host

A project's repo entry SHALL be either `<owner>/<repo>`, a GitHub repository as before, or
`bitbucket.org/<workspace>/<repo>`, a Bitbucket Cloud repository. Any other entry with a host part SHALL fail the
config load at boot and at `/aven reload`, naming the project and the entry.

#### Scenario: A mixed project
- **WHEN** `atlas` lists `northwind/web` and `bitbucket.org/northwind/booking-api`
- **THEN** the config loads, and the sandbox holds both checkouts side by side under the project folder

#### Scenario: Another host
- **WHEN** `atlas` lists `gitlab.com/northwind/web`
- **THEN** the config load fails with a message naming `atlas` and the entry

### Requirement: A checkout is named after the repo

Each checkout SHALL be the repo's last path segment under the project folder. Two entries of one project with the same
last segment SHALL fail the config load, naming the project and both entries.

#### Scenario: The same name on two hosts
- **WHEN** `atlas` lists `northwind/booking-api` and `bitbucket.org/northwind/booking-api`
- **THEN** the config load fails naming both entries, because they would share one directory

### Requirement: One Bitbucket credential per installation

An installation with a Bitbucket repo in any project SHALL have `BITBUCKET_TOKEN`; without it the config load SHALL
fail, naming the projects that need it. An installation without Bitbucket repos SHALL not need it.

#### Scenario: The token is missing
- **WHEN** `atlas` lists a `bitbucket.org/` repo and `BITBUCKET_TOKEN` is not set
- **THEN** the bot does not start, and the error names `atlas` and `BITBUCKET_TOKEN`

### Requirement: Each token reaches its own host only

The sandbox SHALL clone and fetch a Bitbucket repo over HTTPS with `BITBUCKET_TOKEN`, through a git credential helper
scoped to `bitbucket.org`. The token SHALL reach the sandbox as a file, never on a command line. Git SHALL never send
the GitHub token to `bitbucket.org`, nor the Bitbucket token to `github.com`.

#### Scenario: Cloning
- **WHEN** a conversation of `atlas` starts and `booking-api` is not cloned yet
- **THEN** the sandbox clones `https://bitbucket.org/northwind/booking-api.git`, and the remote URL holds no token

#### Scenario: A fetch on a warm sandbox
- **WHEN** a later turn fetches `booking-api`
- **THEN** git authenticates with the Bitbucket token, and a GitHub repo of the same project fetches with the GitHub token

### Requirement: The GitHub token covers GitHub repos only

A turn's GitHub token SHALL be minted for the project's GitHub repos (and their dependency repos) only. A project with
no GitHub repo SHALL mint no GitHub token; its sandbox SHALL be seeded as under `GITHUB_AUTH=none`.

#### Scenario: A Bitbucket-only project
- **WHEN** every repo of `atlas` is on Bitbucket and the installation uses the GitHub App
- **THEN** the turn makes no GitHub call, and the sandbox has no GitHub token and no `gh` login

### Requirement: Bitbucket repos are read-only for the agent

The system prompt SHALL tell the agent that the Bitbucket repos are read-only: no push, no pull request, a proposed
change shown as a diff in the reply. The PR pollers and PR commands SHALL skip Bitbucket repos.

#### Scenario: The agent is asked to fix something
- **WHEN** a person asks the agent to fix a bug in `booking-api`
- **THEN** the agent answers with the diff it proposes, and nothing is pushed

#### Scenario: Status
- **WHEN** someone runs `/aven status` for `atlas`
- **THEN** the open pull request count covers `northwind/web` only, and nothing is asked of GitHub about `booking-api`

### Requirement: Projects without Bitbucket repos are unchanged

A project with no `bitbucket.org/` entry SHALL get the same credential helper, GitHub token request, system prompt and
poller behaviour as before this change.

#### Scenario: A GitHub-only project
- **WHEN** `atlas` lists only `northwind/web`
- **THEN** its prompt is byte-identical to before, and the sandbox's git config holds the same credential helper
