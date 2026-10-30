# Design

## Context

The motivation is in proposal.md, *Why*. What shapes the approach:

- **The token's path today.**
  - `src/config.ts` (`resolveClaudeToken`) reads `CLAUDE_CODE_OAUTH_TOKEN`, or the access token in `~/.claude/.credentials.json` on a developer machine, into `cfg.claudeOauthToken`.
  - `src/tasks.ts` calls `seedClaudeAuth` (`src/project.ts`) at sandbox preparation and before each turn. It uploads the token to `/root/.cc-token` through the file API and runs `chmod 600`.
  - `src/claudeSession.ts` starts the CLI with the prefix `CC_TOKEN_ENV`, `CLAUDE_CODE_OAUTH_TOKEN=$(cat /root/.cc-token)`. The value never enters a command string.
  - The CLI probe seeds the same file through the same function (`src/cliprobe/sandbox.ts`). Its local transport builds the environment with `isolatedClaudeEnv` (`src/clienv.ts`), which strips the shell's `ANTHROPIC_*` and sets the token.
- **What the CLI does with a key.** Claude Code reads `ANTHROPIC_API_KEY`. When both a key and `CLAUDE_CODE_OAUTH_TOKEN` are present, the key wins, silently (`src/clienv.ts` already guards the probe against it). Every turn's `system/init` carries `apiKeySource`, a required field in the SDK's declarations (`'ANTHROPIC_API_KEY' | 'apiKeyHelper' | '/login managed key' | 'none' | …`). `none` means no API key: a subscription, but also a bearer token or a cloud provider, none of which we support. Every recording we have shows `"none"`.
- **Cost.** The CLI's `result` carries `total_cost_usd`, the CLI's estimate at API list prices. `src/metering.ts` turns it into a per-turn delta. Under a key it is what the key is billed at list prices, before any negotiated discount and tax. Under a subscription it is an equivalent.
- **Quota.** `src/ratelimit.ts` reads `rate_limit_event`, which the SDK declares for subscription users: the five-hour and seven-day windows. `src/turn.ts` keeps one tracker per engine, one engine per process, and posts transitions to the alert channel; `/aven status` always shows its line (`src/chat/core/commands.ts`), and the Home tab names "the Claude subscription quota".
- **Live processes keep their environment.** A turn reuses the running `claude` process of its conversation, and after a bot restart the bot reattaches to the process still running in the sandbox (`src/tasks.ts`). Rewriting the credit file reaches only processes started afterwards.
- **Where the dollars are shown.** `aggregateUsage` and `usageSummaryText` in `src/metering.ts` (called by the engine's `usageReport`, `src/turn.ts`), the cost per helped answer in `src/feedback.ts`, and the messaging task costs (`src/messaging/`), labelled "API-equivalent".
- **Who can read the credit.** The agent runs as root in its sandbox. It can read `/root/.cc-token` and its own environment, today's token included. A key is worth more to a thief than a token: it is not tied to one person's subscription limits, and it spends money.

## Goals / Non-Goals

**Goals:**
- An installation can run on an API key with one line in `.env`.
- Nothing changes for an installation on a token, and a test proves it.
- The operator can see which credit paid and what a key was billed.
- The docs say which credit to use when: a token to try, a key for a team or clients.

**Non-Goals:**
- A key per project or per tenant (see *Later*).
- `ANTHROPIC_AUTH_TOKEN`, `apiKeyHelper`, Bedrock, Vertex, a proxy base URL.
- Hiding the credit from the agent. That needs a credential proxy outside the sandbox, a larger change.
- Spend limits in the bot. The Anthropic console's workspace spend limit does that better and outside the agent's reach.
- The lab bench (`src/lab/`), which stays on a subscription token.

## Decisions

### D1. One credit per installation, a tagged value
`Config.claudeOauthToken: string` becomes `Config.credit: { kind: 'api-key' | 'subscription'; value: string }`. `resolveCredit(env, home)` in `src/config.ts` is pure over its inputs and tested:

| `ANTHROPIC_API_KEY` | `CLAUDE_CODE_OAUTH_TOKEN` | Result |
|---|---|---|
| set | unset | key |
| unset | set | subscription |
| set | set | boot error: keep one |
| unset | unset | `~/.claude` access token as subscription, else boot error naming both |

The prefix checks (`sk-ant-api` / `sk-ant-oat`) catch the commonest paste mistake. They only reject a value whose prefix belongs to the other kind, so an unknown future prefix still passes.

*Why not let the key win, as the CLI does?* The operator who adds a key and forgets the token gets the right behaviour, but the operator who pastes a key into a template that still has a token gets the wrong bill without a sign. One sentence at boot is cheaper than either surprise.

Set means non-empty after trimming. dotenv does not override the shell, so a developer whose shell exports `ANTHROPIC_API_KEY` gets a key installation; the boot line (D3) says so, and `docs/local-dev.md` warns about it. `.env.example` keeps the key line commented out, so a fresh copy never has both.

### D2. Same file, kind-dependent prefix
The credit keeps living in `/root/.cc-token`. The prefix becomes a function: `ccCreditEnv(kind)` returns `CLAUDE_CODE_OAUTH_TOKEN=$(cat /root/.cc-token)` for a subscription, today's string, and `ANTHROPIC_API_KEY=$(cat /root/.cc-token)` for a key. `CC_TOKEN_ENV` stays exported as the subscription value, so a golden test of today's command needs no change.

`ClaudeLaunch` options gain `credit` (the kind only, never the value). `src/tasks.ts` passes `cfg.credit.kind`.

*Why not a second file?* One file means a switch of credit replaces the old value. Two files would leave a token in a sandbox that now runs on a key.

A switch reaches new processes only. A conversation whose process is running keeps the old credit until the process ends (idle stop, an error reopen, or the sandbox's recreation). The bot does not kill processes to force it: the per-turn `apiKeySource` (D3) records the truth meanwhile, and the docs say "the switch applies to new conversations; recreate the sandbox to apply it at once (the next turn creates it again)".

### D3. `apiKeySource` is the truth for metering
At boot the bot logs one line: the credit's kind and its variable (or the `~/.claude` fallback), never the value. `ClaudeSession` records `apiKeySource` from each `system/init`. `TurnResult.usage` gains `credit`, mapped from it: `ANTHROPIC_API_KEY` → `api-key`, `none` → `subscription`, anything else → the configured kind plus one warning. A mismatch with the configured kind logs one warning per session; after a switch, that is the expected sign of a process started before it. A record without `usage` (a canceled or timed-out turn) has no dollars and no `credit`. The record is what the CLI said, so a mis-wired command shows up in the figures, not just in a log.

### D4. The report labels, never sums across credits
`aggregateUsage` keeps a key total beside the dollar total; `usageSummaryText` picks the header from the set of credits in the period.
- Only subscription records: today's text, untouched; a test pins it.
- Only key records: the header reads "$ = billed to the API key at list prices (before discounts and tax)".
- Both, which happens only in the month of a switch: today's lines count subscription dollars, and one extra line gives the key's total. Project lines are not split.

Turns, tokens and active time are summed as before. The cost per helped answer (`src/feedback.ts`) uses the credit with the most dollars in the period and says which. The messaging task costs say "USD" instead of "API-equivalent" on a key installation.

### D5. No subscription quota on a key installation
One tracker per installation and one credit per installation, so the rule is per installation: with a key, the engine does not connect `onRateLimit` to the tracker, `/aven status` drops the quota line, and the Home tab's quota sentence names a subscription. A process still running on the old token after a switch is ignored too; it ends soon. Rate limits of a key surface as API errors in a turn, as any other error does today.

### D6. The probe takes one credit
`probeToken()` becomes `probeCredit()`: `CLI_PROBE_TOKEN` or `CLI_PROBE_API_KEY`, exactly one. `isolatedClaudeEnv` takes an optional credit kind beside the token value, so the lab's call stays as it is, and sets the matching variable after stripping `ANTHROPIC_*` as now. The kind also reaches the launch options the probe builds (`src/cliprobe/ctx.ts`), so the sandbox transport's command uses the key prefix.

Reports merge rows from many runs, so the credit lives on the row: `credit` on each report row, absent meaning subscription, which leaves every committed `REPORT.md` and `report.json` unchanged. The header lists the set of credits, like `transport`, and the total cost is split per credit.

A scenario may declare `needs: 'api-key'`. `cli.ts` drops such a scenario from a token run before any transport is built, and the merge keeps its earlier row and recording. The key scenario (`api-key-turn`) is a candidate, not a contract scenario: it becomes contract when an installation we operate runs on a key, so that every pin bump proves it. It also runs one Bash tool call that reports whether `ANTHROPIC_API_KEY` is in its environment, so the docs can say what tool subprocesses see.

### D7. Docs order: a token to try, a key to serve
The maintainer, 2026-10-30: the quickstart shows the subscription token first, because `claude setup-token` is one command and a key is a console account, billing and a workspace. A key is the recommended credit for an installation that serves a team or clients. Every page that names the credit gives both in that order, with the "exactly one" rule. Exposure gets one practical line, not a section, where the key is configured and in `SECURITY.md`'s sandbox threat model: the sandbox can read the credit, as it can the token, so use a dedicated key in its own Anthropic workspace with a monthly spend limit. The reason is not the model's judgement but everything else running in the sandbox: package scripts, dependencies, a client repository's tooling, and text the agent reads.

## Risks / Trade-offs

- **The agent can read the key.** Same as the token today, worth more. Mitigation: the docs' advice (D7); hiding it is a later change.
- **`apiKeySource` changes.** It is a required, documented field of `system/init`, and the probe checks frames against the declarations. If a version drops it, D3 falls back to the configured kind and warns.
- **`ANTHROPIC_API_KEY` is a well-known name.** Tools in the sandbox that look for it (a nested `claude`, an SDK in a client's test suite, a compose file passing it through) may use it. The probe records whether tool subprocesses see it; the spend limit bounds the damage either way. A project's MCP `${ENV}` value can name it like any bot variable, which the docs mention.
- **The canary costs money.** A weekday cycle of the home bot on a key costs what the usage log already estimates for one (single-digit dollars a day at today's volume). The maintainer provides the key; the canary task says how to switch back.

## Migration

None for token installations. A key installation: create a key in the Anthropic console, preferably in its own workspace with a spend limit, put it in `.env` as `ANTHROPIC_API_KEY`, remove `CLAUDE_CODE_OAUTH_TOKEN`, and restart. Back: the reverse. New conversations run on the new credit at once; running ones when their process ends, or at once after the operator recreates the sandbox (`docker rm -f` of its container; the next turn creates it again).

## Later

- **A key per project or tenant.** A project's `credit` entry naming an environment variable (`"credit": { "apiKey": "${CLIENT_A_ANTHROPIC_KEY}" }`), resolved like the MCP entries' `${ENV}` values, so an agency bills each client's work to the client's own workspace. It builds on D1–D3 without changing them: the file and the prefix are already per sandbox.
- **Keeping the credit out of the sandbox.** A credential proxy beside the bot, with `ANTHROPIC_BASE_URL` pointing at it and a per-sandbox token, as the gateway does for MCP.
