# Tasks

## 1. The credit in configuration (bucket 2)

- [ ] 1.1 `resolveCredit(env, home)` in `src/config.ts` (design D1), pure over its inputs; "set" means non-empty after trimming; `Config.credit` replaces `claudeOauthToken`. Verify, in `src/config.test.ts`: each row of D1's table, a blank value, both prefix mix-ups, an unknown prefix passing, and each error's sentence naming the variables and never the value.
- [ ] 1.2 Every reader of `claudeOauthToken` moves to `credit`: `src/tasks.ts`, the composition roots, and any test fixture building a `Config`. `src/config.test.ts` and `src/chat/teams/config.test.ts` clear `ANTHROPIC_API_KEY` beside the variables they already clear. Verify: `npm run typecheck`; `grep -rn claudeOauthToken src` finds nothing; `npm test` passes with `ANTHROPIC_API_KEY` exported in the shell.
- [ ] 1.3 The boot line (design D3): the credit's kind and its source (`ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN` or the `~/.claude` login), never the value. Verify: a test of the line's text for each source.

## 2. The credit in the sandbox (bucket 2)

- [ ] 2.1 `seedClaudeAuth(sandbox, credit)` writes the value as today; `ccCreditEnv(kind)` in `src/project.ts` (design D2), `CC_TOKEN_ENV` kept as the subscription value. Verify: a test that `ccCreditEnv('subscription') === CC_TOKEN_ENV` and equals today's string, and that the key prefix sets `ANTHROPIC_API_KEY` only.
- [ ] 2.2 `ClaudeLaunch` options take `credit` (the kind); `src/claudeSession.ts` builds the command with `ccCreditEnv`. Verify: the spawn golden test (`src/claudeSession.test.ts`) and `src/tasks.wiring.test.ts` pass unchanged; a new case for `'api-key'`; no test sees the value in the command.
- [ ] 2.3 `src/tasks.ts` passes `cfg.credit` at preparation, per turn and to new sessions. Verify: a test over the stub driver: a key config writes the key to the credit file and a new session's command carries the key prefix; a reattached or reused process is left as it is (design D2).

## 3. Confirming and showing the credit (bucket 2)

- [ ] 3.1 `ClaudeSession` reads `apiKeySource` from each `system/init`; `TurnUsage.credit` (design D3); one warning per session on a mismatch. Verify: tests over recorded frames: `"none"` with a subscription config (no warning), `"none"` with a key config (one warning across two turns), a missing field (configured kind, a warning).
- [ ] 3.2 `src/metering.ts`: `credit` on the record, absent counts as subscription; `aggregateUsage` keeps a key total; `usageSummaryText` picks the header (design D4). Verify: a test pins today's text for subscription-only records byte for byte; cases for key-only and mixed periods.
- [ ] 3.3 The other dollar figures (design D4): the cost per helped answer in `src/feedback.ts` uses one credit and names it; the messaging task costs (`src/messaging/service.ts`, `runtime.ts`) say "USD" on a key installation. Verify: tests for both, today's text on a subscription installation.
- [ ] 3.4 No subscription quota on a key installation (design D5): `src/turn.ts` does not connect `onRateLimit`; `/aven status` (`src/chat/core/commands.ts`) drops the quota line; the Home tab (`src/chat/slack/blocks.ts`) says the quota line is for a subscription. Verify: a test with a key config feeds a `rejected` event and sees no alert and no status line; the Home tab snapshot re-recorded on purpose; a token config's status unchanged.

## 4. The CLI probe (operator tooling)

- [ ] 4.1 `probeCredit()` in `src/cliprobe/install.ts`; `isolatedClaudeEnv` takes an optional kind, the lab's call unchanged; the kind reaches the launch options in `src/cliprobe/ctx.ts` and both transports (design D6). Verify: tests for no variable, both, each one; a shell `ANTHROPIC_API_KEY` stripped on a token run; `src/lab/` tests pass unchanged.
- [ ] 4.2 Report rows carry `credit`, absent meaning subscription; the header lists the set; the cost total is split per credit (`src/cliprobe/report.ts`). Verify: the golden `REPORT.md` test passes unchanged; a merged case with a key row and token rows.
- [ ] 4.3 `needs: 'api-key'` on a scenario; `src/cliprobe/cli.ts` drops it from a token run before any transport is built, and the merge keeps its earlier row and recording. Verify: a test of selection and of the merge.
- [ ] 4.4 The `api-key-turn` candidate scenario: one turn with one Bash call that reports whether `ANTHROPIC_API_KEY` is set (never its value); it records `apiKeySource`, the cost and every `rate_limit_event`. Verify: a replay test over a hand-built recording.
- [ ] 4.5 `scripts/host-tools-smoke.mjs`: the credit prefix from the credit kind. Verify: a read; it runs on the home machine.
- [ ] 4.6 **Needs the maintainer: an API key.** A live run of `api-key-turn` on the pinned CLI (2.1.292) through the sandbox transport, recording committed to `src/fixtures/cli/2.1.292/`. Verify: the report shows `holds` and `apiKeySource: "ANTHROPIC_API_KEY"`; what `rate_limit_event` carried and whether the tool subprocess saw the key go into the docs (task 5.2); adjust D5 if the recording surprises.

## 5. Docs

- [ ] 5.1 README: the setup step and the status line give both credits in D7's order (token to try, key for a team or clients) and drop "API-key credit is coming". `.env.example` (key line commented out), `infra/deploy/ops.example/.env.example`, `docs/local-dev.md` (with the shell-export trap), `infra/deploy/README.md`: both variables, "exactly one", and "a switch applies to new conversations". Verify: `src/doclinks.ts` test, public guard, and a read of each page.
- [ ] 5.2 `docs/why.md`, `docs/how-we-work.md`, `docs/multitenancy.md`, `docs/observability.md` drop "there is no API-key mode" and "every turn runs on one Max plan", and say what the key changes (billing, metering). `docs/runtime-config.md` lists `ANTHROPIC_API_KEY` with the one exposure line (design D7); `SECURITY.md`'s sandbox threat model gets the same line. `docs/cli-probe.md` and `docs/lab.md` describe `CLI_PROBE_API_KEY` and the lab staying on a token.
- [ ] 5.3 `docs/rollout.md`: one row, bucket 2, gate "`ANTHROPIC_API_KEY` set"; stages canary → prod only by its operator's choice; no default flip.

## 6. Ship

- [ ] 6.1 One PR for sections 1–5, bucket 2, with the ledger row. Verify: `npm run typecheck`, `npm test`, public guard and gitleaks on every changed file and the PR text; an independent review before merge.
- [ ] 6.2 **Needs the maintainer: the same key or another, in its own workspace with a spend limit.** Canary: the home bot on the key for one weekday cycle. Switch: `ANTHROPIC_API_KEY` in its `.env`, `CLAUDE_CODE_OAUTH_TOKEN` commented out, restart in the 20:30–08:00 window. Watch: the boot line, no credit warning on new conversations, `/aven usage` showing key dollars, the Anthropic console's usage for the same day within a few percent. Back: the reverse. Record dates in the ledger row.
- [ ] 6.3 Archive with `/opsx:archive` after the canary.
