# CLI probe

The bot drives Claude Code over its headless stream-json protocol, and Anthropic publishes no
specification of that protocol (claude-code#102880, "Emit a JSON Schema for the stream-json
protocol", is open). `docs/stream-json-contract.md` describes the shapes the bot uses. The probe is
how those facts are **checked, per CLI version**: each hypothesis about the CLI is a scenario with a
verdict, every probed version leaves normalized recordings and a report in the repository, and CI
makes sure the repository only pins versions whose contract was probed (OpenSpec `cli-probe`).

## What it guarantees

- **Contract scenarios** are what the bot relies on today:
  - `turn`: `system/init` and the `result` fields;
  - `host-tool`: the host-tools round trip over `mcp_message`;
  - `ask-user-question` and `question-withdrawn`: `AskUserQuestion` under bypass, and its withdrawal;
  - `interrupt` and `resume`;
  - `background-report`: the unsolicited result of a background task;
  - `subagent-parent`: `parent_tool_use_id`;
  - `rate-limit-event`;
  - the delivery facts of `agent-messaging`: `fold-in`, `echo-at-take-up`, `echo-carries-uuid`, `interrupt-after-inject`, `kill-resume`, `background-tasks-changed`. Their replay tests run the recordings through the session's message ledger (`ClaudeSession` with `ledger`). With `--replay-user-messages` every message the probe writes carries a fresh `uuid`, as the ledger writes them.

  Every one of them must hold on every version in `PROBED_CLI_VERSIONS` (`src/cliversion.ts`). Each also has a replay test that feeds its recording through `ClaudeSession` (`src/claudeSession.recorded.test.ts`). That test asserts what the bot makes of the frames, and that the frames the bot writes back equal the ones the probe wrote.
- **Exploratory scenarios** record facts without gating anything:
  - priority, parallel tools, subagents, hooks, the race with the final text, a long turn on the fleet's model, background tasks ending mid-turn;
  - `schedule-wakeup`: what a `ScheduleWakeup` looks like in a headless session (its result's fields, whether `background_tasks_changed` lists it, whether it fires as a turn of the CLI's own), which the idle stop (OpenSpec `sandbox-idle-stop`) waits for;
  - candidates from the SDK's declarations (`still_queued`, `cancel_async_message`, `origin`, `/compact`);
  - project skills, as `agent-skills` relies on them: `add-dir-loads-skills` (a skill under an `--add-dir` directory is listed in `init`) and `skill-slash-via-stdin` (`/<skill>` with a multi-line text through stdin runs the skill with all of it; `tags`/`examples` frontmatter keys do not stop it from loading). Contract scenarios, recorded on 2.1.282 and 2.1.292 (both hold), with replay assertions in `src/claudeSession.recorded.test.ts`.
- **Type checks.** Every recorded frame is checked against the type declarations of the Claude Agent SDK release whose `claudeCodeVersion` is the probed CLI version (`sdk.d.ts`, the de facto schema). The declarations are fetched at check time with `npm pack` and never committed: the package is proprietary, and as a dependency it would pull CLI binaries.
- **CI** (`.github/workflows/ci.yml`) needs no model credential, because it never runs the CLI.
  - `npm test` runs the gate (`src/cliprobe/gate.test.ts`). It checks that reports and recordings are intact, that every contract scenario holds, and that the images' `ARG CLAUDE_CLI_VERSION` and `.env.example` are probed versions.
  - `npm test` also runs the replay tests.
  - `npm run cli-probe -- check` re-checks the recordings against the declarations.
- **The image build** (`snapshot/build-and-push.sh`) refuses to bake a version outside the set.

## Running it

```sh
npm run cli-probe -- list                                  # the scenarios, contract first
npm run cli-probe -- run --cli 2.1.282                     # all scenarios against that version
npm run cli-probe -- run turn interrupt --cli 2.1.282      # some; `chain-priority[next]` picks a variant
npm run cli-probe -- run --cli 2.1.282 --out /tmp/try      # anywhere but the fixtures
npm run cli-probe -- check                                 # what CI runs
npm run cli-probe -- report 2.1.282                        # recompute catalogue + findings, render REPORT.md
```

- **Token.** `CLI_PROBE_TOKEN` is a subscription token (`claude setup-token`), and the probe reads no other variable for one. The operator may hand it an installation's token on purpose; the probe never picks one up by itself. Runs count against that subscription's limits.
- **Isolation.** A run uses its own configuration directory and an empty working directory, and drops the parent Claude Code session's variables. A scenario may seed `files` into that working directory before the CLI starts (a project skill, for instance); paths stay inside it. The CLI version is installed into the probe's cache (`~/.cache/coach-aven/cli-probe`, or `CLI_PROBE_CACHE`), never the machine's `claude`. Every `system/init` must report the version the run names.
- **Command line.** The probe starts the CLI with the bot's own command line (`claudeLaunch()` in `src/claudeSession.ts`) plus the scenario's extras: `--replay-user-messages`, hooks in the single `--settings`, partial messages.
- **Cost.** The report shows each scenario's cost and the total, API-equivalent. Haiku 5.5 is the default model, about 0.02 USD a run; the full suite came to about 2 USD on 2.1.282 and 3.60 USD on 2.1.292.
- **`--transport sandbox`.** It runs the CLI in a throwaway sandbox `cli-probe-<run>` through the bot's driver, so stdin goes the bot's way: the ssh-docker FIFO.
  - The driver's settings come from the probe's own environment: `SANDBOX_DRIVER`, `SSHDOCKER_HOST` / `SSHDOCKER_RUNTIME`, `SNAPSHOT_IMAGE`, `SANDBOX_NAME_PREFIX`. `SANDBOX_DRIVER` is required and must be `ssh-docker`: any other value is refused in the bot's words before a sandbox is created.
  - The sandbox is deleted when the run ends. Leftovers are chosen by the `cli-probe-` name, and the driver refuses to delete a project's sandbox. A listing that cannot answer (the host unreachable, its Docker daemon down) stops the run with its error before anything is created.

## Reading a report

`src/fixtures/cli/<version>/REPORT.md`; `report.json` holds the same, plus each recording's hash.

- **Verdicts.**
  - `holds` and `fails` are what the conclusive runs said.
  - `inconclusive`: the model did not follow the script. A missed precondition does not count.
  - `flaky`: conclusive runs disagree. It counts as not holding.

  Timing facts take three conclusive runs.
- **Changed since.** Compared with the newest version already probed: the verdicts, event kinds and fields that changed. A pin bump is reviewed by this section.
- **Type checks.**
  - *Violations* break the protocol's own declarations in a frame the CLI wrote, and fail `check`.
  - *API message model mismatches* are inside the Anthropic API types that the protocol's `message`, `usage` and stream `event` fields import. The CLI's transcript objects are not the API's responses field for field, so these are listed and never failed.
  - *Undeclared fields and kinds* are listed.
  - *Frames the probe wrote* are the bot's own: listed, never failed. The bot's user message has no `parent_tool_use_id`, which the declarations require and the CLI does not.
- **Recordings** are normalized by shape, and public-guard and gitleaks scan them like any tracked file:
  - identifiers become placeholders of the same shape;
  - the machine's paths are scrubbed from every string, in plain and encoded form;
  - signatures, wall-clock times and rate-limit data become fixed values.

## Writing a scenario

A module under `src/cliprobe/scenarios/` exports `meta` and `run(ctx)`, and `scenarios/index.ts` lists it.

- **`meta`** holds:
  - `id` and `hypothesis`, one sentence;
  - `contract`;
  - `runs`: 1 for structural facts, 3 for timing;
  - `model`: `haiku` or `fleet`;
  - `extras`;
  - `variants`.
- **What `run` waits for decides the verdict.**
  - `ctx.precondition(pred, ms, what)` is the model's part of the script. Missed → inconclusive.
  - `ctx.expect(pred, ms, what)` is what the hypothesis predicts. Missed → the run fails.
  - `ctx.require(cond, what)` and `ctx.check(cond, what)` are the same for conditions.
- **Return observations** for the report. They are normalized with the recording.
- **Prompts are synthetic** and leave the model one obvious move. They never ask for a date, host or user name, which the normalizer would have to guess at.
- **A new contract scenario** needs a replay assertion in `src/claudeSession.recorded.test.ts`, and a probe run of every version in the set. The gate fails until both exist.

## Bumping the pin

1. `npm run cli-probe -- run --cli <new>`, with the token in `CLI_PROBE_TOKEN`.
2. Read the new `REPORT.md`, "Changed since" first. Every changed verdict, new kind or new field gets a look. A contract scenario that no longer holds keeps the version out, and that is a finding about the bot or the CLI, not about the probe.
3. Add `<new>` to `PROBED_CLI_VERSIONS`, bump `ARG CLAUDE_CLI_VERSION` in both Dockerfiles and `.env.example`, and open the PR. The gate, the replay tests and `check` run.
4. Build the images (`snapshot/build-and-push.sh`). Then canary: the home installation's `CLAUDE_CLI_VERSION` first, then the others. The upgrade notice ("Claude Code <old> → <new>") shows each one.
5. A version leaves the set, with its fixtures, only once no installation or project pins it. A session on a version outside the set loses what depends on the set (`agent-messaging`'s injection).

## Where things live

- `src/cliprobe/`, which nothing outside imports:
  - `ctx.ts` (a run's view), `runner.ts`, `local.ts` and `sandbox.ts` (transports);
  - `normalize.ts`, `report.ts`, `sdk.ts`, `typecheck.ts`, `gate.ts`;
  - `scenarios/`, `cli.ts`.
- `src/fixtures/cli/<version>/`: the recordings, `report.json` and `REPORT.md`.
- `src/clienv.ts`: the isolated CLI environment, shared with the lab.
- `src/sandboxopts.ts`: `assertDeletable`.
- `scripts/host-tools-smoke.mjs`: a manual smoke inside a project's sandbox. The `host-tool` contract scenario now checks the same round trip on every probed version.
