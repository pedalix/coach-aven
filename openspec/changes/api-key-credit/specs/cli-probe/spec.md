# Spec Delta

## MODIFIED Requirements

### Requirement: A probe run is isolated from the machine it runs on
A run SHALL use:
- the CLI version it names, installed outside the machine's own installation, or a binary given explicitly;
- a configuration directory created for the run;
- one model credit given to the probe in its own variable: a subscription token in `CLI_PROBE_TOKEN` or an API key in `CLI_PROBE_API_KEY`;
- the bot's own command line (environment prefix, behaviour variables and flags), with the scenario's extras merged into it;
- an empty working directory.

It SHALL remove the environment variables a parent Claude Code session sets, and every `ANTHROPIC_*` variable of the shell, before it sets the run's credit. Nothing from the operator's own Claude Code configuration (settings, plugins, skills, memory, hooks) SHALL reach the run.

A run SHALL check the version the CLI reports in `system/init` against the version it names. A mismatch SHALL end the run as an error, not as a verdict.

#### Scenario: The operator's configuration does not leak
- **WHEN** the operator's own Claude Code has plugins and a default permission mode
- **THEN** the probe run's `system/init` lists none of those plugins, and permissions behave as the bot's flags make them behave

#### Scenario: Started from inside a Claude Code session
- **WHEN** the operator starts the probe from a Claude Code session
- **THEN** the CLI under test sees none of that session's environment variables

#### Scenario: The shell has an API key of its own
- **WHEN** the operator's shell exports `ANTHROPIC_API_KEY` and the run is given `CLI_PROBE_TOKEN`
- **THEN** the CLI under test runs on the probe's token and reports `apiKeySource: "none"`

#### Scenario: The bot's flags change
- **WHEN** the bot's spawn command changes
- **THEN** the next probe run uses the changed command without a change to the probe

#### Scenario: Version not installed
- **WHEN** the named version is not on the machine
- **THEN** the probe installs it in its own cache, and the machine's own `claude` stays as it was

#### Scenario: The wrong CLI answers
- **WHEN** the CLI that starts reports a version other than the one the run names
- **THEN** the run ends as an error naming both versions, and no verdict is recorded

### Requirement: Live runs belong to the operator, never to CI
A live run SHALL take its credit only from the probe's own variables, `CLI_PROBE_TOKEN` or `CLI_PROBE_API_KEY`, and SHALL stop before starting the CLI when both are set. Each report row SHALL carry the credit it ran on, a row without one counting as a subscription token. The report SHALL show cost per scenario and in total per credit.

CI SHALL run without any model credential. It checks committed reports and recordings only.

A probe run SHALL NOT read or change any installation's state, configuration or project sandboxes. The sandbox transport SHALL use only the driver settings in the probe's own environment.

#### Scenario: CI on a pull request
- **WHEN** CI runs on a pull request
- **THEN** no CLI is started against the model API, and the checks use only the committed files and the fetched declarations

#### Scenario: No token
- **WHEN** the operator starts a live run without either probe variable, on a host whose installation has a credit of its own
- **THEN** the probe stops before starting the CLI, names both of its variables, and does not use the installation's credit

#### Scenario: Both credits
- **WHEN** both `CLI_PROBE_TOKEN` and `CLI_PROBE_API_KEY` are set
- **THEN** the probe stops before starting the CLI and says to keep one

#### Scenario: Cost
- **WHEN** a live run ends
- **THEN** the report lists the cost of each scenario and a total per credit, labelled billed for a key and API-equivalent for a token, never one sum

#### Scenario: Probe beside a running bot
- **WHEN** the operator runs the probe with the sandbox transport on the host where an installation's sandboxes run
- **THEN** the probe creates, uses and deletes only its own sandbox, and the bot's state file, chat records and project sandboxes are unchanged

## ADDED Requirements

### Requirement: The probe records what the CLI reports on an API key
A scenario SHALL declare that it needs an API key, run one turn through the bot's command on one, and record `apiKeySource`, the cost, every `rate_limit_event`, and whether a Bash tool call sees `ANTHROPIC_API_KEY`. It SHALL hold when `apiKeySource` is `ANTHROPIC_API_KEY` and the turn succeeds. A token run SHALL skip it before any transport is built and SHALL NOT replace its existing row or recording.

#### Scenario: Key run
- **WHEN** a live run is given `CLI_PROBE_API_KEY`
- **THEN** the scenario's recording holds `apiKeySource: "ANTHROPIC_API_KEY"`, a successful result with its cost, the rate-limit events the CLI emitted, if any, and whether the tool subprocess saw the key

#### Scenario: Token run after a key run
- **WHEN** a routine token run of the same CLI version follows a key run
- **THEN** no sandbox is created for the key scenario, and its earlier row and recording stay as they were
