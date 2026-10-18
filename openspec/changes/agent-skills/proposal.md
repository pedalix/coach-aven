# Proposal

> **Status: proposed 2026-10-18, reworked the same day.** Decisions taken in review:
> - **An agent's skills are its project's Claude Code skills.** The bot finds the `SKILL.md` files in the project and its repos and reads their name and description. The operator does not write skills a second time in the configuration.
> - **The receiving installation decides what each sender sees.** The project's `messaging.skills` lists the skills that may be shown at all, and nothing is shown by default. An `accept` entry may narrow that list for one sender.
> - **A task that names a skill starts with that skill.** The answering session's first message invokes the skill explicitly, so the bot decides how the task runs instead of leaving it to the prompt.
> - **An agent without skills works as today.** Its card says so (`skills: []`), and it takes general requests.
> - **Multi-repo projects load their repos' skills only when the project opts in**, through `--add-dir` for each repo. Single-repo projects already do.

## Why

Today an agent card says what an agent is, in one line. An asking agent picks its target by guessing from that line. Agents are about to specialise:
- a project agent for one codebase;
- an operator's tenant agent;
- an agent for one function, such as a brand studio that builds a brand profile from a hotel's website and designs a site from it.

The asker needs to know what each one offers. A2A's Agent Card already answers that with a list of skills, each with an id, a name and a description.

A project already has such a list. Its Claude Code skills (`.claude/skills/*/SKILL.md`) each carry a name and a one-line description, and Claude Code loads them by that description or runs one when it is named. Exposing them means one source of truth: the repo's own skill, not a second description in an ops repo that drifts from it.

Two facts, measured on the pinned CLI (2.1.292):
- **The session reports its skills** in the stream-json `system/init` frame. So the bot can know exactly which skills a session has.
- **A multi-repo project's sessions do not load their repos' skills today.** The session starts in the project folder, which only holds the repos side by side. With `--add-dir` for each repo, the repo skills load.

## What Changes

- **Finding skills.**
  - At prepare time, a scanner in the sandbox reads every `.claude/skills/*/SKILL.md` in the project folder and in each repo checkout. It records name, description and provenance (`<repo>@<commit>:<path>`) as the project fact `project_skills`.
  - The bot also records the skills each session's `init` frame reports.
  - Bundled and plugin skills are never candidates.
- **Multi-repo opt-in.** A project field `repoSkills: true` makes the bot start that project's sessions with `--add-dir <repo>` for each repo. It is off by default, so no project's spawn line changes.
- **Exposure.**
  - `messaging.skills` is an allowlist of skill names. The default is none, so a `deploy` or `release` skill never shows.
  - An `accept` entry may be an object, `{"from": "<pattern>", "skills": [...]}`. It narrows the allowlist for the senders it matches. Today's string entries stay valid and mean every exposed skill.
- **Cards.**
  - Every card carries `skills`, the A2A AgentSkill subset (`id`, `name`, `description`, `tags`), filtered for the caller.
  - An agent without skills has `skills: []`.
  - Remote cards carry the field through `cards`.
- **A skill on a task.** `send_message` takes an optional `skill`.
  - The receiving installation decides. A skill the caller may not use gets `rejected: unknown skill`, with the ids it may use.
  - A sender that is not accepted learns nothing.
  - In the caller's own installation the tool refuses at once.
- **Running it.**
  - A task with a skill starts its shadow session with the skill's slash invocation, followed by the plain task frame.
  - If the session did not load the skill, or the pinned CLI cannot run a slash invocation through stream-json input, the frame instead names the skill to use.
  - Two cli-probe contract scenarios pin both CLI behaviours.
- **Records.** The skill is stored on the task on both sides and shown by `/aven asks`. `ask.rejected` carries `reason=unknown skill`.
- **Protocol.** Additive within version 2: the card's `skills` and the sealed payload's `skill`. An older release ignores both and runs a skill-named task as a general request.

## Out of scope

These are extension notes in the design:
- routing a task by its skill to another session or another sandbox;
- permissions per skill, together with roles per sender in `accept`, enforced by the receiving bot through the sandbox permission mode;
- exposing bundled or plugin skills;
- agents that are not sandboxes, such as adapters to external A2A endpoints;
- cost per skill in `/aven asks`;
- examples and tags read from `SKILL.md` (the cards send `tags: []` and no examples for now).

## Capabilities

### New Capabilities
None.

### Modified Capabilities
- `agent-messaging`:
  - new: skills come from the project's Claude Code skills;
  - new: the receiving installation decides which skills each sender may use;
  - new: a task can name the skill it asks for;
  - changed: the receiving agent decides who may ask it (`accept` entries may carry skills);
  - changed: discovery through agent cards (cards carry skills, filtered for the caller);
  - changed: agent tools mirror A2A operations (`send_message` takes `skill`);
  - changed: terminal states (a new `rejected` reason, `unknown skill`).

  The capability comes from the `agent-messaging` change, which is not archived yet. `hub-open-network` and `retire-agent-dispatch` also modify it. The archive order is `agent-messaging` → `hub-open-network` → `retire-agent-dispatch` → `agent-skills`.

## Impact

- **Rollout.**
  - **Bucket 2 for exposure and the skill on a task.** It reaches only projects with a `messaging` block, and the configuration is additive. Cards of those projects gain `skills: []`. Prod has no `messaging` block.
  - **Bucket 2 for `repoSkills`.** It is a per-project opt-in, off by default. The spawn-line golden of a project without it stays byte-identical.
  - **The scanner runs for every project,** because facts are derived for every project. It only writes `facts/<slug>.json` and changes nothing a session sees.
  - One ledger row in `docs/rollout.md`.
- **Code.**
  - a new `src/skills.ts`: the scanner and the frontmatter parser, pure parts tested;
  - `src/tasks.ts`: the scan at prepare, and `--add-dir` under `repoSkills`;
  - `src/claudeSession.ts`: the `init` skills;
  - `src/projects.ts`: `repoSkills`;
  - in `src/messaging/`:
    - `config.ts`: the allowlist and the `accept` objects;
    - `protocol.ts`: the matcher and `Payload.skill`;
    - `a2a.ts`: `AgentSkill`;
    - `service.ts`: cards per caller, `sendMessage`, `onAsk`, the first message;
    - `tools.ts`, `wrap.ts`, `records.ts`, `audit.ts`, `events.ts`;
  - the cli-probe contract scenarios.
- **Config.** `repoSkills` per project, `messaging.skills`, and `accept` objects. `projects.config.example.json` and `docs/runtime-config.md` show them.
- **Data.** A new fact, `project_skills`. Task records gain an optional `skill`.
