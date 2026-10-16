# teams-bot-infra Specification

## Purpose
Creates the Microsoft Teams side of an installation — the bot's identity in Entra, the Azure Bot resource with its Teams channel, and the Teams app package — from one variables file, so a Teams installation is reproducible and its identifiers never live in the public repository.

## Requirements

### Requirement: One apply creates a Teams installation's bot identity
The public repo SHALL ship a Terraform module (`infra/teams/`) that, given a tenant id, a subscription id, a bot name and a messaging endpoint, creates a single-tenant Entra application with a client secret, an Azure Bot resource (free tier) bound to that application and endpoint, and the Teams channel on it. The module SHALL contain no tenant, subscription or application identifier; those SHALL come from the overlay's variables file.

#### Scenario: Fresh apply
- **WHEN** an overlay applies the module with its variables file against an empty tenant
- **THEN** the Entra app, the Azure Bot and the Teams channel exist, and the outputs name the app id, the tenant id and the secret (the secret marked sensitive)

#### Scenario: Re-apply without changes
- **WHEN** `terraform plan` runs again with the same inputs
- **THEN** it reports no changes

#### Scenario: Endpoint moves
- **WHEN** the messaging endpoint variable changes and the module is applied
- **THEN** only the Azure Bot's endpoint is updated; the app id, the secret and the Teams app id are unchanged

#### Scenario: No identifiers in the public tree
- **WHEN** the public guard runs over the tracked files
- **THEN** `infra/teams/` contributes no hit

### Requirement: Secret rotation is an apply
The client secret SHALL expire after one year and SHALL be re-minted by `terraform apply` once that period has passed; the previous secret SHALL remain valid until the apply that replaces it.

#### Scenario: Apply after the rotation period
- **WHEN** more than a year has passed since the secret was created and `terraform apply` runs
- **THEN** a new secret is created and output; the installation's `.env` is updated by the operator and the service restarted

### Requirement: The Teams app package is built from state
The module SHALL render the Teams app manifest from a template with the application's id, a stable Teams app id kept in state, the installation's display name and the package version, and SHALL produce a zip with the manifest and the two icons. The manifest SHALL declare the bot for personal, team and group-chat scopes and request the resource-specific permissions that let the bot read channel and chat messages without a mention.

#### Scenario: Version bump
- **WHEN** the package version variable changes and the module is applied
- **THEN** a new zip with the new version exists and the Teams app id in it is the same as before

#### Scenario: Manifest validity
- **WHEN** the rendered manifest is validated against the Teams manifest schema it declares
- **THEN** it passes

### Requirement: Publishing to the organization catalog
A publish script SHALL upload the package as an organization app on first run and update the existing app on later runs, finding it by the Teams app id from state; it SHALL authenticate interactively as a Teams administrator and never store a credential.

#### Scenario: First publish
- **WHEN** the script runs and no organization app with the Teams app id exists
- **THEN** a new organization app is created and its catalog id printed

#### Scenario: Update
- **WHEN** the script runs after a version bump and the app exists
- **THEN** the existing app is updated in place; users keep their installation
