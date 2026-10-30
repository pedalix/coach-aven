# Proposal

## Why

Every sandbox runs Claude Code on one kind of credit: a subscription token (`claude setup-token`, `CLAUDE_CODE_OAUTH_TOKEN`). That has three costs:
- **It does not fit an agency.** An operator who runs agents for clients needs a credit whose use is billed, metered and limited per installation. A personal subscription's terms and rate limits are not made for a service that many people drive.
- **The cost figures are not a bill.** `/aven usage` shows the CLI's own estimate at API list prices and says "not a bill". The operator cannot tell a client what the work cost.
- **The docs say "there is no API-key mode".** `docs/why.md`, `docs/how-we-work.md` and the README tell a reader that the only way in is a Claude Max subscription.

Claude Code itself takes an API key from `ANTHROPIC_API_KEY`. The bot only needs to pass one into the sandbox the way it passes the token today, check which credit the CLI actually used, and say so in its figures.

The maintainer's decision of 2026-10-30 sets the docs' order:
- an API key is the path for an installation that serves a team or clients;
- a subscription token stays fully supported and is the quick way to try CoachAven: `claude setup-token` takes one command, an API key takes a console account, billing and a workspace. The quickstart shows the token first.

## What Changes

- **A second credit, `ANTHROPIC_API_KEY`.** An installation sets exactly one of `ANTHROPIC_API_KEY` and `CLAUDE_CODE_OAUTH_TOKEN` in its `.env`.
  - Both set stops the boot with one sentence. Claude Code would silently prefer the key, and the operator would not know which credit pays.
  - A value in the wrong variable stops the boot: an API key starts with `sk-ant-api`, a subscription token with `sk-ant-oat`.
  - The `~/.claude` fallback of a developer machine stays, and applies only when neither is set.
  - Neither set and no fallback: the boot error names both variables.
- **The sandbox gets the credit the way it gets the token today.** The value goes into the sandbox's credit file through the file API, never through a command line. The CLI's command reads it into `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN`, whichever the installation uses. With the token, the command is byte-for-byte today's.
- **The bot checks which credit the CLI used.** `system/init` carries `apiKeySource`: `ANTHROPIC_API_KEY` for a key, `none` for a subscription token. A mismatch with the configured credit logs one warning per session.
- **Usage records name their credit.** Each usage record carries `credit`: `api-key` or `subscription`, from `apiKeySource`. `/aven usage` labels its dollars per credit: with a key they are what the key is billed at list price, with a subscription they stay an API-list-price equivalent. Records written before this change count as subscription.
- **The quota alert stays a subscription feature.** On a key installation the bot tracks no subscription quota: no alert, no `/aven status` quota line.
- **A switch applies to new processes.** A conversation whose CLI process is running keeps its credit until the process ends; the per-turn `apiKeySource` records the truth meanwhile. A boot line names the credit and its variable.
- **The CLI probe gets a key scenario.** `CLI_PROBE_API_KEY` is the probe's own variable for a key, as `CLI_PROBE_TOKEN` is for a token, and a run takes exactly one of them. A scenario runs one turn on a key and records `apiKeySource`, the cost, the `rate_limit_event` and whether tool subprocesses see the key. A token run skips it without touching its earlier result. Report rows carry their credit, so a merged report never sums a key's and a token's dollars.
- **Docs.**
  - The README's first screen and setup steps: a subscription token to try it, an API key for a team or clients, each in one line with its command or console link.
  - `.env.example`, the ops template's `.env.example`, `docs/local-dev.md` and `infra/deploy/README.md` show both variables and the rule "exactly one".
  - `docs/why.md`, `docs/how-we-work.md` and `docs/multitenancy.md` drop "there is no API-key mode".
  - One practical line where the key is configured and in `SECURITY.md`: the sandbox can read the credit, as it can the token, so use a dedicated key in its own Anthropic workspace with a spend limit.
  - `docs/observability.md` stops saying every turn runs on one Max plan; the Home tab's quota sentence names a subscription.
  - `docs/cli-probe.md` describes `CLI_PROBE_API_KEY`.

## Capabilities

### New Capabilities
- `model-credit`: which credit pays for the sandboxes' Claude Code, how it is configured and checked at boot, how it reaches a sandbox without appearing in a command line, how the bot confirms the credit the CLI used, and how usage records and `/aven usage` name it.

### Modified Capabilities
- `cli-probe`: a live run takes either a subscription token or an API key, each from the probe's own variable, never both. A key scenario records what the CLI reports under a key.

## Impact

- **Rollout:** bucket 2, default-preserving. An installation without `ANTHROPIC_API_KEY` runs today's command, byte for byte, pinned by a test. The usage report's text for an installation with only subscription records stays as it is. The key reaches an installation only when its operator sets it. `docs/rollout.md` gets one row: canary (the home bot on a key for at least one weekday cycle) → prod only if its operator chooses a key; there is no default to flip, because both credits stay.
- **Code:**
  - `src/config.ts`: the credit (`{ kind: 'api-key' | 'subscription', value }`) replaces `claudeOauthToken`, with the boot checks;
  - `src/project.ts`: `seedClaudeAuth` writes the credit; the command prefix depends on the kind;
  - `src/claudeSession.ts`: the prefix comes from the session's options; `apiKeySource` is read from `system/init`;
  - `src/tasks.ts`, `src/cliprobe/sandbox.ts`, `src/cliprobe/local.ts`, `src/cliprobe/install.ts`, `src/clienv.ts`: the credit instead of a token;
  - `src/metering.ts` (`aggregateUsage`, `usageSummaryText`), `src/feedback.ts` and the messaging cost labels: per-credit dollars;
  - `src/turn.ts`, `src/chat/core/commands.ts`, `src/chat/slack/blocks.ts`: no subscription quota on a key installation, and the Home tab's wording;
  - `src/cliprobe/{install,ctx,runner,cli,report}.ts` and a new scenario in `src/cliprobe/scenarios/`;
  - tests that clear credential variables (`src/config.test.ts`, `src/chat/teams/config.test.ts`) clear `ANTHROPIC_API_KEY` too; `scripts/host-tools-smoke.mjs`.
- **Not in this change:**
  - a key per project or per tenant (design, *Later*);
  - `ANTHROPIC_AUTH_TOKEN`, `apiKeyHelper`, Bedrock and Vertex;
  - the lab bench (`src/lab/`), which keeps its subscription token;
  - the quickstart itself, a separate change after `container-deploy`.
