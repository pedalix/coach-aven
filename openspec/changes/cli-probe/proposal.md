## Why

The bot drives Claude Code over the CLI's headless stream-json protocol, and Anthropic publishes no specification of that protocol. claude-code#102880, "Emit a JSON Schema for the stream-json protocol", is still open. So every fact the bot relies on is observed, not promised:
- what `system/init` and `result` carry;
- how a host MCP call and an `AskUserQuestion` prompt travel over the control channel;
- what an interrupt or `--resume` does;
- how a background task reports after its turn.

A pin bump re-tests none of it. Today it is "canary first" and watching the channel. Prod once sat on one CLI version for months because nothing told anyone to move (`src/cliversion.ts`).

`agent-messaging` adds facts that depend on timing:
- a message written mid-turn is folded in at the next tool boundary;
- its echo comes when the CLI takes it up.

The harness that measured them lives in a scratchpad. It ran against the operator's own Claude Code configuration, and its recordings carry machine paths and identifiers. This change turns it into a tool in the repository:
- each hypothesis gets a verdict;
- each probed version leaves normalized recordings;
- the repository can only pin a CLI version whose contract was probed.

## What Changes

- **A harness, `npm run cli-probe`.** Each scenario states one hypothesis about the CLI.
  - A run is judged holds, fails or inconclusive. A precondition the model did not meet makes it inconclusive; a prediction the CLI did not meet makes it fail.
  - Runs that disagree make the scenario flaky.
- **Isolated runs.** A run uses:
  - a named CLI version installed aside, whose version is checked against `system/init`;
  - a fresh configuration directory;
  - a token from the probe's own variable, never an installation's;
  - the bot's own command line, from one function that the bot and the probe share.

  It runs locally, or in a throwaway sandbox through the bot's sandbox driver to cover the real stdin path.
- **Contract and exploratory scenarios.**
  - **Contract** scenarios are the facts the bot relies on today, nine of them:
    - a plain turn and the `result` fields;
    - the host tool round trip over `mcp_message`;
    - `AskUserQuestion` under bypass;
    - a withdrawn question;
    - interrupt;
    - `--resume`;
    - a background report after the turn;
    - subagent parent ids;
    - the `rate_limit_event` shape.
  - **Exploratory** scenarios record facts without gating: the measured rows of `agent-messaging` (priority, fold-in, echo, hooks, kill before take-up) and candidates from the SDK's declarations.
- **A report and recordings for each probed version**, committed under `src/fixtures/cli/<version>/`.
  - Recordings hold both directions and the process restarts. They are normalized: no machine path in any string, no identifier, time or signature the CLI or the API issued.
  - The report shows what changed since the last probed version.
- **Event checks against the de facto schema**: the type declarations of `@anthropic-ai/claude-agent-sdk`, in the release that names the probed CLI version.
  - A structural walk reports every finding of a frame: violations, undeclared fields, undeclared kinds.
  - The declarations are fetched at check time, neither installed nor committed.
- **Replay tests.** Every contract recording is replayed through `ClaudeSession` in `npm test`, offline.
- **A set of probed versions**, `PROBED_CLI_VERSIONS` in `src/cliversion.ts`.
  - A version enters it only with a committed report where every contract scenario holds.
  - The images' default CLI version and `.env.example` must be in it. CI checks this and re-checks the recordings.
  - `snapshot/build-and-push.sh` refuses to bake a version outside it.
- **`deleteSandbox(name)` on `SandboxDriver`**, for the probe's throwaway sandboxes. A shared guard refuses any project sandbox, and the bot does not call it.
- **Small refactors**, both byte-identical.
  - The spawn command comes from one function. A test pins it.
  - The lab's parent-variable scrub moves to a shared module.
- **Docs.** `docs/cli-probe.md` covers running, writing a scenario, reading a report and the pin-bump procedure. The README's Claude Code version section gets the probe step.

## Out of scope

- **Live runs in CI.** The public repository holds no model credential. A scheduled run against npm `stable` from an installation's private ops repo is a later step.
- **Pins outside the repository.** Installations' `.env` and projects' `cliVersion` are not checked at runtime. The procedure covers them, the image build refuses an unprobed one, and `agent-messaging`'s per-session check will be the first runtime reader of the set.
- **Driving the CLI through the Agent SDK** instead of `ClaudeSession`. That is a separate evaluation, because the bot's reattach to a running CLI has no counterpart there.
- **Bumping the fleet's pin.** That is its own PR, `agent-messaging` task 0.3.

## Capabilities

### New Capabilities
- `cli-probe`: hypotheses about the headless Claude Code CLI as scenarios with verdicts, isolated live runs, a report and normalized recordings per probed version, checks of every frame against the SDK's declarations, replay of the contract recordings through the bot's session code, and the rule that the repository pins only probed CLI versions.

### Modified Capabilities
<!-- none: the sandbox-image spec keeps "the pinned Claude Code CLI"; which versions may be pinned is the new capability's rule -->

## Impact

- **Rollout: bucket 1, no behaviour change.** The change is tooling, tests, fixtures, one CI step and a check in the image build script.
  - The runtime touches are the command function, which a test pins byte for byte, and `deleteSandbox`, which nothing in the bot calls.
  - No flag. No Slack surface, so no Home tab change.
  - Ledger row: tooling, no runtime effect.
- **Code:**
  - `src/cliprobe/` is new. Nothing outside it imports it (`src/cliprobe/imports.test.ts`).
  - `src/clienv.ts` is new and shared with `src/lab/llm.ts`.
  - `src/claudeSession.ts` gets `claudeLaunch()`.
  - `src/driver.ts`, `src/sshdocker.ts`, `src/daytona.ts` and `src/sandboxopts.ts` get `deleteSandbox` and its guard.
  - `src/cliversion.ts` gets the probed set.
  - `src/fixtures/cli/` holds the reports and recordings.
- **Tooling and config:**
  - `snapshot/build-and-push.sh` gets the pin check.
  - `.github/workflows/ci.yml` gets the declaration check.
  - `.gitleaks.toml` gets an anchored fixtures entry.
  - `package.json` gets the `cli-probe` script and no new dependency.
- **Cost and network.**
  - A live run uses the operator's subscription and reports its cost. The scratchpad's 51 runs came to 1.39 USD API-equivalent: Haiku 5.5 about 0.02 per run, Opus 5.5 about 0.11.
  - The CI check fetches two npm tarballs and caches them.
- **Prerequisite of `agent-messaging`** (its task 0.1). That change promotes the delivery facts it relies on to contract scenarios.
