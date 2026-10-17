## Context

**What the bot relies on.** `ClaudeSession` (`src/claudeSession.ts`) starts the CLI in the sandbox through the driver (`startSessionCommand`, `sendSessionInput`, `streamSessionCommandLogs`). The command is:

```
cd <cwd> && PATH=/root/.local/bin:$PATH CLAUDE_CODE_OAUTH_TOKEN=$(cat /root/.cc-token) <git identity> IS_SANDBOX=1 DISABLE_AUTOUPDATER=1 [AVEN_SESSION=…]
claude --output-format stream-json --input-format stream-json --verbose
       --dangerously-skip-permissions --permission-prompt-tool stdio --strict-mcp-config
       --settings <attribution> [--model] [--mcp-config] [--resume] [--append-system-prompt]
```

Right after the spawn it registers the host MCP servers with `initialize` / `sdkMcpServers`. A person's turn is written as `{type: "user", message: {role, content}}`, with no `parent_tool_use_id`.

The parser reads:
- `system/init`: the session id;
- `assistant`: `tool_use` and `text` blocks, `parent_tool_use_id`, and the `Task` / `Agent` tool names;
- `control_request`: `can_use_tool` for `AskUserQuestion`, and `mcp_message` for host tools;
- `control_cancel_request`;
- `rate_limit_event`: parsed by `src/ratelimit.ts`;
- `result`: the session id, the text, `is_error`, usage and cost, `duration_ms`. A `result` settles the waiting turn, or, when no turn waits, goes to `onIdleResult`.

The unit tests feed hand-written events through a fake sandbox (`src/claudeSession.test.ts`).

**The pin.** Four places set it:
- the `ARG CLAUDE_CLI_VERSION` default in `snapshot/Dockerfile` and `snapshot/plain/Dockerfile`, 2.1.282 today;
- `CLAUDE_CLI_VERSION` in `.env.example`, also 2.1.282;
- `CLAUDE_CLI_VERSION` per installation, in each `.env` in its ops repo. `snapshot/build-and-push.sh` bakes this one (from the environment or `ENV_FILE`) ahead of the `ARG` default;
- `cliVersion` per project.

Warm sandboxes are upgraded in place at chat prep (`src/cliversion.ts`), which also warns when the pin falls behind npm `stable`. Nothing checks what a new version does.

**The scratchpad harness.** `probe.mjs` and 14 scenarios, run on CLI 2.1.282 and 2.1.302, mostly with Haiku 5.5 and three runs with Opus 5.5. Its output was descriptive: a person judged it.
- It ran with the operator's own Claude Code configuration. User settings changed the permission behaviour, and the operator's plugins and skills appeared in `system/init`.
- Its recordings carry machine paths, run and task identifiers (a run id encodes its start time) and thinking signatures. The private deny-list matches most of those files, one of them inside a random signature.

**The declarations.**
- `sdk.d.ts` of `@anthropic-ai/claude-agent-sdk` declares:
  - what the CLI writes: the `SDKMessage` union and the control frames, gathered in `StdoutMessage`, which is declared but not exported;
  - what a host writes: `SDKUserMessage`, which requires `parent_tool_use_id: string | null`, and the control requests.
- Each release's manifest names the CLI release it matches (`"claudeCodeVersion": "2.1.302"` in 0.3.302). The full npm registry document carries the field; the abbreviated one does not.
- The package is proprietary ("All rights reserved"). Its optional dependencies are the CLI's platform binaries.

**Prior art in the repo.** `src/lab/llm.ts` already runs the CLI isolated: a `CLAUDE_CONFIG_DIR` of its own, a subscription token, and the parent session's variables stripped (`PARENT_VARS`).

**CI.**
- The `verify` job runs typecheck, tests, public-guard and gitleaks.
- It holds no model credential, and pull requests from forks run without secrets.
- The gitleaks allowlist entry `src/fixtures/.*\.json` is unanchored, so it also skips `.jsonl` files.

**The driver.** `SandboxDriver` can create, wake and peek at a sandbox (`ensureSandbox`, `getSandbox`, `listStates`), but it cannot delete one.
- ssh-docker labels its containers `managedBy=<SANDBOX_MANAGED_BY>`, and its `listStates()` filters on that label.
- Daytona's `listStates()` returns every sandbox of the organization.
- `/aven status` looks each project's sandbox up by name: `<namePrefix><slug>`.

## Goals / Non-Goals

**Goals:**
- One place where every CLI fact the bot relies on is stated, judged and recorded, per CLI version.
- A change to the repository's pin that breaks a relied-on fact fails in CI. An image cannot be built with an unprobed pin.
- The bot's parser is tested on real CLI output, not on events written by hand.
- Cheap enough to run on every bump.

**Non-Goals:**
- A complete protocol specification. The SDK's declarations stay the schema; the probe judges what the bot needs and what a design needs to know.
- Enforcing the pins that live outside this repository (installations' `.env`, `cliVersion`) at runtime. The procedure (D9) covers them, and `agent-messaging` is the first runtime reader of the probed set.
- Latency or load benchmarks, or judging model quality.

## Decisions

### D1. A scenario is a hypothesis, a script and a judge
A scenario module exports `meta`:
- `id` and `hypothesis`, one sentence;
- `contract`: true when the bot relies on it;
- `runs`: the conclusive runs that settle it, 1 for structural facts, 3 for timing;
- `model`: `haiku` by default, or `fleet` for Opus 5.5;
- `extras`: flags and settings to merge into the bot's command;
- `variants`, optional: for example the four priorities. Each variant is its own row in the report.

It also exports `run(ctx)`, which returns `{verdict, observations, reason?}`.

A scenario waits in two ways, and the difference decides the verdict:
- `ctx.precondition(pred, ms)`: the model made the scripted call. A timeout makes the run `inconclusive`.
- `ctx.expect(pred, ms)`: what the hypothesis predicts. A timeout makes the run fail.

The aggregation is pure (`src/cliprobe/verdict.ts`). For each version, in this order:
1. conclusive runs that disagree → `flaky`;
2. fewer conclusive runs than `runs` → `inconclusive`;
3. otherwise `holds` or `fails`.

`ctx` keeps the scratchpad's API: `send(text, {priority, uuid, origin})`, `control`, `respond`, `onCanUseTool`, `onMcpMessage`, `waitResults`, `sleep`, `kill`, `restart({resume})`, the `is.*` predicates, and the collected `events`, `results` and `replays`. The plain `waitFor` is replaced by `precondition` and `expect`.

Why: a gate needs verdicts. A model that skips the scripted call must not read as a CLI change, and a CLI that never sends the predicted `result` must not read as a lazy model.

Alternatives:
- Assertions on exact event sequences break on every variation in the model's text or step count.
- One run per fact is not enough: the timing facts need repeats.

### D2. Isolated runs, with the bot's own command line
- **CLI.** `npm install --prefix <cache>/cli/<v> @anthropic-ai/claude-code@<v>`, with the version validated by `isValidCliVersion`. Alternatively `--bin <path>`. The cache is `~/.cache/coach-aven/cli-probe/`. The machine's own `claude` is never used.
- **Environment.** `src/clienv.ts` is the lab's scrub moved to a shared module; `src/lab/llm.ts` imports it. It removes `PARENT_VARS` and sets:
  - `CLAUDE_CONFIG_DIR` to a new temporary directory per run;
  - `CLAUDE_CODE_OAUTH_TOKEN` from `CLI_PROBE_TOKEN`, and from nothing else. A probe never reads an installation's `.env`. The operator creates the token with `claude setup-token`.
- **Command line.** `claudeLaunch(opts)` is a pure function in `src/claudeSession.ts` that returns three parts:
  - the environment prefix: `CLI_PATH_ENV` and the token variable, which the sandbox transport uses;
  - the behaviour variables: `IS_SANDBOX=1`, `DISABLE_AUTOUPDATER=1`;
  - the flags, with one `--settings` value.

  `ClaudeSession.open()` builds its command from it, and a test pins today's command byte for byte. The probe merges the scenario's extras into those parts. Hook definitions join the attribution settings in the single `--settings` JSON. Flags such as `--replay-user-messages`, `--include-hook-events`, `--include-partial-messages` and `--resume` are appended.
- **Version check.** The first `system/init` must report the version the run names (`claude_code_version`). A mismatch ends the run as an error. This catches a `--bin` pointing elsewhere, and a sandbox where the image's CLI ran instead of the upgraded one.
- **Working directory.** A new, empty temporary directory per run.

Why: a run must equal a fresh sandbox, not the operator's laptop, and its recordings must be publishable. The probe's command cannot drift from the bot's, and the report's version is the one that ran.

### D3. Two transports, one `ctx`
- **`local`, the default.** `child_process.spawn`.
- **`sandbox`.** The bot's `SandboxDriver`, chosen from the probe's environment (`SANDBOX_DRIVER`, `SSHDOCKER_HOST`, the Daytona settings). The run:
  1. deletes leftover sandboxes whose names start with `cli-probe-`, chosen by name from `listStates()`. On Daytona that listing holds every sandbox of the organization, so the name is the only safe key;
  2. creates `cli-probe-<run id>`. On ssh-docker it also sets `managedBy=cli-probe` through `SANDBOX_MANAGED_BY` in the probe's own process, so the bot's container listing never shows it;
  3. writes the token as project prep does (`/root/.cc-token`);
  4. installs the version with `cliUpgradeCmd(<v>)`, the bot's own upgrade step;
  5. starts the command `claudeLaunch` builds, with `CLI_PATH_ENV`, so the upgraded CLI runs, and checks the version (D2);
  6. talks to the CLI through `startSessionCommand`, `sendSessionInput` and `streamSessionCommandLogs`;
  7. deletes the sandbox in `finally`.

**Deleting** needs a new `deleteSandbox(name)` on `SandboxDriver`: `docker rm -f` for ssh-docker, the SDK's delete for Daytona.
- Both implementations first call a shared pure guard, `assertDeletable(name, namePrefix)`, which refuses any name that carries the project prefix. Code never deletes a project's sandbox.
- The probe calls `deleteSandbox` only for `cli-probe-` names. The bot does not call it at all.

Why: the bot never runs the CLI locally. The stdin path differs per driver (the ssh-docker FIFO, the Daytona session input), and `agent-messaging` has to measure it (its task 0.2).

### D4. Recordings and the report, per version
**Layout.** `src/fixtures/cli/<version>/` holds `report.json`, the rendered `REPORT.md`, and `<scenario>[.<variant>].jsonl`.

**Recordings.** One line per record. `t` is in milliseconds since the start of the run.
- **Frames:** `{t, dir: "out" | "in", frame}`.
- **Process boundaries:**
  - a start: `{t, proc: "start", argv}`, with the token variable removed;
  - an exit: `{t, proc: "exit", code | signal}`.

One recording per scenario: the first conclusive run. The other runs are summarized in the report.

**Normalization** (pure, `src/cliprobe/normalize.ts`). Like the twin fixtures, it scrubs by shape, and every field keeps its type, because the type checks run on the normalized files. In this order:
1. **Known identifier fields**, replaced by placeholders numbered by first appearance, of the same shape:
   - UUIDs become `00000000-0000-4000-8000-00000000000N`;
   - `toolu_…`, `msg_…` and `req_…` become `toolu_probe_N`, `msg_probe_N` and `req_probe_N`;
   - `run_id` gets a placeholder whose time part is zero;
   - `agent_id`, `task_id`, `parent_task_id` and shell task ids keep their length and alphabet.
2. **Opaque blobs.** Thinking `signature` values become a fixed string. Random base64 can match the deny-list by chance, so no signature is ever committed.
3. **Times and account data.** Wall-clock fields (`timestamp`, `resetsAt`) and the whole `rate_limit_info` become fixed values with their types kept.
4. **Every string, at any depth,** has every form of the run's paths replaced:
   - the paths themselves: the work directory, the configuration directory, the cache, the home directory, `/run/user/<uid>`;
   - their encoded forms, with `/` turned into `-`, as the CLI names project folders.

   They become `/probe/work`, `/probe/config`, `/probe/cache`, `/probe/home`, `/probe/run` and the matching encoded forms. This covers `memory_paths`, `output_file`, `messaging_socket_path`, `blocked_path`, tool results and text.
5. **`stream_event` deltas** collapse to one per content block, unless the scenario keeps them (`meta.keepPartials`).

Recordings are tracked files, so public-guard scans them. The gitleaks allowlist entry becomes `src/fixtures/.*\.json$`, so `.jsonl` recordings are scanned too. Existing `.jsonl` fixtures that hold deliberate secret shapes are listed by name.

**Size.** About 500 KB per version. A version leaves the repository when it leaves the probed set.

**`REPORT.md`** contains:
- a header: CLI, SDK release, models, transport, date, total cost;
- one row per scenario: contract, hypothesis, verdict, runs (holds / fails / inconclusive), key observations, cost;
- the event catalogue: kind → count and fields;
- the type-check findings, split into frames the CLI wrote and frames the probe wrote;
- **"Changed since <version>"**: compared with the newest version already in the probed set, the verdicts, kinds and fields that differ. A pin bump's report adds a new file, so a diff of `REPORT.md` alone would show nothing; this section is what the reviewer reads.

`report.json` carries the same data plus each recording's SHA-256.

Why committed: the facts become text a reviewer reads, and the recordings are the input of the replay tests (D6).

### D5. Checks against the SDK's declarations, fetched, not vendored
**Release.** The full npm registry document of `@anthropic-ai/claude-agent-sdk` carries every release's manifest, including `claudeCodeVersion`. The abbreviated document does not, so the probe asks for the full one.
- The probe takes the release whose `claudeCodeVersion` equals the CLI version, else the nearest lower one. With no release at or below, the check fails and says so.
- For the message-content types it imports, the probe uses the newest `@anthropic-ai/sdk` in the release's peer range at the time the report is written.
- The report names both versions, and `check` reuses them, so a check never changes with a new upstream release.

**Fetch.** `npm pack` of both into `<cache>/sdk/<release>/`: the tarball alone, with no install and no optional platform binaries.
- The other imports (`@modelcontextprotocol/sdk`, `zod`) stay unresolved and read as `any`, which is silent under `skipLibCheck`. They type MCP servers and schemas, and the `mcp_message` payload, which `host-tools` already tests.
- `@types/node`, already a devDependency, is part of the checker's program, because `UUID` comes from `crypto`.

**Neither vendored nor a dependency.** The package is proprietary, so its declarations stay out of this Apache-2.0 repository. As a dependency it would pull the CLI's platform binary into every `npm ci`.

**Checker** (`src/cliprobe/typecheck.ts`, the TypeScript compiler API; `typescript` is already a devDependency). It does not let the compiler judge an object literal: assignability stops at the first excess property and would hide a missing one behind an extra one. Instead it walks the frame against the declared type and collects every finding:
1. **Candidates.** It reads `StdoutMessage` through the AST of the cached file, and indexes the union's members by their discriminating literals: `type`, `subtype` where declared, and `isReplay` for the two `user` kinds. The candidates for a frame are the members whose literals the frame matches. With none, the frame is an **undeclared kind**.
2. **Walk.** For each candidate it walks the frame:
   - every required property is present, else a **violation** at its path;
   - every present property is declared, else an **undeclared field** at its path, and the walk goes on;
   - every value is allowed by its declared type: primitives and literals through `checker.isTypeAssignableTo` against the value's literal type; objects, arrays, records and unions by recursion, where a union takes the member with the fewest violations. A value that no type allows is a **violation** at its path.
3. **Choice.** The frame keeps the candidate with the fewest violations, and all its findings are reported.

`in` frames are walked against `SDKUserMessage` and the control request and response types, and their findings are listed, never failed. The bot's own user message lacks `parent_tool_use_id`, which the declaration requires, and the CLI accepts it. The report shows the gap for a later decision about the bot.

**When it runs.** At the end of every live run, and in CI as `npm run cli-probe -- check`. The CI step re-checks the committed recordings of every version, with an Actions cache keyed by release.

Alternatives:
- JSON Schema generated from the declarations (`ts-json-schema-generator` + ajv): two new dependencies, and the generator does not handle the zod and conditional types in this file.
- Assigning each frame to the union as an object literal and reading the diagnostics: one finding per frame at best, and violations hidden behind extras.
- Hand-written schemas for the frames the bot reads: they duplicate the declarations and drift from them.
- No check at all: that is the gap claude-code#102880 describes.

### D6. Contract recordings replay through `ClaudeSession`
`src/claudeSession.recorded.test.ts` runs offline, inside `npm test`.
- It reads the fixtures only: every version listed in `PROBED_CLI_VERSIONS`, and each `report.json`'s list of contract scenarios with their recordings. It imports nothing from `src/cliprobe/`.
- It feeds the `out` frames through the existing fake sandbox. At a `proc` exit it opens a new session for the following frames, with `resumeSessionId` taken from the following `start` arguments.

It asserts the bot's behaviour:

| Scenario | The session… |
|---|---|
| `turn` | settles one turn with the recorded text, cost and session id |
| `host-tool` | answers the `mcp_message` handshake and the tool call through a fake host server of the probe's tool name; the turn settles with the tool's output in its text |
| `ask-user-question` | calls `onQuestion` and writes an allow with the answers |
| `question-withdrawn` | aborts the open question on `control_cancel_request` |
| `interrupt` | settles the turn `canceled` |
| `resume` | follows the session id of the last `result`, across the restart |
| `background-report` | calls `onIdleResult` with the text and settles no turn |
| `subagent-parent` | labels the subagent's steps `↳1` |
| `rate-limit-event` | passes a parsed `RateLimitInfo` to `onRateLimit` |

Why: the parser is what depends on the protocol. With replay, a pin bump tests the parser too, not just the CLI.

### D7. The scenario set at the start
**Contract**: the facts the bot relies on today.

| id | Hypothesis | Runs |
|---|---|---|
| `turn` | `system/init` comes first, with `session_id`, and with no plugin or skill from outside the run. `assistant` events carry `text` and `tool_use` blocks. Each turn ends with one `result` carrying `result`, `is_error`, `session_id`, `total_cost_usd`, `usage` and `duration_ms` | 1 |
| `host-tool` | After `initialize` with `sdkMcpServers`, the MCP handshake and the model's call come as `control_request {mcp_message}`, and the host's `control_response` reaches the model as the tool result | 1 |
| `ask-user-question` | With bypass and `--permission-prompt-tool stdio`, Bash runs with no round trip, `AskUserQuestion` sends `can_use_tool`, and the answers in `updatedInput` reach the model | 1 |
| `question-withdrawn` | An interrupt while a `can_use_tool` is open sends `control_cancel_request` for that request id | 1 |
| `interrupt` | `control_request {interrupt}` during a tool produces a `result` within 10 s (`CANCEL_GRACE_MS`), and the process takes the next message | 3 |
| `resume` | After the process exits, `--resume` with the last `result`'s session id continues the conversation | 1 |
| `background-report` | A background Bash task that outlives its turn produces an unsolicited turn with its own `result` | 3 |
| `subagent-parent` | A subagent's events carry `parent_tool_use_id` equal to the id of the `Task` / `Agent` call that started it | 1 |
| `rate-limit-event` | `rate_limit_event` carries the fields `src/ratelimit.ts` reads | 1 |

**Exploratory.**
- **The scratchpad set, ported:**
  - `chain-priority`, with the variants none / `next` / `later` / `now`;
  - `long-tool`, `two-injects`, `during-final-text`, `parallel-tools`;
  - `subagent-sync`, `subagent-background`, `pending-permission`;
  - `interrupt-after-inject`, `kill-resume`, `background-tasks-changed`;
  - `event-kinds`, with the variants base / hooks + partial messages.
- **Candidates from the declarations, not observed yet:**
  - `interrupt` with `cancel_queued`, and the receipt's `still_queued` (`interrupt_receipt_v1`);
  - `cancel_async_message` before take-up;
  - `origin` kinds on a user message;
  - `compaction`: whether `/compact` works over stream-json input, and which session id comes after it.

`agent-messaging` promotes the facts its delivery relies on to contract scenarios, with frame-level judges, in its own task 0.2: fold-in at the tool boundary, echo at take-up, interrupt keeps the message, kill before take-up loses it, `background_tasks_changed`. Their replay tests come with its `ClaudeSession` ledger, which is what reads the echoes.

### D8. The probed set and the gates
`PROBED_CLI_VERSIONS` is an exported array in `src/cliversion.ts`, beside the pin helpers.

`src/cliprobe/gate.test.ts` runs offline, inside `npm test`, and checks:
1. Every version in the set has a `report.json` where every contract scenario holds, and every recording's hash matches.
2. Every contract scenario in `src/cliprobe/scenarios/` has a verdict in the report of every version in the set. A new contract scenario therefore means probing the set again; that is the point.
3. The `ARG CLAUDE_CLI_VERSION` default of both Dockerfiles, and `CLAUDE_CLI_VERSION` in `.env.example`, are in the set.

**`snapshot/build-and-push.sh`** resolves the pin it would bake, from the environment, `ENV_FILE` or the `ARG` default. It refuses a pin outside the set before building, reading the set with `node --import tsx`. This covers the pin an installation passes in.

**The CI step** `npm run cli-probe -- check` fails on any violation in a frame the CLI wrote.

**Leaving the set.** An installation's `.env` and a project's `cliVersion` live in ops repos this repository cannot see. A version therefore leaves the set only when the operator has checked that no installation or project still pins it. Once `agent-messaging` reads the set at runtime, a session on a version outside the set gets no injection, and logs `ask.inject.disabled` loudly.

### D9. Live runs are the operator's step
**Commands:**
- `npm run cli-probe -- run [scenario…] --cli <v> [--transport local|sandbox] [--runs N] [--model M]`;
- `npm run cli-probe -- check [version…]`;
- `npm run cli-probe -- report <v>`, which renders `REPORT.md` again.

**Cost.** Taken from each run's last `result.total_cost_usd`. The scratchpad's 51 runs cost 1.39 USD API-equivalent: Haiku 5.5 about 0.02 per run, Opus 5.5 about 0.11. A full suite of about 50 runs should land in the same range.

**Pin-bump procedure** (`docs/cli-probe.md` and the README's Claude Code version section):
1. `npm run cli-probe -- run --cli <new>`.
2. Read the new report's "Changed since" section. Look into every changed verdict, new kind and new field.
3. Add `<new>` to `PROBED_CLI_VERSIONS`, bump both Dockerfiles' `ARG` and `.env.example`, and open the PR. The gates run.
4. Canary: the home installation's `CLAUDE_CLI_VERSION` first, then the others, as today. The upgrade notice ("Claude Code <old> → <new>") shows each one.
5. Drop the old version from the set, with its fixtures, only after checking that no installation or project pins it.

**Where it can grow:**
- A scheduled live run against npm `stable`, from an installation's private ops repo where a credential can live. It would open an issue on a changed verdict before the drift check asks for a bump.
- A runtime warning for an installation pin outside the set.
- The evaluation of the Agent SDK as the driver (`spawnClaudeCodeProcess`).

## Risks / Trade-offs

- **[The model varies, not the CLI]** → Scripted prompts leave one obvious move. A missing precondition reads as `inconclusive`, never as a verdict, and timing facts take 3 runs.
- **[A timing fact holds by luck]** → The report records the measured delays, so a reviewer sees the margins. `agent-messaging` confirms delivery by the echo at runtime, never by timing.
- **[Haiku is not the fleet's model]** → The scratchpad's three Opus runs matched the Haiku rows, which is thin evidence. Scenarios where the model may matter run on `fleet`.
- **[The declarations lag the CLI, or no release matches]** → The nearest lower release is used and named. Undeclared kinds and fields are listed, not failed.
- **[The checker misreads a member]** → Its tests run over a small fictional declaration file. That file includes two members sharing a `type`, a nested union, and a frame with both a missing and an extra field.
- **[Recordings leak something]** → Normalization by shape, with paths scrubbed from every string and signatures dropped. Public-guard and gitleaks scan the recordings in CI, and a person reads them in the PR, as with the twin fixtures.
- **[A delete hits the wrong sandbox]** → Leftovers are chosen by the `cli-probe-` name, never by a listing that may hold the whole organization. Both drivers refuse a project-prefixed name, and the probe never deletes anything else.
- **[The CI check depends on the npm registry]** → The fetch is cached per release, and the offline gates in `npm test` do not need the registry.
- **[Pins outside the repository]** → Covered by procedure, by the build script and, once `agent-messaging` lands, by the per-session check. They are not checked by CI.

## Migration Plan

- No runtime change. The PR merges like any tooling change. It records the first report, for 2.1.282 (the images' and `.env.example`'s pin), so the gates pass at merge.
- **A contract scenario that fails on 2.1.282 is a finding about the bot, not about the probe.** The bot relies on something the CLI does not do. The hypothesis is corrected to what the CLI does, and the bot's handling is checked against it, with an issue when it needs a fix, before the scenario is marked contract. The PR lists every such correction.
- Rollback: revert. Nothing at runtime reads the probed set until `agent-messaging`.

## Open Questions

- Whether `/compact` works over stream-json input. The exploratory `compaction` scenario answers it. If it does not, compaction stays unprobed, because automatic compaction needs a large context to trigger.
