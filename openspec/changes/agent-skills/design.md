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
- `init` also lists the session's `slash_commands` (built-in, bundled and the project's own) beside its `skills`.

What the repos of an operator's multi-repo projects carry today (from their default branches): mostly OpenSpec workflow skills (`openspec-*`, often the same set in several repos of one project) and `/opsx` commands, a few Laravel development helpers, and no release or deploy skills.

## Goals / Non-Goals

**Goals:**
- A card says what an agent can do, from the same `SKILL.md` Claude Code loads: one source of truth.
- The receiving installation alone decides which skills are shown and whether a named skill is valid.
- A task that names a skill runs that skill: the bot invokes it, the prompt does not just mention it.
- An agent without skills works exactly as today.
- Multi-repo projects can load their repos' skills, off until an installation switches it on.

**Non-Goals:**
- Narrowing per sender, routing, permissions or pricing by skill. The design only places their hooks.
- Exposing bundled CLI skills or plugin skills.
- Inferring a skill from a task's text.

## Decisions

### S1. Repo skills for multi-repo projects, behind `REPO_SKILLS=1` (bucket 3)
`repoSkillDirs` (`src/project.ts`) gives each repo checkout of a project with more than one repo, and the session's command line ends with `--add-dir` and those directories (`addDirArgs`, last on the line because `--add-dir` takes every argument after it).
- **Off by default.** Only `REPO_SKILLS=1` turns it on, for the installation; unset or anything else, every spawn line is byte-identical to before (tests compare the multi-repo line both ways). Decided in review: prod does not get repo skills for now.
- **Why a flag and not a bug fix.** A multi-repo session should see what a Claude Code started in each repo sees, but switching it on changes what every session of those projects can do, people's sessions included. What it brings today: mostly OpenSpec workflow skills and `/opsx` commands, plus a few Laravel development helpers; a skill defined in two repos loads twice, and `/name` runs the first `--add-dir`'s; `--add-dir` loads each repo's legacy `.claude/commands/` too. So it waits for a skill worth it, per installation.
- **Turning it on:** `REPO_SKILLS=1` in the installation's ops `.env`, an export, a restart. Running and reattached sessions keep their old line until they end or `🔄 Restart session`.
- **Both drivers** run the same command line; the Daytona driver passes it unchanged. The canary installations are single-repo, so the multi-repo path has no canary run yet: it rests on the live measurement and the tests.
- **Single-repo projects are unaffected either way:** their session starts in the repo.

Alternatives:
- *On by default, with a kill switch* (the first version of this PR): prod's multi-repo sessions would change at the tag, for skills nobody asked to offer yet.
- *A per-project opt-in:* finer, but a second place to configure; an installation-wide switch is enough while no installation needs it per project.
- *Starting in one "main" repo* loses the others' skills.
- *Symlinking the repos' skills into the project folder* writes into checkouts and repeats what `--add-dir` does natively.

### S2. Skills are found, not declared
A scanner runs at prepare time beside the dependency scanner (`src/skills.ts`, called from `prepareChat`), only for a project whose card offers skills (`messaging.skills` set). No other project gets an extra command.
- **Where it looks:** exactly where the session loads skills (`skillOrigins`): the working directory, and for a multi-repo project with `REPO_SKILLS=1` each `--add-dir` checkout. Without it the repos' skills are not the session's, so they are not scanned either.
- **What it reads:** only each `SKILL.md`'s frontmatter, printed by `awk` in the sandbox, at most 120 lines of at most 1000 characters (`head`, `cut`). The parser is pure and tested:
  - plain and quoted scalars, `|` and `>` block scalars, plain values continued on indented lines;
  - block and flow lists.
- **Forgery-proof output.** Every scan picks a fresh random nonce, and its markers (`@@ORIGIN-<nonce>`, `@@SKILL-<nonce>`, `@@SKIP-<nonce>`) carry it, so frontmatter text or a folder name cannot forge a record. A folder whose name is not a skill name — a control character, a newline, uppercase — prints only `@@SKIP-<nonce>`, never its name (`case` under `LC_ALL=C`). A test runs the real script in a shell over a hostile tree.
- **What it records:** the fact `project_skills` on `project:<slug>`, `[{name, description, origin, tags?, examples?, userInvocable?, clash?}]`, with sources `<origin>@<commit>:.claude/skills/<folder>/SKILL.md`.
  - The id (`name`) is the **folder** name: the CLI resolves `/name` by folder. A frontmatter `name` that differs is only reported.
  - `user-invocable: false` is recorded; such a skill is never offered (S3).
  - The description is capped at 300 characters, tags at 8 of 40, examples at 5 of 200.
- **Malformed keys** (`tags: brand, web` instead of a list) are logged and skipped; the skill is kept with what is valid.
- **A failed scan** keeps the previous fact, as the dependency scanner does; the command runs checked (`{check: true}`), so a non-zero exit is a failure, not "no skills".

### S3. Only what really runs is offered
A skill is withheld from the card — and from task validation — when `/name` would not run it:
- **Defined twice.** Two origins define the same name: the fact keeps one entry with `clash: [<every origin>]`. Which definition the CLI loads (the first `--add-dir`'s) is not what an asker can rely on, so it is offered nowhere until renamed.
- **`user-invocable: false`.** The CLI will not run it by name.
- **A CLI command's name.** `/name` would run the command, not the skill. The names not ours are a static guard list of the CLI's built-ins (`init`, `context`, `recap`, `debug`, `verify`, `run`, `design`, `review`, `clear`, `compact`, `help`, `config`) plus what the project's sessions report in `init` (`slash_commands` and `skills`) minus the project's own skills. `tasks.ts` records that report as the fact `session_commands` (rewritten only when it changes) for a project that offers skills.

Each withheld name is logged once as `skills.withheld` with its reason.

### S4. The receiving installation decides what is offered
`exposedSkills` (`src/messaging/skills.ts`, pure) turns the allowlist, the fact and the names not ours into a card's skills:
- **`messaging.skills` absent:** none. A project's skills stay internal unless its operator lists them.
- **Entries:** skill names, globs with `*` (`newsletter-*`), and exclusions with a leading `!` (`!openspec-*`), validated strictly at load (an optional `!`, then kebab-case segments with `*`; a bad entry fails the load naming the project). The string `"*"` is shorthand for `["*"]`. A skill is offered when an inclusion matches it and no exclusion does, exclusions applying after inclusions whatever their order; inclusions keep their list order, a glob the scan order. A plain name that matches nothing is logged once per process (`skills.missing`); a glob that matches nothing is not.
- **Whatever the entries say,** what does not really run (S3) stays withheld.
- **Recommended:** `["*", "!openspec-*"]` — workflow tooling skills are for the agent's own developers, not for other agents — so a new skill appears on the card without a configuration change. `["*"]` alone offers development helpers too, to every accepted sender, and shadow sessions run with permissions bypassed; `docs/agent-messaging.md` warns.
- **Never scanned** (no session since the skills were listed): nothing, for a list as for `"*"`. Offering a name the bot has not seen would let a task reach a session without that skill.
- **At most 32** skills on a card.

Every sender the agent accepts sees the same set, and `onAsk` checks against the same set. Narrowing per sender is cut from v1 and comes with roles.

### S5. The A2A AgentSkill subset
A card's `skills` is `[{id, name, description, tags, examples?}]`:
- `id` and `name` are the skill's name;
- `tags` is always present (A2A requires it), `[]` when none;
- `examples` is present only when the `SKILL.md` gives some.

A card this release builds always has `skills` (`[]` when nothing is offered). `parseCard` keeps well-formed skills, caps them (at most 32, a name of at most 64 characters, the text caps of S2), and drops malformed ones, not the card; a card from an older release reads as `skills: []`.

### S6. The check, on the receiving side
In `onAsk`, the skill check comes after acceptance, the domain and the depth, and before the budget:
1. A sender the target does not accept gets `not accepted`, as today, and learns nothing about skills.
2. A skill not offered gets `rejected: unknown skill`. The rejection text lists the offered ids, or says the agent offers none; the caller could read them from the card anyway.
3. A rejected task does not count against the budget.

For a local target, `sendMessage` refuses at once with the same text and records nothing; `onAsk` still checks, so both transports have one authority. The skill travels in the sealed payload (`Payload.skill`), and the hub never sees it.
- **Only a task's first message carries it.** A reply, and a held reply a person releases, omit it.
- **A malformed id is rejected, not dropped.** `parsePayload` keeps any received `skill` (as a string, capped); `onAsk` answers an id that is not a skill id `rejected: unknown skill`, so the asker is told at once instead of waiting for the task to expire.

### S7. Running the skill
A task with a skill starts its shadow conversation with `/<skill> ` followed by the plain task frame (`invokeSkill`). Claude Code runs the skill with the frame as its arguments: verified live, multi-line arguments included (Context). Without a skill, the first message is exactly today's frame.

**An offered skill must take free-text arguments.** The frame begins with `[Request from another agent]`, the sender and the task id; the request follows. So positional (`$0`, `$ARGUMENTS[0]`) and named arguments get the frame's first words. The request is not moved to the front: a request beginning with `/` would chain a second skill. `docs/agent-messaging.md` says so.

**No fallback.** The previous plan named the skill in the frame when the session had not loaded it. The two CLI facts held when measured, and a CLI bump re-checks them once the cli-probe scenarios become contract scenarios (S9).

### S8. Records and audit
- `OutTask.skill?` and `InTask.skill?` in `state.json`, additive.
- `/aven asks` shows ` · skill <name>` in the list and in a transcript's head.
- `ask.rejected` carries `reason=unknown skill`. `skills.missing` and `skills.withheld` are warnings, so they reach Sentry, once per project and name.

### S9. cli-probe
- **Scenario files.** A scenario may now seed `files` into the CLI's working directory before the CLI starts (`ScenarioMeta.files`, `Transport.seed`, local and sandbox); paths stay inside the working directory.
- **Two exploratory scenarios:**
  - `add-dir-loads-skills`: as the bot launches a multi-repo session, one `--add-dir` with two absolute checkouts (`{work}` in a scenario's extra args becomes the CLI's working directory); the skills of both are listed in `init`.
  - `skill-slash-via-stdin`: with the message ledger (`--replay-user-messages`), as every shadow session runs, `/<skill>` with a multi-line text through stdin runs the skill with all of it, and `tags`/`examples` keys do not stop it from loading.

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

- **[Turning repo skills on changes multi-repo sessions]** OpenSpec workflow skills, `/opsx` commands and a few development helpers become available to the agent; duplicates load twice. → Off by default; the ledger row names what turning it on brings, the watch point and the steps.
- **[`"*"` offers development helpers]** To every sender the agent accepts, in sessions that run with permissions bypassed. → Documented; list names unless every skill is meant for other agents. Roles per sender are the planned lever.
- **[A skill's description was written for its repo's developers]** The operator chooses what to expose, and better text goes into the repo's `SKILL.md`, where the agent itself benefits.
- **[The CLI changes how skills load or run]** The two scenarios become contract scenarios once recorded, and a bump re-checks them.
- **[The scan goes stale between prepares]** The fact is replaced on every prepare of a project that offers skills.
- **[A release without skills ignores a named skill]** Additive by design, and documented. It matters only while installations run different releases.

## Migration Plan

Merge: repo skills is bucket 3 (off), skills in messaging bucket 2. Then:
1. On the canary installations, put a skill's name in a project's `messaging.skills` and `/aven reload`.
2. From the home tenant agent, `agents()` shows the skill.
3. Run a task naming it: the answering session starts with the slash invocation. Run one naming an unknown skill: it is rejected with the list.
4. Repo skills stay off everywhere; an installation switches `REPO_SKILLS=1` on when a skill worth it exists, and watches its multi-repo sessions for skills the agent starts using on its own.

**Rollback.** Remove `REPO_SKILLS=1`; drop `messaging.skills`, or revert. Records carrying `skill` stay readable by older code.
