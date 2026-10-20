# Claude Code bidirectional stream-json wire contract

There is **no complete official documentation** for the raw `claude` CLI stream-json wire
protocol. The public docs cover the Agent SDK abstraction (`canUseTool` callback) and the
headless output format, but **not** the exact stdin `control_request`/`control_response`
shapes or the `AskUserQuestion` answer format. The sources of truth are:

1. The Claude Agent SDK source (`query.ts` in slopus/happy-cli is a vendored copy of it), and its
   type declarations (`sdk.d.ts` of `@anthropic-ai/claude-agent-sdk`, the de facto schema).
2. **Empirical testing** against the live CLI — which is how the shapes below were verified
   (in a Daytona sandbox, June 2026, claude-code 2.1.x).
3. **The CLI probe** (`docs/cli-probe.md`): what the bot relies on, as contract scenarios checked per
   CLI version — `src/fixtures/cli/<version>/REPORT.md` is the measured state of a pinned version.

This is what our orchestrator (`orchestrator/src/claudeSession.ts`) relies on.

## Launch

```
claude --output-format stream-json --input-format stream-json --verbose \
       --dangerously-skip-permissions --permission-prompt-tool stdio \
       --strict-mcp-config [--resume <id>] [--append-system-prompt <text>]
```

- No positional prompt ⇒ **persistent mode**: turns stream in via stdin, the process stays
  alive across turns (one `result` per turn). `--verbose` is **mandatory** with stream-json.
- **`--dangerously-skip-permissions` + `--permission-prompt-tool stdio` coexist** (verified):
  normal tools (Read/Edit/Bash) auto-run with no round-trip, but **`AskUserQuestion` still
  fires a `can_use_tool` control_request** we can answer. `system/init` reports
  `permissionMode=bypassPermissions`.
- `--strict-mcp-config` ignores the cloned repo's own `.mcp.json` (e.g. a `browsermcp`
  server that can't start headless and would hang the run).

## stdin (us → claude)

User turn (one compact JSON object per line, trailing `\n` is the frame delimiter):
```json
{"type":"user","message":{"role":"user","content":"<text>"}}
```

Interrupt (clean cancel — NEVER kill the process: killing corrupts the conversation):
```json
{"request_id":"<rand>","type":"control_request","request":{"subtype":"interrupt"}}
```

Permission / question answer (reply to a `can_use_tool` request, same id):
```json
{"type":"control_response","response":{"subtype":"success","request_id":"<id>",
 "response":{"behavior":"allow","updatedInput":<input>}}}
```
- Deny: `"response":{"behavior":"deny","message":"<why>"}`.
- **AskUserQuestion answer**: `behavior:"allow"` with `updatedInput = {...input, "answers": {...}}`
  where `answers` is keyed by **question TEXT** → chosen **label** (multi-select: labels
  comma-joined). Verified: answering `{"<question text>":"TypeScript"}` made the model say
  "You picked TypeScript." Allowing **without** `answers` ⇒ the model treats it as dismissed.

## stdout (claude → us), NDJSON — demux by `type`

- `{"type":"system","subtype":"init", "session_id", "permissionMode", "tools", ...}` — start;
  also re-emitted on `/compact` fork (new `session_id`).
- `{"type":"assistant","message":{"content":[{"type":"text"|"tool_use", ...}]}}` — `tool_use`
  blocks drive the live "steps" UI.
- `{"type":"control_request","request_id","request":{"subtype":"can_use_tool",
   "tool_name","input"}}` — for `AskUserQuestion`, `input = {questions:[{question, header,
   multiSelect, options:[{label, description}]}]}`.
- `{"type":"result","subtype":"success"|...,"is_error","result","session_id","usage",
   "total_cost_usd", ...}` — **turn-complete marker**. The process stays alive for the next turn.
   `usage` is this turn's tokens; `total_cost_usd` is the PROCESS's running total (every turn
   reports all spent so far) — `claudeSession.ts` `CostDelta` turns it into the per-turn cost
   the metering records carry.
- `{"type":"rate_limit_event","rate_limit_info":{"status":"allowed"|"allowed_warning"|"rejected",
   "rateLimitType":"five_hour"|"seven_day","resetsAt":<unix s>,"unifiedWindows":{"five_hour":{"utilization",
   "resetsAt"},"seven_day":{…}}}}` — **subscription quota state**, emitted once per turn (on 2.1.282
   after `system/init` and the first assistant message — the probe's recordings; the parser does not
   depend on the order). `unifiedWindows` is undeclared in the SDK types; `unifiedWindows` (utilization 0–1) appears
   from CLI ≈2.1.2xx (2.1.183 sends status + reset only). Parsed by `src/ratelimit.ts` →
   alert channel on warning/rejected transitions, `/aven status` quota line.

**Queued messages** (measured per CLI version by the CLI probe, `docs/cli-probe.md`): a user message written while a
turn runs is queued.
- **No priority / `next`:** it is folded into the running turn at the next tool boundary.
- **Echo:** with `--replay-user-messages` it is echoed when the CLI takes it up, after that tool's result, not when it is written.
- **Last tool result:** a message written after it gets its own turn after the running one.
- **Interrupt:** a message still queued at an interrupt is kept and runs as its own turn.
- **Kill:** a message written but not yet taken up is lost when the process is killed.
- **Background tasks:** the CLI reports one that ends mid-turn the same way, as a queued user message (`origin: {"kind": "task-notification"}`).

**Subagents:** a subagent's frames carry `parent_tool_use_id` = the id of the `Agent` / `Task` call that started it. The bot labels its steps `↳1`, `↳2`, … while the parent turn runs.
- **Default.** An `Agent` call without `run_in_background` runs in the background (since 2.1.198). The parent turn then ends at once ("still running"). The subagent's frames come after that `result`, and its report arrives as an unsolicited turn (`🔔 Background update`).
- **2.1.282:** in the probe the model passed `run_in_background: false`.
- **2.1.292:** the model left the flag out, and the subagent ran in the background. The frames also carry `agent_id` (the task id).
- **What a person sees.** On 2.1.292, expect more subagent work to report as a background update, after the turn's answer, than as `↳` steps inside it. The probe's `subagent-parent` asks for the foreground explicitly, so its recordings compare like for like.

Parsing notes: stdout arrives in arbitrary chunks (not lines) — buffer and split on `\n`,
keep the partial tail. Wrap `JSON.parse` in try/catch and skip non-JSON lines (the CLI
interleaves noise). Read `session_id` from both `system/init` and `result`.

## Transport: the driver contract and the ssh-docker mapping

The bot never holds the CLI's pipes itself: the process runs in a session of the sandbox driver
(`src/driver.ts`; the contract in `docs/sandbox-drivers.md` → *Adding a driver*), which outlives
a bot restart. How ssh-docker (`src/sshdocker.ts`) maps it, under `/tmp/aven-sess/<key>/` in the
project's container:

- start → `startSessionCommand(key, command)`: a FIFO `in` as the CLI's stdin, held open by a
  background writer so the CLI never sees EOF between turns; stdout and stderr to `out.log`; the
  pid is the command id.
- stdin write → `sendSessionInput(key, cmdId, line)`: `docker exec -i <container> sh -c 'cat > …/in'`
  with the frame on stdin. The FIFO adds no copy of what is written to the output; on any
  transport, only the CLI's own `isReplay` echo (`--replay-user-messages`) confirms delivery.
- stdout stream → `streamSessionCommandLogs(key, cmdId, onStdout)`: `tail -c +1 -f out.log` until
  the pid dies. Every (re)subscribe replays the whole log from the start; `ClaudeSession` skips
  the prefix it already consumed.
- reattach snapshot → `sessionCommandLogs(key, cmdId)`: `cat out.log`.
- running? → `sessionCommandRunning(key, cmdId)`: the pid is alive, not a zombie, and its stdin
  is this session's FIFO.
