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

Interrupt (clean cancel — NEVER kill the process; killing corrupts the conversation and
zombies the Daytona command):
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

Parsing notes: stdout arrives in arbitrary chunks (not lines) — buffer and split on `\n`,
keep the partial tail. Wrap `JSON.parse` in try/catch and skip non-JSON lines (the CLI
interleaves noise). Read `session_id` from both `system/init` and `result`.

## Daytona transport mapping

- stdin write  → `sandbox.process.sendSessionCommandInput(sessionId, cmdId, line)`
- stdout stream → `sandbox.process.getSessionCommandLogs(sessionId, cmdId, onStdout, onStderr)`
- start         → `sandbox.process.executeSessionCommand(sessionId, {command, runAsync:true})`
