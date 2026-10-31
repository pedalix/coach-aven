# Spec Delta

## Purpose

How an installation reaches GitHub: a plain token, a GitHub App's installation tokens minted per turn, or — said explicitly — no access at all.

## ADDED Requirements

### Requirement: An installation may run without GitHub access
With `GITHUB_AUTH=none`, the bot SHALL start without a GitHub credential: it SHALL seed no token into a sandbox, ask the GitHub API without authentication, write no composer `auth.json`, and tell the agent in its system prompt that nothing can be pushed. Any other value, or `none` beside `GITHUB_TOKEN` or `GITHUB_APP_ID`, SHALL stop the boot. Unset, a missing credential SHALL stop the boot as before.

#### Scenario: The quickstart's read-only trial
- **WHEN** the installation sets `GITHUB_AUTH=none` and a project lists a public repository
- **THEN** the sandbox clones it anonymously, `gh` stays logged out, and the agent, asked for a change, shows the diff and names the token that would let it open a pull request

#### Scenario: A forgotten token
- **WHEN** neither `GITHUB_TOKEN`, `GITHUB_APP_ID` nor `GITHUB_AUTH` is set
- **THEN** the boot stops, as it always did

#### Scenario: Prompts unchanged
- **WHEN** `GITHUB_AUTH` is unset
- **THEN** every system prompt is byte-identical to today's golden fixtures
