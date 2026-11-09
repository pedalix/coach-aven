# Design

## Context

- `ProjectConfig.env` exists in the type and in the example config as `{}`; nothing reads it (`src/projects.ts`).
- The pattern to follow is the gateway token (`seedGatewayAuth`, `src/project.ts`): every turn, under the sandbox
  lock, the bot uploads a file into `/root/.aven/`-style private paths with `chmod 600`, so a warm sandbox always
  holds a current credential and the long-lived secret stays on the bot host.
- MCP entries already resolve `${VAR}` from the bot's environment (`resolveEnvRefs`, `src/mcp.ts`), with an unknown
  ref becoming `''` — resolved at materialization, not at load.
- The `claude` launch line is built in `src/claudeSession.ts` (`command(cwd)`): a shell line run through the sandbox
  driver, with its environment as inline `NAME=value` assignments. Anything put there is visible in the process list
  of the sandbox and in the `docker exec` / SSH command line on the host.
- Chat output goes through the `ChatDriver` (`post` / `update` with view models) from `src/turn.ts`, for every
  platform; the input side has `scrubText` before text reaches the model (`ClaudeSession`), the output side has no
  redaction today.
- Since `agent-actions-read` the agent can already read CI runs and logs (`gh run view --log-failed`); this change is
  for running the same checks in the sandbox, e.g. against a preview before pushing again.

## Goals / Non-Goals

**Goals:**
- An operator can give one project's sandbox a handful of named values with two edits (`.env`, the project's `env`)
  and a restart, and take them away the same way.
- The values never pass through a command line, a bot log line, a config error or a chat message.
- Zero change for projects without `env` — provably, by test.

**Non-Goals:**
- A secret store, per-repo or per-user scoping, rotation automation, or audit of who read a value.
- Making the agent unable to see or misuse the values; `env` is for values the agent is meant to use.

## Decisions

### D1 — Resolve at load, fail on an unknown ref

`loadProjects` resolves every `env` value against the environment it is given (tests inject one, as they do for the
gateway client check) and stores the resolved map on the project; nothing resolves later. An unknown ref throws the
usual `<path>: project "<slug>" …` error naming the key and the variable.

*Why not the MCP rule (unknown → `''`)?* An empty bypass secret is a silent failure: the suite "skips protected
previews" and reports green. Load time is where the operator is looking (boot log, `/aven reload` reply).

*Why not resolve per turn?* The bot's environment only changes at restart, so per-turn resolution buys nothing and
would move the error from the operator's reload to some user's turn.

### D2 — A deny-list of names the bot owns

Refused: `PATH`, `HOME`, `IS_SANDBOX`, `DISABLE_AUTOUPDATER`, `AVEN_SESSION`, `GH_TOKEN`, `GITHUB_TOKEN`,
`GIT_AUTHOR_*`, `GIT_COMMITTER_*`, `CLAUDE_*`, `ANTHROPIC_*`. The list lives beside the launch-line builder's own
names (one constant, tested against `claudeLaunch`'s env so a new bot variable cannot slip past). A key must match
`^[A-Z_][A-Z0-9_]*$`, which also keeps the env-file text trivially safe on the name side.

*Alternative:* let project values win (or lose) silently. Rejected: either way someone debugs a sandbox whose identity
or credit is not what the config says.

### D3 — A private file in the sandbox, read by the launch line

`seedProjectEnv(sandbox, values)` runs every turn right after `seedGatewayAuth`, inside the same sandbox lock: one
`uploadFile` of `/root/.aven/env` (`export NAME='value'` lines, single-quote escaped by the pure
`envFileText`), one `exec` for `mkdir -p` + `chmod 700` dir / `600` file. The launch line, only when the project has
values, starts with `set -a; . /root/.aven/env; set +a;` so the `claude` process — and every tool it spawns — inherits
them. The file is uploaded, never echoed or passed as arguments, so no command line carries a value.

*Alternatives:*
- Inline `NAME=value` on the launch line, like `AVEN_SESSION`. Rejected: values in `ps` inside the sandbox and in the
  host's `docker exec` / SSH command line.
- `docker run -e` at container creation. Rejected: needs a container recreate per change, and the values stay in
  `docker inspect` on the host.
- An MCP tool on the gateway that hands out values. Rejected: the test runners read environment variables; the agent
  would have to copy them into the shell anyway.

### D4 — Redact chat output with a driver wrapper per turn

`redactValues(text, entries)` (pure, in `src/projectenv.ts`) replaces each value of at least 8 characters, longest
first, with `[redacted:<KEY>]`. `src/turn.ts` wraps the `ChatDriver` for a turn of a project with values in a thin
decorator that applies it to every text field of the view models it posts or updates; a project without values gets
the driver itself (no wrapper), which is what keeps D6's pinned shape.

*Why at the driver seam?* Agent text reaches the chat through several view kinds (streaming progress, answers,
questions, the "posted below" capped answer); wrapping the seam covers them all, including ones added later, on every
platform. *Why ≥ 8 characters?* Shorter values (a site key such as `beta`) are not secrets and would mangle ordinary
words; the requirement says so explicitly.

### D5 — Removing values

A project whose `env` becomes empty gets no file write (D6), so a file written earlier stays in the sandbox until the
container is recreated; the launch line no longer reads it, so a new session does not carry the values. The ops doc
says: to take values away for good, remove the entry and `docker rm proj-<slug>` (the next turn recreates it). One
`rm -f` per turn for every project would buy this automatically at the cost of an extra sandbox call on every turn of
every project — the very call D6 promises not to add.

### D6 — Default-preserving, pinned by test

For a project without values: `seedProjectEnv` returns before touching the sandbox, the launch line is built without
the prefix, and `turn.ts` uses the unwrapped driver. Tests: (a) the launch command for a project without `env` equals
the current one byte for byte (`claudeSession` test, existing golden style); (b) `seedProjectEnv` with `{}` makes zero
calls on a recording sandbox fake; (c) the Slack twin's recorded call snapshots stay unchanged (no re-snapshot).

## Risks / Trade-offs

- [The agent prints a value into a commit, PR body or file] → out of reach of the bot; the project prompt says not to,
  the repo's secret scan catches it on the PR, and `env` is limited to CI-grade values (proposal, out of scope).
- [A value shorter than 8 characters is a real secret] → documented: such a value is not redacted; don't use `env`
  for it.
- [A running `claude` holds a rotated, now-invalid value] → the file is current every turn; the prompt (project side)
  can tell the agent to `. /root/.aven/env` before a run; a new session picks it up anyway.
- [Operators expect `/aven reload` to pick up a new `.env` value] → it cannot (env is read at boot, as for every
  `.env` value); the reload error for a missing variable says to restart after editing `.env`.

## Migration Plan

Merge → canary (home bot) with one scratch project carrying a fake value; check the file, a tool call's environment,
the redacted answer and an unchanged project → tag → prod. Prod changes nothing until an operator adds `env` to a
project. Rollback: remove the project's `env` (+ `docker rm` per D5) or ship the previous version.
