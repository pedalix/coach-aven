# Spec Delta

## Purpose

Decides which credit pays for the Claude Code that runs in an installation's sandboxes: an Anthropic API key or a Claude subscription token. Covers how the credit is configured and checked at boot, how it reaches a sandbox, how the bot confirms the credit the CLI used, and how the usage figures name it.

## ADDED Requirements

### Requirement: An installation runs on exactly one credit
An installation SHALL take its credit from its environment: `ANTHROPIC_API_KEY` for an API key, or `CLAUDE_CODE_OAUTH_TOKEN` for a subscription token. When neither is set, it SHALL fall back to the machine's own Claude Code login (`~/.claude/.credentials.json`) as a subscription credit. The boot SHALL stop with one sentence naming the variables when both are set or when neither is set and there is no fallback.

#### Scenario: A key
- **WHEN** `.env` sets `ANTHROPIC_API_KEY` and not `CLAUDE_CODE_OAUTH_TOKEN`
- **THEN** the installation's credit is an API key, and the fallback is not read

#### Scenario: A token
- **WHEN** `.env` sets `CLAUDE_CODE_OAUTH_TOKEN` and not `ANTHROPIC_API_KEY`
- **THEN** the installation's credit is that subscription token, as before this change

#### Scenario: Both
- **WHEN** `.env` sets both variables
- **THEN** the boot stops and says to keep exactly one of them

#### Scenario: Nothing
- **WHEN** neither variable is set and the machine has no Claude Code login
- **THEN** the boot stops and names both variables with how to obtain each

### Requirement: A credit in the wrong variable stops the boot
The boot SHALL stop when `ANTHROPIC_API_KEY` holds a value starting with `sk-ant-oat` or `CLAUDE_CODE_OAUTH_TOKEN` holds one starting with `sk-ant-api`, and say which variable the value belongs in. A value with any other prefix SHALL pass.

#### Scenario: A token in the key's variable
- **WHEN** `ANTHROPIC_API_KEY` holds a value starting with `sk-ant-oat`
- **THEN** the boot stops and says the value is a subscription token that belongs in `CLAUDE_CODE_OAUTH_TOKEN`

#### Scenario: An unknown prefix
- **WHEN** `ANTHROPIC_API_KEY` holds a value with a prefix neither check knows
- **THEN** the boot goes on with an API-key credit

### Requirement: The credit reaches the sandbox as a file, never in a command
The bot SHALL write the credit into the sandbox through the driver's file API, readable by its owner only, before each session and each turn. The CLI's command SHALL read that file into `ANTHROPIC_API_KEY` for a key or `CLAUDE_CODE_OAUTH_TOKEN` for a token, and set no other Claude credential. The value SHALL NOT appear in a command line, log line or error. With a token, the command SHALL equal today's, byte for byte.

#### Scenario: Token installation after the change
- **WHEN** an installation on a subscription token starts a session
- **THEN** the CLI's command equals the command before this change

#### Scenario: Key installation
- **WHEN** an installation on an API key starts a session
- **THEN** the command sets `ANTHROPIC_API_KEY` from the credit file, and `CLAUDE_CODE_OAUTH_TOKEN` is not set

#### Scenario: Switching credit
- **WHEN** the operator replaces the token with a key in `.env` and restarts the bot
- **THEN** every CLI process started after the restart runs on the key, without recreating the sandbox, and a process that was already running keeps the credit it was started with until it ends

### Requirement: The bot confirms the credit the CLI used
The bot SHALL log one boot line naming the credit's kind and the variable it came from. It SHALL read `apiKeySource` from each turn's `system/init`, counting `ANTHROPIC_API_KEY` as a key and `none` as no key. When that disagrees with the installation's credit, it SHALL log one warning per session naming both.

#### Scenario: Agreement
- **WHEN** a key installation's session reports `apiKeySource: "ANTHROPIC_API_KEY"`
- **THEN** nothing is logged about the credit

#### Scenario: The boot line
- **WHEN** the bot starts on a key that came from the shell's environment rather than `.env`
- **THEN** its boot line names the API key and `ANTHROPIC_API_KEY`, never the value

#### Scenario: Disagreement
- **WHEN** a key installation's session reports `apiKeySource: "none"`
- **THEN** the bot logs one warning for that session, naming the configured and the reported credit

### Requirement: Usage figures name their credit
Each usage record SHALL carry `credit`, `api-key` or `subscription`, from the session's `apiKeySource`, or from the installation's credit when that is missing. A record without `credit` SHALL count as `subscription`. `/aven usage` SHALL label key dollars as billed at list prices and subscription dollars as an equivalent, never sum the two, and keep today's text for a period of subscription records only.

#### Scenario: Old records only
- **WHEN** the period holds only records written before this change
- **THEN** the report reads as it did before this change

#### Scenario: Key records
- **WHEN** the period holds only `api-key` records
- **THEN** the header says the dollars are what the key is billed at list prices, without "not a bill"

#### Scenario: Mixed period
- **WHEN** an installation moved from a token to a key during the period
- **THEN** the report shows the key's total and the subscription's equivalent as two figures, never one sum

#### Scenario: Cost per helped answer
- **WHEN** `/aven usage` shows the cost per answer that helped
- **THEN** it is computed from one credit's dollars only and labelled with that credit

### Requirement: Subscription quota alerts apply to a subscription only
On an installation whose credit is an API key, the bot SHALL NOT track subscription quota: no alert-channel warning about subscription windows and no quota line in `/aven status`.

#### Scenario: Key installation with a rate-limit event
- **WHEN** a session of a key installation emits a `rate_limit_event`
- **THEN** no subscription-window warning reaches the alert channel and `/aven status` shows no quota line

#### Scenario: Token installation
- **WHEN** an installation runs on a subscription token
- **THEN** quota warnings and the `/aven status` quota line behave as before this change
