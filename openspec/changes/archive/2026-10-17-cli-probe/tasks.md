## 1. Shared pieces (no behaviour change)

- [x] 1.1 `claudeLaunch(opts)` in `src/claudeSession.ts` returns the environment prefix, the behaviour variables and the flags, with one `--settings` value. `ClaudeSession.open()` builds its command from it. Verified by `src/claudeSession.test.ts`: it pins today's full spawn command byte for byte, before and after the move, with and without model, MCP config, resume, system prompt and `AVEN_SESSION`
- [x] 1.2 `src/clienv.ts` holds the parent-variable scrub and the isolated environment (configuration directory, token), moved from `src/lab/llm.ts`, which now imports it. Verified by `src/clienv.test.ts`, with `src/lab/llm.test.ts` passing unchanged
- [x] 1.3 `deleteSandbox(name)` on `SandboxDriver`: `docker rm -f` for ssh-docker, the SDK's delete for Daytona. Both first call the pure guard `assertDeletable(name, namePrefix)` in `src/sandboxopts.ts`, which refuses a project-prefixed name. The bot does not call `deleteSandbox`.
  - Verified by `src/sandboxopts.test.ts`, `src/sshdocker.test.ts` (the command, the refusal) and `src/daytona.test.ts` (the refusal before any API call) (scenario "Asked to delete a project's sandbox").
  - The Daytona delete is checked by typecheck here, and live on the first Daytona probe run (`agent-messaging` task 0.2).

## 2. Harness core (`src/cliprobe/`)

- [x] 2.1 The scenario module (`meta`, `run(ctx)`, variants), `ctx.precondition` and `ctx.expect`, and the pure verdict aggregation (flaky, then inconclusive, then holds or fails). Verified by `src/cliprobe/verdict.test.ts` (scenarios "The model does not follow the script", "A predicted event never comes", "Runs disagree", "Not enough conclusive runs")
- [x] 2.2 Installing the CLI into the probe's cache (validated `x.y.z`, `npm install --prefix`, or `--bin`), and the token check before anything starts. The token comes from `CLI_PROBE_TOKEN` only. Verified by `src/cliprobe/install.test.ts`, with a fake exec and an environment that also holds an installation's `CLAUDE_CODE_OAUTH_TOKEN` (scenarios "Version not installed", "No token")
- [x] 2.3 `ctx` over the local transport covers:
  - the isolated environment;
  - `claudeLaunch` with the scenario's extras merged in (hooks inside the one `--settings`);
  - the version check against `system/init`;
  - `send`, `control`, `respond`, `kill`, `restart`, `onCanUseTool` and `onMcpMessage`.

  Verified by `src/cliprobe/ctx.test.ts` against a fake process that plays a script (scenarios "Started from inside a Claude Code session", "The bot's flags change", "The wrong CLI answers")
- [x] 2.4 The sandbox transport through `SandboxDriver` covers:
  - leftover cleanup chosen by the `cli-probe-` name;
  - the probe's own name, plus its label on ssh-docker;
  - the token written as project prep writes it;
  - `cliUpgradeCmd`, then the command with `CLI_PATH_ENV`, then the version check;
  - the driver's session calls;
  - delete in `finally`.

  Verified by `src/cliprobe/sandbox.test.ts` with a fake driver whose listing also holds project sandboxes (scenarios "Run in a sandbox", "The run fails midway", "Leftover from a crashed run")
- [x] 2.5 `npm run cli-probe` (`src/cliprobe/cli.ts`: `run`, `check`, `report`) in `package.json`. Nothing outside `src/cliprobe/` imports the probe, and the probe imports no state, chat, sources or project-configuration module. Verified by `src/cliprobe/imports.test.ts`

## 3. Recordings, report and type checks

- [x] 3.1 The recording writer (frames in both directions; `proc` start and exit lines with the token removed) and the normalizer (pure, design D4). Verified by `src/cliprobe/normalize.test.ts` over a synthetic recording with the shapes the scratchpad files carry, and by `src/cliprobe/ctx.test.ts` for the process boundaries (scenarios "A recording is normalized", "A recording spans a restart"):
  - plain and encoded home paths;
  - a socket path and a `blocked_path`;
  - run, agent and task ids;
  - a thinking signature;
  - rate-limit information
- [x] 3.2 The report: `report.json` (verdicts, runs, observations, cost, event catalogue, findings split by direction, recording hashes) and `REPORT.md` with its "Changed since" section. Verified by `src/cliprobe/report.test.ts`, with a golden `REPORT.md` over two fictional versions (scenarios "A pin bump shows what changed", "Cost")
- [x] 3.3 Choosing the SDK release from the full registry document (`claudeCodeVersion`, else the nearest lower release, else a failure), `npm pack` of it and of the pinned `@anthropic-ai/sdk` into the cache, and both versions recorded for `check`. Verified by `src/cliprobe/sdk.test.ts` with a fake registry (scenario "No release names the version")
- [x] 3.4 The checker on the TypeScript compiler API (design D5):
  - candidates found by their discriminating literals;
  - a structural walk that collects every finding of a frame;
  - the candidate with the fewest violations kept;
  - each finding's origin, protocol or API message model, where only protocol violations fail;
  - input frames listed, never failed.

  Verified by `src/cliprobe/typecheck.test.ts` over a small fictional declaration file, with two members sharing a `type`, a nested union, and a frame with both a missing and two extra fields (scenarios "A field of the wrong type", "Several findings in one frame", "A mismatch in the API message model", "A field the declarations lack", "A kind the declarations lack", "The bot's own message differs from the declaration")
- [x] 3.5 CI changes:
  - `npm run cli-probe -- check` becomes a step of the `verify` job in `.github/workflows/ci.yml`, with an Actions cache per SDK release and no credential;
  - the gitleaks allowlist entry is anchored (`src/fixtures/.*\.json$`), and existing `.jsonl` fixtures that hold deliberate secret shapes are listed by name.

  Verified by the PR's own CI run (scenario "CI on a pull request")

## 4. Scenarios and the first report

- [x] 4.1 The nine contract scenarios of design D7, each settled on CLI 2.1.282 with the local transport: `npm run cli-probe -- run --cli 2.1.282`. The `turn` recording's `system/init` lists no plugin and no skill from outside the run (scenario "The operator's configuration does not leak")
- [x] 4.2 The exploratory set: the scratchpad's scenarios ported, plus the candidates from the declarations (`still_queued`, `cancel_async_message`, `origin`, `compaction`). Run on 2.1.282; their verdicts are in the report and gate nothing
- [x] 4.3 `src/claudeSession.recorded.test.ts` replays every contract recording through `ClaudeSession` (design D6). It reads the fixtures only and imports nothing from `src/cliprobe/` (scenarios "A recorded turn", "A recorded host tool call", "A recorded background report")
- [x] 4.4 The first report, `src/fixtures/cli/2.1.282/`, must be:
  - normalized;
  - read through once by a person;
  - clean under `scripts/public-guard.sh` with the private deny-list, and under gitleaks with the anchored allowlist.

  The PR lists any contract hypothesis that was corrected to what the CLI does (design, Migration Plan) (scenario "Identifiers and secrets in recordings")

  Done 2026-10-17 (#19):
  - Normalized, public-guard and gitleaks clean in CI.
  - Read through by the implementer, with an automated scan for the home path, user and host names, issued ids, wall-clock times and tokens. The scan found a date inside a memory file's text, and the normalizer was fixed for it.
  - The operator merged on that basis, without a separate human read-through.
  - No contract hypothesis needed a correction about the CLI.
- [x] 4.5 `PROBED_CLI_VERSIONS = ['2.1.282']` in `src/cliversion.ts`, plus the gates: reports and hashes, contract coverage, both Dockerfiles' `ARG` and `.env.example`. Verified by `src/cliprobe/gate.test.ts` (scenarios "A pin bump without a report", "A contract scenario fails on a new version", "A recording edited after its report")
- [x] 4.6 `snapshot/build-and-push.sh` refuses a pin outside the set before building. Verified by a `PUSH=0` run with `CLAUDE_CLI_VERSION` set to an unprobed version, which stops and names the probed versions (scenario "An image built with an unprobed pin")
- [x] 4.7 A sandbox-transport run of `turn` and `host-tool` on ssh-docker against the local Docker engine. Its transport section goes in the PR, and no fixtures are kept from it. The driver's listing of the bot's project sandboxes (names and creation times) is identical before and after the run (scenario "Probe beside a running bot")

## 5. Docs and rollout

- [x] 5.1 `docs/cli-probe.md` covers running the probe, writing a scenario, reading a report and the pin-bump procedure (design D9), including when a version may leave the set. The README's Claude Code version section, `docs/housekeeping.md` and CLAUDE.md's architecture pointers link to it. Verified by reading it through, and by the public-guard on the docs
- [x] 5.2 A `docs/rollout.md` ledger row:
  - **What:** the cli-probe harness, the 2.1.282 report and the gates in CI and in the image build; the `claudeLaunch()` and `src/clienv.ts` refactors; `deleteSandbox` with its guard on the drivers (no bot caller).
  - **Gate:** none, bucket 1 (tooling; the spawn command is pinned byte for byte).
  - **Canary:** home turns start as before.

  Verified by the PR's description naming the bucket and the row
