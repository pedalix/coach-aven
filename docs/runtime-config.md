# Runtime config & Slack admin editing

Change a project's configuration **without a redeploy/restart** — hot-reload the registry,
and let admins edit safe fields (the project system prompt) from Slack.

> **Status: hot-reload shipped.** `/aven reload` re-reads `projects.config.json` +
> `projects.d/*.md` and swaps the live registry (everything holds a `RegistryRef` and
> reads `.current` per use); a parse failure keeps the old config. System prompts now
> live as markdown files beside the config — `projects.d/<slug>.md` (a non-empty file
> wins over the JSON `systemPrompt` field, kept as fallback) — synced by
> `prod:export`/`import`. Prompts/MCP bake into a session at `openChat`, so running
> conversations keep their setup until their persistent claude process ends.
> Still open below: the Slack **editing** half (modal + state-overrides).

## Why

Today `projects.config.json` is read **once at boot** (`loadProjects`), so any change needs
`prod:export` + `restart`. Two pains:

- restart latency for any config tweak;
- no self-serve — only an operator with the deploy machinery can change anything.

## Scope — soft vs structural

Not all fields are equal in risk. Only **soft** fields are runtime-editable from Slack;
**structural** fields stay on file + deploy (`/add-project`), because they're tied to
sandbox state.

| Field | Runtime-editable from Slack? | Why |
| --- | --- | --- |
| `systemPrompt` | **yes** | read at `openChat` → `buildSystemPrompt`; applies on a fresh session |
| `mcp` | maybe, with session recycle | `--mcp-config` is set at process spawn → needs a restart of the project session |
| `repos` | no | changes clone layout, cwd, token scope, worktrees → re-prepare the sandbox |
| `cliVersion` | no (reload is enough) | the per-project Claude Code CLI pin (canary override of `CLAUDE_CLI_VERSION`) — applied in place at the next chat prep / nightly housekeeping; see the README's *Claude Code version* |
| `slug` / `slackChannel` | no | routing keys (`dm:…:<slug>`, `cmd:…:<slug>`) — changing orphans live sessions |
| `sandbox` | no | `{ privileged, dind, mounts }` are `docker run` flags — they apply to a NEW container only; an existing `proj-<slug>` keeps its flags until it is removed on the sandbox host and recreated by the next turn (`docs/sandbox-drivers.md`) |
| `scrubSecrets` | yes (reload is enough) | read when a session opens; `false` turns off the redaction of pasted passwords/tokens/DSNs before model input (`src/scrub.ts`). Default on |
| `sources` | partly (reload re-reads intervals/accounts for the next pull) | which mail/chat/calendar/file systems the BOT pulls for this project into `data/<slug>/raw` (`docs/sources.md`); credentials are bootstrapped separately with `orch sources auth` and live under `~/.config/coach-aven/sources/<slug>/`, so adding a source needs that one-time step on the host as well; the store replica mount (`/data/sources`) is added to the project's sandbox options automatically, and that applies at container creation (recreate `proj-<slug>` after turning sources on) |

The soft/instructional needs are largely already covered by [project memory](memory.md)
("запомни для проекта: …"). So Slack editing here focuses on the deliberate
`systemPrompt`, not a full config editor.

## Design

### 1. Hot-reload (no restart)

- Re-read `projects.config.json` and **atomically swap** the in-memory `registry`.
- Trigger: `/aven reload` (admin) and/or a file watch. Removes restart latency from the
  existing `export` flow even before any Slack editing.

### 2. State-overrides (the truth-source fix)

- **File config = structural base** (deploy-managed). **Slack edits = overrides in
  `state.json`** (server-owned, *not* touched by `export`/`import`).
- Effective config = `fileConfig ⊕ stateOverride`. This is why Slack edits must NOT write
  `projects.config.json`: the next `prod:export` would clobber them.
- `/aven prompt` → modal (`views.open`) prefilled with the current prompt → save → write
  override + apply.
- `/aven prompt reset` → drop the override, fall back to the file value (so a later
  file+deploy change isn't silently shadowed).

### 3. Apply semantics

- `systemPrompt` is baked at `openChat` → to apply, **evict the project's live sessions**
  from the `live` map so the next turn rebuilds with the new prompt.
- **To verify when building:** whether `--resume` carries the old system prompt from the
  transcript — if so, a prompt change should start a fresh session rather than resume.

### 4. Guardrails

- **Authz:** admins only — allowlist of Slack user ids / emails (`users:read.email`).
- **Validation:** validate before applying (valid JSON / non-empty prompt).
- **Audit:** record who changed what (the traceability theme — Slack user → change).

## Boundaries

- **Structural changes** (add a repo, new project) → file + deploy + `/add-project`, not here.
- **Memory** (the learned layer) → [memory.md](memory.md). `/aven prompt` edits the
  deliberate layer; `/aven memory` reads the learned one.

## Open decisions

- Hot-reload trigger: explicit `/aven reload` vs. file watch (or both)?
- Beyond `systemPrompt`, is `mcp` worth making runtime-editable (with session recycle)?
- Modal UX details for multi-line prompt editing.

## Related

- [Project memory](memory.md) — read-only `/aven prompt` lands there; soft instructions via memory.
- Config loading: `loadProjects` / `registry` in `src/projects.ts`, `src/slack.ts`.
- Server-owned state that survives deploy: `state.json` (`src/state.ts`).

## MCP gateway (per project)

A project can reach all its MCP sources through the gateway (bluefin-infra `engine/`, agentgateway at
`https://<gateway-host>/gw/<slug>/mcp`) instead of listing each upstream:

```json
"mcp": [{ "name": "gw", "url": "https://<gateway-host>/gw/<slug>/mcp", "auth": "gateway-m2m" }]
```

- The bot is the Auth0 M2M client `coach-aven-<slug>`. The orchestrator mints and caches its token
  (`src/gwtoken.ts`, ≤ 1 mint per project per day — Auth0 Free allows 1000/month) from
  `AUTH0_M2M_TOKEN_URL` + `AUTH0_M2M_<SLUG>_ID/_SECRET` in the prod `.env`, and writes only the token
  into the sandbox (`/root/.aven/gw-token-gw`, 600) every turn. Claude Code reads it through the
  server's `headersHelper` (`/root/.aven/gw-headers.sh`), which also sends `x-aven-session`
  (the chat key) — the gateway logs it as `aven_session`, joining its audit to our event log.
- What the bot may do is decided by the gateway's route policy, not here. Tool names become
  `<source>_<tool>` (e.g. `youtrack_search_issues`); the project prompt should map them.
- Name the entry `gw` — `steps.ts` renders `mcp__gw__<target>_<tool>` by target.

**Rollback** (one edit): in `projects.config.json` move the project's `mcpDirectBackup` list back
to `mcp` (caldora keeps its pre-gateway list there), `prod:export`, `/aven reload`; running
conversations keep the old config until their claude process ends (or restart the bot to recycle).
