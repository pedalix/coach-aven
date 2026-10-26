# Proposal

> **Status: proposed 2026-10-18, reworked twice the same day; implemented as a lean v1.** Decisions taken in review:
> - **An agent's skills are its project's Claude Code skills.** The bot finds the `SKILL.md` files the session itself loads and reads their name, description, and the optional `tags` and `examples`. The operator does not write skills a second time in the configuration.
> - **The receiving installation decides what is offered.** The project's `messaging.skills` lists the skills that may be shown, or `"*"`; nothing is shown by default. Every sender the agent accepts sees the same set; narrowing per sender comes later, with roles.
> - **A task that names a skill starts with that skill.** The answering session's first message invokes the skill explicitly, so the bot decides how the task runs instead of leaving it to the prompt.
> - **An agent without skills works as today.** Its card says so (`skills: []`), and it takes general requests.
> - **Multi-repo projects can load their repos' skills, off by default.** `REPO_SKILLS=1` passes `--add-dir` for each repo; prod does not get it for now (decided in review). An installation switches it on when a skill worth it exists. Single-repo projects already load their repo's skills.
> - **The first real use must work.** The two CLI facts it rests on were verified live on the pinned CLI before the code was written, and the code does not need a fallback.

## Why

Today an agent card says what an agent is, in one line. An asking agent picks its target by guessing from that line. Agents are about to specialise:
- a project agent for one codebase;
- an operator's tenant agent;
- an agent for one function, such as a newsletter agent, or a brand studio that builds a brand profile from a hotel's website.

The asker needs to know what each one offers. A2A's Agent Card already answers that with a list of skills, each with an id, a name, a description, tags and examples.

A project already has such a list. Its Claude Code skills (`.claude/skills/*/SKILL.md`) each carry a name and a description, and Claude Code runs one when it is named. Exposing them means one source of truth: the repo's own skill, not a second description in an ops repo that drifts from it.

Measured on the pinned CLI (2.1.292), in a project sandbox:
- **A multi-repo project's sessions do not load their repos' skills today.** The session starts in the project folder, which only holds the repos side by side. With `--add-dir` for each repo, the repo skills load.
- **A slash invocation through stream-json input runs the skill,** with the whole text, every line of it, as its arguments.
- **Unknown frontmatter keys do not stop a skill from loading:** a `SKILL.md` with `tags` and `examples` is listed and runs.

## What Changes

- **Repo skills (bucket 3).** With `REPO_SKILLS=1`, every session of a multi-repo project starts with `--add-dir <checkout>` for each repo. Off by default: every spawn line stays as it was.
- **Finding skills.** At prepare time, for a project whose card offers skills, a scanner in the sandbox reads every `SKILL.md` where the session loads skills. It records the project fact `project_skills`: name, description, tags, examples, origin and provenance.
  - A name defined twice is withheld from the card until renamed, with a warning naming both places.
  - Malformed keys are logged and skipped.
  - Bundled and plugin skills are never candidates.
- **Exposure.** `messaging.skills` is a list of names, `*` globs and `!` exclusions (recommended: `["*", "!openspec-*"]`), or `"*"`; absent, nothing is offered. Every accepted sender sees the same set, at most 32. Only what really runs is offered: the folder name is the id, and a skill marked `user-invocable: false` or named like a CLI command is withheld. Nothing is offered before the project's first scan.
- **Cards.** Every card carries `skills`, the A2A AgentSkill subset: `id`, `name`, `description`, `tags` (always, `[]` when none) and `examples` (when given), capped. An agent without skills has `skills: []`.
- **A skill on a task.** `send_message` takes an optional `skill`. The receiving installation decides:
  - a skill it does not offer, or a malformed id, gets `rejected: unknown skill`, with the ids it offers; only a task's first message carries a skill;
  - a sender that is not accepted learns nothing;
  - in the caller's own installation the tool refuses at once.
- **Running it.** A task with a skill starts its shadow session with `/<skill>` followed by the plain task frame.
- **Records.** The skill is stored on the task on both sides and shown by `/aven asks`.
- **Protocol.** Additive within version 2: the card's `skills` and the sealed payload's `skill`. An older release ignores both and runs a skill-named task as a general request.

## Out of scope

Cut from v1, kept as extension notes in the design:
- narrowing the offered skills per sender in `accept`, and roles per sender;
- routing a task by its skill to another session or sandbox, and permissions per skill;
- reading the session's `init` skills to check the scan, and a fallback when a skill did not load;
- exposing bundled or plugin skills;
- agents that are not sandboxes, such as adapters to external A2A endpoints;
- cost per skill in `/aven asks`.

## Capabilities

### New Capabilities
None.

### Modified Capabilities
- `agent-messaging`:
  - new: skills come from the project's Claude Code skills;
  - new: a multi-repo project's sessions load their repos' skills;
  - new: the receiving installation decides which skills are offered;
  - new: a task can name the skill it asks for;
  - changed: discovery through agent cards (cards carry skills);
  - changed: agent tools mirror A2A operations (`send_message` takes `skill`);
  - changed: terminal states (a new `rejected` reason, `unknown skill`).

  The capability comes from the `agent-messaging` change, which is not archived yet. `hub-open-network` and `retire-agent-dispatch` also modify it. The archive order is `agent-messaging` → `hub-open-network` → `retire-agent-dispatch` → `agent-skills`.

## Impact

- **Rollout.**
  - **Bucket 3 for repo skills:** `REPO_SKILLS=1`, off everywhere; switched on per installation when a skill worth it exists. What it brings: mostly OpenSpec workflow skills and `/opsx` commands, plus a few Laravel development helpers; duplicates across repos load twice.
  - **Bucket 2 for skills in messaging:** only projects with a `messaging` block; the configuration is additive, and cards of those projects gain `skills: []`. Prod has no `messaging` block yet.
  - Two ledger rows in `docs/rollout.md`.
- **Code.**
  - new `src/skills.ts` (scanner and frontmatter parser) and `src/messaging/skills.ts` (what a card offers, the invocation);
  - `src/project.ts` (`repoSkillDirs`, `skillOrigins`), `src/claudeSession.ts` (`addDirs`), `src/tasks.ts`, `src/turn.ts`, `src/config.ts` (`REPO_SKILLS`), `src/facts.ts` (`project_skills`);
  - in `src/messaging/`: `a2a.ts`, `protocol.ts`, `config.ts`, `records.ts`, `service.ts`, `tools.ts`, `audit.ts`, `events.ts`, `runtime.ts`;
  - cli-probe: scenario `files`, and two exploratory scenarios, `add-dir-loads-skills` and `skill-slash-via-stdin`.
- **Config.** `REPO_SKILLS` (installation) and `messaging.skills` (project).
- **Data.** A new fact, `project_skills`. Task records gain an optional `skill`.
