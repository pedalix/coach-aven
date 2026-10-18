## Context

Cards and tasks come from `agent-messaging` (D7, D9), `hub-open-network` (version 2, N5) and `retire-agent-dispatch` (plain task frame):
- **The card** is `AgentCard {name, description, accepting, domain}` (`src/messaging/a2a.ts`).
  - `localCards` in `src/messaging/service.ts` builds it for a caller.
  - `onAgents` answers it to a peer as `cards`.
  - `parseCard` reads it back and drops unknown fields.
- **`send_message`** goes to `sendMessage`, which records an `OutTask` and posts an `ask`. Its sealed `Payload` is `{message, domain, toDomain?, marks, depth}`.
- **`onAsk`** checks, in this order: acceptance (`not accepted` also covers "no such agent"), `domain changed`, `too deep`, `budget`. It then records an `InTask` and delivers `wrapTask(...)` as the first message of a shadow conversation (`service.ts`, `deliver(… text: wrapTask(…))`).
- **`accept`** entries are strings (`*`, `<installation>/<agent>`, `<agent>`), validated in `src/messaging/config.ts` and matched by `accepts()` in `protocol.ts`.
- **The session's working directory** is the repo checkout for a single-repo project and the project folder for a multi-repo one (`projectCwd`, `src/project.ts`). `claudeLaunch` (`src/claudeSession.ts`) takes `extraArgs`.
- **The `init` frame** is already parsed by `ClaudeSession.noteCli`, which takes the CLI version and capabilities from it.
- **Facts** (`src/facts.ts`, `docs/project-facts.md`) are derived, provenanced records written by deterministic code. Today the dependency scanner (`src/deps.ts`) is their only writer: it greps manifests inside the sandbox at prepare time.

Measured on CLI 2.1.292 in a project sandbox, reading `skills` from the `init` frame of `claude -p … --output-format stream-json --verbose`:

| Session start | Skills in `init` |
|---|---|
| cwd = project folder, with `.claude/skills/rootskill`, `repo-a/.claude/skills/alpha`, `repo-b/.claude/skills/beta` | `rootskill` only |
| cwd = `repo-a` | `alpha` |
| cwd = project folder, `--add-dir repo-a repo-b` | `alpha`, `beta` |

## Goals / Non-Goals

**Goals:**
- A card says what an agent can do, from the same `SKILL.md` that Claude Code itself loads: one source of truth.
- The receiving installation alone decides which skills are shown, to whom, and whether a named skill is valid.
- A task that names a skill runs that skill. The bot invokes it; the prompt does not just mention it.
- An agent without skills works exactly as today.

**Non-Goals:**
- Routing, permissions or pricing by skill. The design only places their hooks.
- Exposing bundled CLI skills or plugin skills.
- Agents that are not sandboxes.
- Inferring a skill from a task's text.

## Decisions

### S1. Skills are found, not declared
A scanner runs at prepare time, beside the dependency scanner (`src/skills.ts`, called from `tasks.ts`):
- It lists every `.claude/skills/*/SKILL.md` in the project folder and in each repo checkout, inside the sandbox.
- It parses the YAML frontmatter `name` and `description`. The parser is pure, with tests over real-shaped files.
- It writes the fact `project_skills` on `project:<slug>`. The value is `[{name, description, origin: "<repo>" | "project", loadable}]`; the sources are `<repo>@<commit>:.claude/skills/<dir>/SKILL.md`.
- **`loadable`** says whether a session of this project loads the skill: always for `origin: "project"` and for a single-repo project's repo; for a multi-repo project's repos, only with `repoSkills` (S2).
- **Clashes.** A name that two origins both define is recorded with `clash: true` and is never exposed, because which one Claude Code would load is not ours to guess.

**Verification from the session.** `noteCli` also takes `init.skills`, and the session keeps the list. When a skill the card exposes is missing from a session's list, the bot logs `skills.not.loaded`, a warning that reaches Sentry. A task naming that skill then falls back to the frame line (S6).

**Why only these two places.** Bundled skills are the CLI's (`init` lists them, e.g. `code-review`). Plugin skills come from installed plugins. Neither is the project's to offer. Reading only the project's own skill folders makes that boundary structural, not a filter someone has to keep up to date.

Alternatives:
- *Skills written in the `messaging` block*, the first version of this plan: a second description of the same thing, which drifts.
- *Only the `init` list:* it gives names without descriptions, and only after a session ran.
- *Generated from the README:* that describes intentions, not something the agent can invoke.

### S2. `--add-dir` for multi-repo projects, behind `repoSkills`
- A project field `repoSkills: true` adds `--add-dir <checkout>` to the session's launch for each repo. That is a no-op for a single-repo project, which already starts in its repo.
- **Why a gate.** Turning it on changes what every session of that project sees, people's sessions included, not just shadow ones:
  - the repos' skills join the system prompt, with their descriptions;
  - skills written for local development, such as release or deploy helpers, become available to the agent.

  That is a behaviour change for a prod project, so it is opt-in and off by default. The spawn-line golden of a project without it stays byte-identical. Bucket 2: a per-project field, off by default, where an env flag would turn on every project of an installation at once.
- **Pinned by cli-probe.** A contract scenario, `add-dir-loads-skills`, asserts that a skill folder under an `--add-dir` directory appears in `init.skills`. Bumping the CLI pin therefore checks it.

Alternatives:
- *Start in one "main" repo:* this loses the others' skills.
- *Symlink the repos' skills into the project folder:* this creates name clashes, writes into checkouts, and repeats what `--add-dir` does natively.

### S3. The receiving installation decides what is shown, and to whom
- **The allowlist.** `messaging.skills` is a list of skill names; there is no default, so nothing is shown. A project's internal skills stay internal even when they are loadable.
- **Narrowing per sender.** An `accept` entry may be `{"from": "<pattern>", "skills": ["<name>", …]}`, where `<pattern>` is today's string form. Validation at load refuses a skill that is not in the allowlist.
- **Who may use what.** For a caller, the skills it may use are the union over its matching entries. A string entry contributes every exposed skill; an object entry contributes its list.
- **What is exposed.** The allowlist, intersected with `project_skills` entries that are `loadable` and not clashing. A listed name that is missing, not loadable or clashing is logged once per scan (`skills.missing`, with the reason) and not shown.
- **The card** (`localCards`, and the `cards` answer to a peer) carries only the skills the caller may use. The same set is checked at task time (S5).

### S4. The A2A AgentSkill subset, always present
- A card's `skills` is `[{id, name, description, tags}]`:
  - `id` and `name` are the skill's name;
  - `description` comes from `SKILL.md`, capped at 300 characters;
  - `tags` is `[]`.
- A2A requires `skills` and `tags`, so they are always present: an agent without exposed skills has `skills: []`. Cards of projects with a `messaging` block gain this one field, and nothing else changes for them.
- On the wire, the card's `skills` and the sealed `Payload.skill` are additive within version 2. `parseCard` keeps well-formed skills and drops malformed entries. An older release drops `skills` and ignores `skill`, so it runs a skill-named task as a general request, and `docs/agent-messaging.md` says so.

### S5. The check, on the receiving side
In `onAsk` the skill check comes after acceptance, the domain and the depth, and before the budget:
1. A sender the target does not accept gets `not accepted`, as today, and learns nothing about skills.
2. A skill the caller may not use (S3), including any skill at an agent that exposes none, gets `rejected: unknown skill`. The rejection lists the ids the caller may use, which it could read from its card anyway.
3. A rejected task does not count against the budget.

For a local target, `sendMessage` refuses at once with the same list and records nothing. `onAsk` still checks, so both transports have one authority. Only a task's first message carries a skill.

### S6. Running the skill
- **With a skill**, the first message of the answering shadow conversation is the skill's slash invocation followed by the plain task frame: `/<skill>` on its own line, then `wrapTask(…)` unchanged. Claude Code runs the skill, with the frame as its input.
- **The fallback** is used when the session's `init` did not list the skill, or when the pinned CLI's report marks slash invocation through stream-json input as unsupported. The frame then gains the line `Use the \`<skill>\` skill for this request.`, and `skills.fallback` is logged.
- **Pinned by cli-probe.** A contract scenario, `skill-slash-via-stdin`, writes a slash invocation of a project skill through stream-json input and asserts that the skill ran: the skill's body asks for a marker word, and the answer carries it. The recording joins the version's report.
- **Without a skill**, the first message is exactly today's frame (golden).

### S7. Records and audit
- `OutTask.skill?` and `InTask.skill?` are added to `state.json`; this is additive.
- `/aven asks` shows ` · skill <name>` on such tasks.
- `ask.rejected` carries `reason=unknown skill`. `skills.missing`, `skills.not.loaded` and `skills.fallback` are warnings, so they reach Sentry once per key.

### S8. An agent without skills
Nothing changes in how it works:
- its card has its description and `skills: []`;
- `agents()` shows it;
- a task without a skill runs as today;
- a task naming any skill gets `rejected: unknown skill` with an empty list.

### S9. What a skill does not do yet, and where that plugs in

| Later | Plugs in at |
|---|---|
| Routing by skill (another session, prompt or sandbox) | `onAsk`, after S5's check |
| Permissions per skill, with roles per sender in `accept` | `accept` objects (S3) already carry per-sender skills; a `role` key joins them, and the receiving bot picks the sandbox permission mode |
| Bundled or plugin skills | a second origin in S1, behind its own allowlist |
| Examples and tags | optional frontmatter keys read by S1's parser |
| Adapters to external A2A endpoints | a card source beside `localCards`; S4's subset maps 1:1 |
| Cost per skill | the task's `skill` and its metered cost are already on one record |

## Risks / Trade-offs

- **[A skill's description was written for its own repo's developers]** The operator chooses what to expose, and better text goes into the repo's `SKILL.md`, where the agent itself benefits from it too.
- **[`repoSkills` changes people's sessions too]** That is why it is an opt-in per project, canaried first. The ledger row says what to watch: skills the agent starts using on its own.
- **[The CLI changes how skills load or run]** The two contract scenarios fail on a bump, and S6's fallback keeps a task running.
- **[The scan goes stale between prepares]** The fact is replaced on every prepare, and the session's `init` list catches a skill that vanished (`skills.not.loaded`).
- **[Name clashes in multi-repo projects]** They are detected and never exposed, and are logged until resolved.
- **[A release without skills ignores a named skill]** Additive by design, and documented. It matters only while installations run different releases.

## Migration Plan

Merge (bucket 2). Then:
1. On the staging installation, choose a project with a repo skill, put its name in `messaging.skills`, and `/aven reload`. If it is a multi-repo project, also set `repoSkills: true`.
2. From the home tenant agent, `agents()` shows the skill.
3. Run a task naming it: the answering session starts with the slash invocation. Run one naming an unknown skill: it is rejected with the list. Record both in the PR.

**Rollback.** Drop `messaging.skills` and `repoSkills`, or revert. Records carrying `skill` stay readable by older code.
