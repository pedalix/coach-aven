## Context

Cards and tasks come from `agent-messaging` (D7, D9), `hub-open-network` (version 2, N5) and `retire-agent-dispatch` (plain task frame):
- **The card** is `AgentCard {name, description, accepting, domain}` (`src/messaging/a2a.ts`).
  - `localCards` in `src/messaging/service.ts` builds it for a caller.
  - `onAgents` answers it to a peer as `cards`.
  - `parseCard` reads it back and drops unknown fields.
- **`send_message`** goes to `sendMessage`, which records an `OutTask` and posts an `ask` with a sealed `Payload`.
- **`onAsk`** checks acceptance (`not accepted` also covers "no such agent"), `domain changed`, `too deep` and `budget`, then records an `InTask` and delivers `wrapTask(...)` as the first message of a shadow conversation.
- **The session's working directory** is the repo checkout for a single-repo project and the project folder for a multi-repo one (`projectCwd`, `src/project.ts`).
- **Facts** (`src/facts.ts`) are derived, provenanced records written by deterministic code. The dependency scanner (`src/deps.ts`) was their only writer.

Measured on CLI 2.1.292 in a project sandbox:

| Session start | Skills in `init` |
|---|---|
| cwd = project folder, with `.claude/skills/rootskill`, `repo-a/.claude/skills/alpha`, `repo-b/.claude/skills/beta` | `rootskill` only |
| cwd = `repo-a` | `alpha` |
| cwd = project folder, `--add-dir repo-a repo-b` | `alpha`, `beta` |

And, through stream-json stdin:
- `/alpha hello-from-probe` ran the skill, which answered `ALPHA-SKILL-RAN hello-from-probe`.
- `/alpha` with a three-line text ran it with all three lines: it answered with the last word of the third line.
- A `SKILL.md` with `tags: [probe, test]` and an `examples` list was listed in `init` and ran. Claude Code ignores frontmatter keys it does not use.

## Goals / Non-Goals

**Goals:**
- A card says what an agent can do, from the same `SKILL.md` Claude Code loads: one source of truth.
- The receiving installation alone decides which skills are shown and whether a named skill is valid.
- A task that names a skill runs that skill: the bot invokes it, the prompt does not just mention it.
- An agent without skills works exactly as today.
- Prod's multi-repo projects get their repos' skills with the next tag.

**Non-Goals:**
- Narrowing per sender, routing, permissions or pricing by skill. The design only places their hooks.
- Exposing bundled CLI skills or plugin skills.
- Inferring a skill from a task's text.

## Decisions

### S1. Repo skills load for every multi-repo project (bucket 1)
`repoSkillDirs` (`src/project.ts`) gives each repo checkout of a project with more than one repo, and the session's command line ends with `--add-dir` and those directories (`addDirArgs`, last on the line because `--add-dir` takes every argument after it).
- **On by default.** A multi-repo session should see what a Claude Code started in each of its repos sees; that it did not was a defect of our folder layout. So this is a bug fix, not a flag to canary per project.
- **The kill switch** is `REPO_SKILLS=0` (also `false`, `off`, `no`) for the whole installation.
- **What changes for prod:** its multi-repo projects' sessions gain their repos' skills, development helpers such as release or deploy included. The ledger row names the watch point: skills the agent starts using on its own.
- **Single-repo projects are unchanged:** their session starts in the repo. A spawn line without `addDirs` is byte-identical (test).

Alternatives:
- *A per-project opt-in* (the previous plan): prod's many multi-repo projects would each need a config line before their skills load.
- *Starting in one "main" repo* loses the others' skills.
- *Symlinking the repos' skills into the project folder* writes into checkouts and repeats what `--add-dir` does natively.

### S2. Skills are found, not declared
A scanner runs at prepare time beside the dependency scanner (`src/skills.ts`, called from `prepareChat`), only for a project whose card offers skills (`messaging.skills` set). No other project gets an extra command.
- **Where it looks:** exactly where the session loads skills (`skillOrigins`): the working directory, and for a multi-repo project each `--add-dir` checkout. With `REPO_SKILLS=0` the repos' skills are not the session's, so they are not scanned either.
- **What it reads:** only each `SKILL.md`'s frontmatter, printed by `awk` in the sandbox. The parser is pure and tested:
  - plain and quoted scalars, `|` and `>` block scalars, plain values continued on indented lines;
  - block and flow lists.
- **What it records:** the fact `project_skills` on `project:<slug>`, `[{name, description, origin, tags?, examples?, clash?}]`, with sources `<origin>@<commit>:.claude/skills/<folder>/SKILL.md`.
  - The name is the frontmatter `name`, else the folder name.
  - The description is capped at 300 characters, tags at 8 of 40, examples at 5 of 200.
- **Malformed keys** (a name that is not a skill name, `tags: brand, web` instead of a list) are logged and skipped; the skill is kept with what is valid.
- **A failed scan** keeps the previous fact, as the dependency scanner does.

### S3. A name defined twice is withheld
When two origins define the same name, the fact keeps one entry with `clash: [<every origin>]`. Such a skill is never offered: which definition the CLI would load is not ours to guess, and an asker relying on the wrong one would be worse than no offer. The scan warns with both places, and the card logs `skills.withheld` once.

### S4. The receiving installation decides what is offered
`exposedSkills` (`src/messaging/skills.ts`, pure) turns the allowlist and the fact into a card's skills:
- **`messaging.skills` absent:** none. A project's skills stay internal unless its operator lists them.
- **A list:** those names that were found, in list order. A missing name is logged once per process (`skills.missing`); a clashing one is withheld (S3).
- **`"*"`:** every skill found, except the clashing ones.
- **Never scanned** (the project had no session since its skills were listed): an explicit list is offered by name, without description, so the first task after a deploy does not fail on a missing scan; `"*"` offers nothing until the scan.

Every sender the agent accepts sees the same set, and `onAsk` checks against the same set. Narrowing per sender is cut from v1 and comes with roles.

### S5. The A2A AgentSkill subset
A card's `skills` is `[{id, name, description, tags, examples?}]`:
- `id` and `name` are the skill's name;
- `tags` is always present (A2A requires it), `[]` when none;
- `examples` is present only when the `SKILL.md` gives some.

A card this release builds always has `skills` (`[]` when nothing is offered). `parseCard` keeps well-formed skills, caps them, and drops malformed ones, not the card; a card from an older release reads as `skills: []`.

### S6. The check, on the receiving side
In `onAsk`, the skill check comes after acceptance, the domain and the depth, and before the budget:
1. A sender the target does not accept gets `not accepted`, as today, and learns nothing about skills.
2. A skill not offered gets `rejected: unknown skill`. The rejection text lists the offered ids, or says the agent offers none; the caller could read them from the card anyway.
3. A rejected task does not count against the budget.

For a local target, `sendMessage` refuses at once with the same text and records nothing; `onAsk` still checks, so both transports have one authority. Only a task's first message carries a skill. The skill travels in the sealed payload (`Payload.skill`), and the hub never sees it.

### S7. Running the skill
A task with a skill starts its shadow conversation with `/<skill> ` followed by the plain task frame (`invokeSkill`). Claude Code runs the skill with the frame as its arguments: verified live, multi-line arguments included (Context). Without a skill, the first message is exactly today's frame.

**No fallback.** The previous plan named the skill in the frame when the session had not loaded it. The two CLI facts held when measured, and a CLI bump re-checks them once the cli-probe scenarios become contract scenarios (S9).

### S8. Records and audit
- `OutTask.skill?` and `InTask.skill?` in `state.json`, additive.
- `/aven asks` shows ` · skill <name>` in the list and in a transcript's head.
- `ask.rejected` carries `reason=unknown skill`. `skills.missing` and `skills.withheld` are warnings, so they reach Sentry, once per project and name.

### S9. cli-probe
- **Scenario files.** A scenario may now seed `files` into the CLI's working directory before the CLI starts (`ScenarioMeta.files`, `Transport.seed`, local and sandbox); paths stay inside the working directory.
- **Two exploratory scenarios:**
  - `add-dir-loads-skills`: a skill under an `--add-dir` directory is listed in `init`.
  - `skill-slash-via-stdin`: `/<skill>` with a multi-line text through stdin runs the skill with all of it, and `tags`/`examples` keys do not stop it from loading.

  They are not recorded yet: a run needs `CLI_PROBE_TOKEN`, which this change's author did not have. The facts were verified by hand on 2.1.292 (Context). Once recorded on every probed version, both become contract scenarios.

### S10. What a skill does not do yet, and where that plugs in

| Later | Plugs in at |
|---|---|
| Narrowing per sender, roles | an `accept` entry becomes an object; `exposedSkills` gains the sender |
| Routing by skill (another session, prompt or sandbox) | `onAsk`, after S6's check |
| Permissions per skill | the receiving bot picks the sandbox permission mode from the skill and the sender's role |
| Checking the scan against the session's `init` | `ClaudeSession` already parses `init`; it lists `skills` |
| Bundled or plugin skills | a second origin in S2, behind its own allowlist |
| Adapters to external A2A endpoints | a card source beside `localCards`; S5's subset maps 1:1 |
| Cost per skill | the task's `skill` and its metered cost are on one record |

## Risks / Trade-offs

- **[Repo skills change prod's multi-repo sessions]** A development helper such as release or deploy becomes available to the agent. → The ledger row names the watch point; `REPO_SKILLS=0` turns it off at once.
- **[A skill's description was written for its repo's developers]** The operator chooses what to expose, and better text goes into the repo's `SKILL.md`, where the agent itself benefits.
- **[The CLI changes how skills load or run]** The two scenarios become contract scenarios once recorded, and a bump re-checks them.
- **[The scan goes stale between prepares]** The fact is replaced on every prepare of a project that offers skills.
- **[Before the first scan, an explicit list is offered by name]** A task naming a listed skill that does not exist then reaches the session, which has no such skill. → It happens only between a deploy and the project's first session, and the operator listed the name.
- **[A release without skills ignores a named skill]** Additive by design, and documented. It matters only while installations run different releases.

## Migration Plan

Merge: repo skills is bucket 1, skills in messaging bucket 2. Then:
1. On the canary installations, put a skill's name in a project's `messaging.skills` and `/aven reload`.
2. From the home tenant agent, `agents()` shows the skill.
3. Run a task naming it: the answering session starts with the slash invocation. Run one naming an unknown skill: it is rejected with the list.
4. Prod takes repo skills with the next tag. Watch its multi-repo projects' sessions for skills the agent starts using on its own.

**Rollback.** `REPO_SKILLS=0` for repo skills; drop `messaging.skills`, or revert. Records carrying `skill` stay readable by older code.
