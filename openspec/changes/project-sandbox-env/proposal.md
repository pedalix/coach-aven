# Proposal

## Why

A project's agent can run a repository's own checks in its sandbox, but not those that need a secret the repo's CI
holds. The example: an Example Hotel site repo whose Playwright E2E and sitemap smoke suite run against Vercel
preview deployments behind Deployment Protection. CI has the automation-bypass secret and a read-only content-API
token as Actions secrets; the sandbox has neither, so the agent can only push and wait for CI. `ProjectConfig.env`
has been in the config shape since the start, "modeled now, wired later" (`src/projects.ts`); nothing reads it.

## What Changes

- A project's `env` (name → value) is wired: every value may use `${VAR}` refs, resolved from the bot's environment
  when the config loads (boot and `/aven reload`). An unknown ref is a configuration error naming the project, the
  key and the variable, never the value. Today's MCP rule resolves an unknown ref to `''`; for `env` that would make
  the suite skip silently, so it fails instead.
- Names are checked: `[A-Z_][A-Z0-9_]*`, and names the bot sets itself are refused (git identity, `IS_SANDBOX`,
  `AVEN_SESSION`, the Claude Code and credit variables, `GH_TOKEN`/`GITHUB_TOKEN`, `PATH`, `HOME`).
- Every turn, beside the gateway token, the bot writes the resolved values into a `0600` file in the sandbox
  (`/root/.aven/env`, shell-quoted `export` lines). A new `claude` process starts with them in its environment: the
  launch line reads the file, so the values never appear on the host's or the container's command line.
- The bot's own chat output for that project's turns (answers, progress, questions; every chat driver) has the literal
  values replaced with `[redacted:<NAME>]`.
- Docs: `docs/runtime-config.md` (the field, the restart rule for `.env`, rotation), the example config, and the
  `manage-project` skill's field table (today: "reserved, keep {}").

Out of scope:

- Text the agent writes outside the chat — commits, PR bodies, files. The bot does not see it before it is published;
  the project prompt says not to print values, and a repo's secret scan is the net there.
- Redacting the values inside the agent's own context (tool output it reads). They are the agent's to use.
- High-value credentials. `env` is for what a repo's CI would hold for read-only checks; a token that writes or reads
  personal data belongs behind the gateway, as today.
- Per-repo scoping inside a multi-repo project: one `env` per project; different repos use different names.
- Removing a value from a running sandbox when `env` is emptied: covered by the next new session (see design D5).

## Capabilities

### New Capabilities

- `project-sandbox-env`: the per-project `env` — how values are declared and resolved, which names are allowed, how
  they reach the sandbox and the `claude` process, and how the chat output is kept free of them.

### Modified Capabilities

None. The MCP `${VAR}` rule (empty on an unknown ref) stays as it is.

## Impact

- **Code:** `src/projects.ts` (validate and resolve `env` at load), a pure module `src/projectenv.ts` with tests (name
  rules, resolution, the env-file text, literal redaction), `src/project.ts` (`seedProjectEnv` beside
  `seedGatewayAuth`), `src/tasks.ts` (call it every turn), `src/claudeSession.ts` (the launch line reads the file
  when the project has values), `src/turn.ts` (the redacting wrapper around the chat driver for a project with
  values).
- **Rollout: bucket 2, default-preserving; the config gate is the project's `env` itself.** A project without `env`
  (every project today; the example config's `{}` included) gets no file, no extra exec per turn, the same launch line
  and unwrapped chat output. A test pins that shape: the launch command for a project without `env` is byte-identical
  to today's, and `seedProjectEnv` makes no sandbox call. No flag; a ledger row records the change.
- **Operators:** a value in `.env` is read at boot, so adding one is `.env` + `restart`; changing only the
  `projects.config.json` mapping is `/aven reload`. A running `claude` keeps the values it started with until its next
  session; the file is always current.
- **Security:** the values sit in the sandbox (file and process environment) and in the bot's `.env`, nowhere else;
  they never appear in bot logs, config errors or chat output.
