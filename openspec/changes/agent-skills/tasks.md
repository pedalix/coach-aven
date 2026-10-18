## 0. Order

- [x] 0.1 The MODIFIED requirements ("Discovery through agent cards", "Agent tools mirror A2A operations", "Terminal states are reported") carry the text of `hub-open-network` and `retire-agent-dispatch` as merged (#40–#44). Verify: `openspec validate agent-skills --strict`.
- [ ] 0.2 Archive in order: `agent-messaging` → `hub-open-network` → `retire-agent-dispatch` → `agent-skills`. Verify: each `openspec archive`, then `openspec validate --all --strict`.

## 1. Repo skills for multi-repo projects (bucket 1)

- [x] 1.1 `src/config.ts`: `REPO_SKILLS`, on unless `0`/`false`/`off`/`no` (`repoSkillsEnv`). Verify: `src/config.test.ts` ("REPO_SKILLS — on unless…").
- [x] 1.2 `src/project.ts`: `repoSkillDirs` (each checkout of a multi-repo project; none for a single repo or with the switch off) and `skillOrigins` (where the session loads skills). Verify: `src/project.test.ts`.
- [x] 1.3 `src/claudeSession.ts`: `addDirs` → `--add-dir <dirs…>` last on the spawn line; `src/tasks.ts` passes them to every session it opens. Verify: `src/claudeSession.test.ts` ("repo skills — … none → byte-identical"), and the existing spawn-line tests unchanged.

## 2. Finding skills

- [x] 2.1 `src/skills.ts`: the scan shell (frontmatter only, per origin, with the commit), the pure frontmatter parser (scalars, quoted, block, continued, block and flow lists), `skillFromFrontmatter` (name fallback, caps, malformed keys as problems), `parseSkillsScan` (origins, provenance, clashes). Verify: `src/skills.test.ts`.
- [x] 2.2 `src/facts.ts`: the `project_skills` fact and `projectSkills()`; `prepareChat` scans a project whose card offers skills (`messaging.skills` set, passed by `src/turn.ts`). Verify: `src/skills.test.ts` ("scanProjectSkills — records the fact…; a failed scan keeps the previous fact").

## 3. Exposure and cards

- [x] 3.1 `src/messaging/config.ts`: `messaging.skills` is a list of skill names or `"*"`. Verify: `src/messaging/config.test.ts`.
- [x] 3.2 `src/messaging/a2a.ts`: `AgentSkill {id, name, description, tags, examples?}`, caps, the required `AgentCard.skills`; `parseCard` drops malformed skills and reads a card without the field as `[]`. Verify: `src/messaging/a2a.test.ts`.
- [x] 3.3 `src/messaging/skills.ts`: `exposedSkills` (none by default, a list, `*`, never scanned, missing, clashing withheld) and `invokeSkill`. Verify: `src/messaging/skills.test.ts`.
- [x] 3.4 `src/messaging/service.ts`: cards carry the offered skills; `skills.missing` and `skills.withheld` are logged once per project and name; the composition root reads the fact (`src/messaging/runtime.ts`). Verify: `src/messaging/service.test.ts` ("skills — the card offers exactly…", "no allowlist…", "a listed name the scan did not find…", "never scanned yet…").

## 4. A task names a skill

- [x] 4.1 `src/messaging/protocol.ts`: `Payload.skill?`, validated, additive. `src/messaging/records.ts`: `OutTask.skill?`, `InTask.skill?`. Verify: `npm run typecheck`, and the service tests below.
- [x] 4.2 `send_message` takes `skill` (`src/messaging/tools.ts`). A local target refuses at once with the offered ids and records nothing; the skill rides the sealed payload. Verify: `src/messaging/service.test.ts` ("a local task naming a skill the target does not offer…", "an agent without skills works as today…").
- [x] 4.3 `onAsk`: after acceptance, domain and depth, before the budget: `rejected: unknown skill` with the offered ids; a sender not accepted learns nothing. Verify: `src/messaging/service.test.ts` ("from another installation: an unknown skill is rejected…", "a sender this agent does not accept learns nothing…").
- [x] 4.4 A task with a skill starts its shadow conversation with `/<skill> ` and the plain frame; both task records store the skill; `/aven asks` shows it. Verify: `src/messaging/service.test.ts` ("a local task naming an offered skill…", "from another installation, an offered skill…"), `src/messaging/audit.test.ts` ("a task that asked for a skill shows it…").

## 5. cli-probe

- [x] 5.1 Scenario `files`: seeded into the CLI's working directory before it starts, by the local and the sandbox transport; paths stay inside it. Verify: `src/cliprobe/runner.test.ts` ("a scenario's `files` are seeded…"), `src/cliprobe/ctx.test.ts` ("seedPathOk…").
- [x] 5.2 Exploratory scenarios `add-dir-loads-skills` and `skill-slash-via-stdin` (`src/cliprobe/scenarios/skills.ts`). Verify: `npm run cli-probe -- list`.
- [ ] 5.3 Record both on every probed version (needs `CLI_PROBE_TOKEN`, on the operator's machine), then make them contract scenarios. Verify: `npm run cli-probe -- run add-dir-loads-skills skill-slash-via-stdin --cli 2.1.292` (and 2.1.282), then `src/cliprobe/gate.test.ts`. Until then the facts rest on the manual verification in design.md (Context).

## 6. Docs and rollout

- [x] 6.1 `docs/agent-messaging.md` (skills: cards, `messaging.skills`, `send_message` `skill`, `unknown skill`, a `SKILL.md` example with `tags` and `examples`, duplicates, before the first scan), `docs/runtime-config.md` (`REPO_SKILLS`), `docs/project-facts.md` (`project_skills`), `docs/cli-probe.md` (scenario files, the two scenarios). Reviewed in the PR.
- [x] 6.2 `docs/rollout.md`: two rows — repo skills (bucket 1, `REPO_SKILLS=0` kill switch, prod changes at the tag) and skills in messaging (bucket 2). No Slack command or interaction changes, so the Home tab needs no update. Verify: `scripts/public-guard.sh` in CI.

## 7. Canary

- [ ] 7.1 On a canary installation, list a project skill in `messaging.skills`, `/aven reload`, and check from the home tenant agent: `agents()` shows it; a task naming it starts with the slash invocation; a task naming an unknown skill is rejected with the list. Recorded in the PR or the ledger row.
- [ ] 7.2 After the tag: on prod, a multi-repo project's session lists its repos' skills; watch for skills the agent starts using on its own.
