# Spec Delta

## MODIFIED Requirements

### Requirement: Without a grant the token is unchanged

A project holding no grant SHALL be minted exactly the agent's standing permissions — contents write, pull requests
write, checks read, actions read and metadata read — and nothing SHALL be posted.

#### Scenario: No grant
- **WHEN** a turn starts for a project with no grant recorded
- **THEN** the requested permissions are exactly contents write, pull requests write, checks read, actions read and
  metadata read

#### Scenario: Reading why CI failed
- **WHEN** a check of the project's pull request failed and the agent asks GitHub for that run's job log
- **THEN** it gets the log, with no grant, while a push of a workflow file is still refused

#### Scenario: Installation without Actions access
- **WHEN** the App installation holding the project's repositories has not approved `actions`
- **THEN** the token is minted without it, and every other permission is requested as before
