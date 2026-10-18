## 0. Order

- [ ] 0.1 Start only after `retire-agent-dispatch` has merged: it rewrites `wrapTask` (`src/messaging/wrap.ts`) and the tool descriptions (`src/messaging/tools.ts`). Then re-read the three requirements this change modifies, as they stand at that point: "Discovery through agent cards", "Agent tools mirror A2A operations" and "Terminal states are reported", in `openspec/changes/agent-messaging`, `hub-open-network` and `retire-agent-dispatch`, or in `openspec/specs/agent-messaging` once archived. Bring the MODIFIED blocks here up to date. Verify: `openspec validate agent-skills --strict`.
- [ ] 0.2 Archive in order: `agent-messaging` → `hub-open-network` → `retire-agent-dispatch` → `agent-skills`. Verify: each `openspec archive`, then `openspec validate --all --strict`.

## 1. Skills in the configuration and the cards

- [ ] 1.1 `src/messaging/config.ts`: validate `messaging.skills` (design S1).
  - Fields: `id` (kebab-case, unique), `name` (one line, at most 80 characters), `description` (one line, at most 300), `examples` (at most 5, one line of at most 200 each), `tags` (at most 8, kebab-case of at most 32 each).
  - At most 16 skills.
  - Errors name the project and the skill.
  - Verify: `src/messaging/config.test.ts` ("Duplicate skill id", every cap, a valid block).
- [ ] 1.2 `src/messaging/a2a.ts`: an `AgentSkill` type and `AgentCard.skills?`. `parseCard` keeps valid skills and drops malformed entries; a card without skills parses as today. Verify: `src/messaging/a2a.test.ts`.
- [ ] 1.3 `src/messaging/service.ts`, `localCards`: carry `skills` when a project declares them, and add no field otherwise. Verify: `src/messaging/service.test.ts` ("Card with skills"), with the existing card tests unchanged.
- [ ] 1.4 Remote cards through `cards` carry the skills, and `agents()` shows them with and without an argument. Verify: `src/messaging/service.test.ts` (a peer's card with skills, through the hub test transport).

## 2. A task names a skill

- [ ] 2.1 `src/messaging/protocol.ts`: `Payload.skill?`, parsed. A payload without it is valid as before (additive within version 2). Verify: `src/messaging/protocol.test.ts`.
- [ ] 2.2 `src/messaging/tools.ts`: the `send_message` schema gains an optional `skill`, and its description says to take the id from `agents`. In `sendMessage`:
  - for a local target, refuse an unknown skill at once, listing the target's skills;
  - record `skill` on the `OutTask`;
  - put it on the first message only.
  - Verify: `src/messaging/service.test.ts` ("Unknown skill in the same installation", "Skill named").
- [ ] 2.3 `onAsk`: the skill check after acceptance, domain and depth, and before the budget (design S4).
  - Answer `rejected: unknown skill` listing the declared ids. A rejected task does not count against the budget.
  - Record `skill` on the `InTask`.
  - Verify: `src/messaging/service.test.ts`:
    - "Unknown skill at a peer";
    - a sender that is not accepted learns nothing about skills;
    - a target that declares no skills rejects a named skill, with an empty list;
    - "No skill": the framing is byte-identical.
- [ ] 2.4 `src/messaging/wrap.ts`, `wrapTask`: an optional `Skill: <id> — <name>: <description>` line (design S5). Verify: `src/messaging/wrap.test.ts`, with a new golden for a named skill and the existing goldens byte-identical.
- [ ] 2.5 `src/messaging/records.ts`: `OutTask.skill?` and `InTask.skill?`. `src/messaging/audit.ts`: `/aven asks` shows ` · skill <id>`. Verify: `src/messaging/audit.test.ts`.
- [ ] 2.6 `src/messaging/events.ts`: `ask.rejected` with `reason=unknown skill`. Verify: `src/messaging/events.test.ts`.
- [ ] 2.7 `npm run typecheck` and `npm test` pass, and the turn, prompt and Slack snapshots are unchanged. No Slack surface changes, so no Home tab update.

## 3. Docs and rollout

- [ ] 3.1 `docs/agent-messaging.md`: skills on cards, `skill` on tasks, who decides, the brand-studio example, and how a release without skills behaves. Reviewed in the PR.
- [ ] 3.2 `docs/runtime-config.md`: the `messaging` row gains `skills` and its caps. `projects.config.example.json` shows one skill. Reviewed in the PR.
- [ ] 3.3 A `docs/rollout.md` ledger row: bucket 2, only projects with a `messaging` block; the configuration is additive; a project without `skills` is byte-identical. Verify: `scripts/public-guard.sh` in CI.
- [ ] 3.4 Every changed file and the PR text pass the public guard and gitleaks. Verify: CI `verify`.

## 4. Canary

- [ ] 4.1 Declare two skills for the staging installation's project in its ops repo, and `/aven reload` there. From the home tenant agent, `agents()` shows them. Recorded in the PR.
- [ ] 4.2 A task naming a declared skill completes, and its framing on the staging side names the skill. A task naming an unknown skill is rejected with the list. `/aven asks` on both sides shows the skill. Recorded in the PR.
