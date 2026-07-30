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
| `composerAuth` | no (reload is enough) | seeded as `auth.json` into checkouts at `prepareChat` — a new session picks it up; a secret, so no Slack editing |
| `slug` / `slackChannel` | no | routing keys (`dm:…:<slug>`, `cmd:…:<slug>`) — changing orphans live sessions |

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
