## 0. Order

- [x] 0.1 The MODIFIED requirements ("Discovery through agent cards", "Agent tools mirror A2A operations", "Terminal states are reported") carry the text of `hub-open-network` and `retire-agent-dispatch` as merged (#40–#44). Verify: `openspec validate agent-skills --strict`.
- [ ] 0.2 Archive in order: `agent-messaging` → `hub-open-network` → `retire-agent-dispatch` → `agent-skills`. Verify: each `openspec archive`, then `openspec validate --all --strict`.

## 1. Repo skills for multi-repo projects (bucket 3, `REPO_SKILLS=1`)

- [x] 1.1 `src/config.ts`: `REPO_SKILLS`, on only with exactly `1` (`repoSkillsEnv`); off by default. Verify: `src/config.test.ts` ("REPO_SKILLS — opt-in…").
- [x] 1.2 `src/project.ts`: `repoSkillDirs` (each checkout of a multi-repo project with `REPO_SKILLS=1`; none otherwise, never for a single repo) and `skillOrigins` (where the session loads skills). Verify: `src/project.test.ts`, `src/tasks.wiring.test.ts` (off: the multi-repo line byte-identical; on: `--add-dir` per repo; single repo unaffected).
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
- [x] 5.3 Record both on every probed version (needs `CLI_PROBE_TOKEN`, on the operator's machine), then make them contract scenarios. Verify: `npm run cli-probe -- run add-dir-loads-skills skill-slash-via-stdin --cli 2.1.292` (and 2.1.282), then `src/cliprobe/gate.test.ts`. Until then the facts rest on the manual verification in design.md (Context).
  Done 2026-10-19: recorded on 2.1.282 and 2.1.292 with an installation's subscription token handed to the probe on purpose; both hold and are contract scenarios.

## 5b. After the review of #50

- [x] 5b.1 Only what really runs is offered: the folder name is the id; `user-invocable: false` is never offered; names a CLI command takes (built-ins, and the session's `init` commands minus the project's own skills, recorded as `session_commands`) are withheld with a reason. Verify: `src/messaging/skills.test.ts`, `src/skills.test.ts` ("the folder is the id…", "user-invocable…", "recordSessionCommands…"), `src/claudeSession.test.ts` ("init commands…").
- [x] 5b.2 Nothing is offered before the first scan, for a list as for `*`. Verify: `src/messaging/skills.test.ts`, `src/messaging/service.test.ts` ("never scanned yet…").
- [x] 5b.3 The scan: a fresh nonce in every marker, odd folder names skipped unnamed, lines cut at 1000, run checked. Verify: `src/skills.test.ts` ("the scan shell, run for real…", "scanProjectSkills — … runs checked…").
- [x] 5b.4 Caps: 32 skills per card, exposed and parsed; a name of at most 64. Verify: `src/messaging/skills.test.ts`, `src/messaging/a2a.test.ts`.
- [x] 5b.5 Only a task's first message carries `skill`; a malformed received id is rejected `unknown skill`; a rejection leaves the budget untouched. Verify: `src/messaging/service.test.ts` ("a reply…", "a malformed skill id…", "an `unknown skill` rejection leaves…").
- [x] 5b.6 Wiring: both sessions openChat creates carry `--add-dir` and the init recorder (`sessionWiring`); only a project with `messaging.skills` scans. Verify: `src/tasks.wiring.test.ts`, `src/chat/slack/turn.record.test.ts` ("only a project whose card offers skills…").
- [x] 5b.7 Probe: `skill-slash-via-stdin` runs with the ledger flags; `add-dir-loads-skills` with two absolute dirs (`{work}`). Verify: `src/cliprobe/runner.test.ts` ("`{work}` in a scenario's extra args…").

- [x] 5b.8 `messaging.skills` entries: names, `*` globs, `!` exclusions applied after inclusions; `"*"` is `["*"]`; strict validation at load; withheld skills stay withheld. Verify: `src/messaging/skills.test.ts` ("patterns — …", "isSkillPattern…"), `src/messaging/config.test.ts` ("skills: names and `*` globs…", "a bad skill entry fails the load…").

- [x] 5b.9 The re-review: the CLI's own names per pinned version come from the probe's recorded bare session (`src/messaging/clinames.ts`), never subtracted, the same set on the card and the task check; patterns match with a linear wildcard matcher and runs of `*` collapse; frontmatter with Windows line endings parses. Verify: `src/messaging/skills.test.ts` ("a project skill named like a CLI command (`schedule`)…", "cliOwnNames…", "wildcardMatch — the worst patterns…"), `src/messaging/service.test.ts` ("… `schedule` is neither on the card nor accepted on a task…"), `src/skills.test.ts` ("CRLF…"), `src/messaging/config.test.ts` ("a run of `*` is collapsed…").

## 6. Docs and rollout

- [x] 6.1 `docs/agent-messaging.md` (skills: cards, `messaging.skills`, the `"*"` warning, only what runs, `send_message` `skill`, `unknown skill`, free-text arguments, a `SKILL.md` example with `tags` and `examples`), `docs/runtime-config.md` (`REPO_SKILLS`: what a project gains, the kill-switch steps), `.env.example` (`REPO_SKILLS`), `docs/project-facts.md` (`project_skills`, `session_commands`), `docs/cli-probe.md` (scenario files, the two scenarios). Reviewed in the PR.
- [x] 6.2 `docs/rollout.md`: two rows — repo skills (bucket 3, `REPO_SKILLS=1`, off everywhere; what turning it on brings, and the steps) and skills in messaging (bucket 2). No Slack command or interaction changes, so the Home tab needs no update. Verify: `scripts/public-guard.sh` in CI.

## 7. Canary

- [x] 7.1 (done 2026-10-19 on the Teams staging installation: `messaging.skills: ["openspec-explore"]` on its project, exported and restarted; the home tenant agent's `agents()` showed the skill on the card; a task naming `future-versions` was rejected `unknown skill "future-versions" — bnamic/platform offers openspec-explore`; a task naming `openspec-explore` was recorded with its skill on both sides, the answering session scanned the repo's 11 skills and answered — completed while the asking bot was restarted mid-flight) On a canary installation, list a project skill in `messaging.skills`, `/aven reload`, and check from the home tenant agent: `agents()` shows it; a task naming it starts with the slash invocation; a task naming an unknown skill is rejected with the list. Recorded in the PR or the ledger row.
- [ ] 7.2 When an installation switches `REPO_SKILLS=1` on: a multi-repo project's session lists its repos' skills; watch for skills the agent starts using on its own.
