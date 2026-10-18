## 0. Order

- [ ] 0.1 Before coding, re-read the four requirements this change modifies as they stand then: "The receiving agent decides who may ask it", "Discovery through agent cards", "Agent tools mirror A2A operations" and "Terminal states are reported". They live in `openspec/changes/agent-messaging`, `hub-open-network` and `retire-agent-dispatch`, or in `openspec/specs/agent-messaging` once those are archived. Bring the MODIFIED blocks here up to date. `retire-agent-dispatch` has merged (#44), so `wrapTask` and the tool descriptions are settled. Verify: `openspec validate agent-skills --strict`.
- [ ] 0.2 Archive in order: `agent-messaging` → `hub-open-network` → `retire-agent-dispatch` → `agent-skills`. Verify: each `openspec archive`, then `openspec validate --all --strict`.

## 1. Finding skills

- [ ] 1.1 `src/skills.ts`: a pure parser for a `SKILL.md` frontmatter (`name`, `description`; tolerant of other keys; a missing or invalid name yields no skill), and the fact shape `project_skills` (design S1).
  - The fact value is `[{name, description, origin, loadable, clash?}]`, with sources `<repo>@<commit>:<path>`.
  - Verify: `src/skills.test.ts` (real-shaped files, a multi-line description, no frontmatter, a clash between two origins).
- [ ] 1.2 The scan runs at prepare time, beside `scanDependencyRepos` (`src/tasks.ts`). Inside the sandbox it lists `.claude/skills/*/SKILL.md` in the project folder and in each checkout, and writes the fact; `loadable` follows design S1 and S2. It runs for every project and changes nothing a session sees. Verify: `src/skills.test.ts` (the sandbox call through the test driver), and the existing `tasks` tests unchanged.
- [ ] 1.3 `src/claudeSession.ts`, `noteCli`: keep `init.skills` on the session. When a skill the project offers is missing from it, log `skills.not.loaded`, a warning. Verify: `src/claudeSession.test.ts` (an `init` frame with and without the skill).
- [ ] 1.4 `docs/project-facts.md`: the second writer (`project_skills`), its readers (cards, the task check), and its provenance. Reviewed in the PR.

## 2. Multi-repo projects: `repoSkills`

- [ ] 2.1 `src/projects.ts`: an optional project field `repoSkills: boolean`, validated, off by default. Verify: `src/projects.test.ts`.
- [ ] 2.2 With `repoSkills`, a multi-repo project's sessions launch with `--add-dir <checkout>` for each repo, through `claudeLaunch`'s `extraArgs`. Verify: `src/claudeSession.test.ts`, the spawn-line tests. They must show:
  - the flag present for a multi-repo project with `repoSkills`;
  - no change for a single-repo project;
  - no change for any project without the field (the existing goldens are byte-identical).
- [ ] 2.3 A cli-probe contract scenario, `add-dir-loads-skills` (`src/cliprobe/scenarios/contract.ts`): a skill folder under an `--add-dir` directory appears in `init.skills`. Record it on the pinned CLI and add it to the version's report. Verify: `npm run cli-probe` on the operator's machine (live runs never run in CI), then `src/cliprobe/gate.test.ts` and the replay tests.

## 3. Exposure and cards

- [ ] 3.1 `src/messaging/config.ts`:
  - validate `messaging.skills`: kebab-case names, unique, at most 16;
  - validate `accept` objects: `{from, skills}`, where `from` is a valid string entry and every skill is in `messaging.skills`;
  - errors name the project and the entry.
  - Verify: `src/messaging/config.test.ts`.
- [ ] 3.2 `src/messaging/protocol.ts`: the matcher accepts the object form and returns which skills a matching entry allows. The union over matching entries is the caller's set (design S3). Verify: `src/messaging/protocol.test.ts`, with the existing accept tests unchanged.
- [ ] 3.3 `src/messaging/a2a.ts`: the `AgentSkill` type `{id, name, description, tags}` and the required `AgentCard.skills`. `parseCard` keeps well-formed skills and reads a card without the field as `[]`. Verify: `src/messaging/a2a.test.ts`.
- [ ] 3.4 Cards per caller. In `src/messaging/service.ts`, `localCards` and the `cards` answer carry the skills the caller may use: the allowlist, intersected with the loadable, non-clashing `project_skills`, narrowed by `accept`. A card with none carries `skills: []`. A listed but missing name logs `skills.missing`, once per scan, with its reason. Verify: `src/messaging/service.test.ts`:
  - "Nothing offered by default";
  - "Allowlisted skill";
  - "Narrowed for one sender";
  - "Listed but not found";
  - "Agent without skills";
  - "Card with skills" through the hub test transport.

## 4. A task names a skill

- [ ] 4.1 `src/messaging/protocol.ts`: `Payload.skill?`, parsed. A payload without it is valid as before (additive within version 2). Verify: `src/messaging/protocol.test.ts`.
- [ ] 4.2 `src/messaging/tools.ts`: an optional `skill` in the `send_message` schema; the description says to take it from the target's card in `agents`. `sendMessage`:
  - refuses at once, for a local target, a skill the caller may not use, listing the allowed ones;
  - records `skill` on the `OutTask`;
  - puts it on the first message only.
  - Verify: `src/messaging/service.test.ts` ("Unknown skill in the same installation", "Skill named").
- [ ] 4.3 `onAsk`: the skill check after acceptance, domain and depth, and before the budget (design S5).
  - It answers `rejected: unknown skill` with the caller's allowed ids, and a rejected task costs no budget.
  - It records `skill` on the `InTask`.
  - Verify: `src/messaging/service.test.ts` ("Unknown skill at a peer", a sender that is not accepted learns nothing, "Agent without skills").
- [ ] 4.4 Records and audit. In `src/messaging/records.ts`, `OutTask.skill?` and `InTask.skill?`. `src/messaging/audit.ts` shows ` · skill <name>`. In `src/messaging/events.ts`, `ask.rejected` carries `reason=unknown skill`, and `skills.missing`, `skills.not.loaded` and `skills.fallback` are warnings. Verify: `src/messaging/audit.test.ts`, `src/messaging/events.test.ts`.

## 5. Running the skill

- [ ] 5.1 A cli-probe contract scenario, `skill-slash-via-stdin` (`src/cliprobe/scenarios/contract.ts`): a slash invocation of a project skill, written through stream-json input with a multi-line task after it, runs the skill. The skill's body asks for a marker word, and the result carries it. Record the verdict on the pinned CLI. Verify: `npm run cli-probe` on the operator's machine, then the replay tests.
- [ ] 5.2 The first message of a skill-named task's shadow conversation is `/<skill>` on its own line, then `wrapTask(…)` unchanged (design S6). Fall back to the frame line ``Use the `<skill>` skill for this request.`` plus `skills.fallback` when:
  - the session's `init` did not list the skill; or
  - 5.1's verdict for the pinned CLI is "unsupported".

  Verify: `src/messaging/service.test.ts` ("Skill named", "Skill not loaded in the session"), and `src/messaging/wrap.test.ts` (a new golden for the fallback line; `task.txt` is byte-identical for a task without a skill).
- [ ] 5.3 `npm run typecheck` and `npm test` pass, and the turn, prompt and Slack snapshots are unchanged. No Slack surface changes, so the Home tab needs no update.

## 6. Docs and rollout

- [ ] 6.1 `docs/agent-messaging.md`. Reviewed in the PR. It covers:
  - where skills come from;
  - `repoSkills` and why it is opt-in;
  - the allowlist and `accept` objects;
  - cards per caller;
  - a skill on a task and how it runs;
  - an agent without skills;
  - how a release without this change behaves.
- [ ] 6.2 `docs/runtime-config.md` gets `repoSkills`, `messaging.skills` and the `accept` object form. `projects.config.example.json` shows one exposed skill and one narrowed entry. Reviewed in the PR.
- [ ] 6.3 A `docs/rollout.md` ledger row:
  - bucket 2: exposure reaches only projects with a `messaging` block, and `repoSkills` is a per-project opt-in, off by default;
  - cards of messaging projects gain `skills: []`;
  - what to watch after turning `repoSkills` on: skills the agent starts using in people's sessions, and `skills.*` warnings in Sentry.

  Verify: `scripts/public-guard.sh` in CI.
- [ ] 6.4 Every changed file and the PR text pass the public guard and gitleaks. Verify: CI `verify`.

## 7. Canary

- [ ] 7.1 On the staging installation, expose one repo skill of its project (`messaging.skills`, plus `repoSkills` if the project has several repos) and `/aven reload`. From the home tenant agent, `agents()` shows the skill with its `SKILL.md` description. Recorded in the PR.
- [ ] 7.2 Record in the PR:
  - a task naming the skill completes, and the answering transcript starts with the slash invocation;
  - a task naming an unknown skill is rejected with the allowed list;
  - `/aven asks` on both sides shows the skill.
