# Tasks

## 1. The registry and rules (pure)

- [ ] 1.1 `src/grants.ts`: `CAPABILITIES` (`workflows` → `{ github: { workflows: 'write' } }`), the record type,
  `parseGrantCmd` (list / `<cap> [<n>m|<n>h]` / `<cap> off`; default 30 min, 1 min–4 h), `activeGrants`,
  `expiredGrants`, `githubExtras` (D3, D4). Verify: `src/grants.test.ts` — default and explicit durations, the 4-hour
  refusal, unknown capability listing `workflows`, `off`, re-grant replacing the end, active vs expired at a boundary,
  extras empty with no grant; `npm test`.
- [ ] 1.2 `src/state.ts`: `grants` in the state shape; `getGrants(slug)`, `setGrant`, `deleteGrant`; a file without
  `grants` reads as none. Verify: `src/state.test.ts` — round-trip through a throwaway file, restart keeps the
  record, an old file loads.

## 2. The token

- [ ] 2.1 `src/github.ts`: `getGitHubToken(cfg, repos, extra?)` requests `AGENT_PERMISSIONS ∪ extra` through
  `intersectPermissions` (D6). Verify:
  `src/github.test.ts` — no `extra` requests exactly `{contents: write, pull_requests: write, checks: read,
  metadata: read}` (the bucket-2 proof); with `workflows` it is added; an installation without `workflows` drops it
  and the mint still succeeds.
- [ ] 2.2 `src/tasks.ts`: the three sandbox seeds pass `githubExtras(grants, slug, now)`; the orchestrator's own mints
  (pollers, `src/sources/run.ts`) pass nothing. Verify: `src/tasks.wiring.test.ts` — a turn for a project with a
  `workflows` grant seeds a token minted with `workflows: write`; without one, or after its end time, the mint call
  is unchanged.

## 3. The command

- [ ] 3.1 `src/chat/core/commands.ts`: `/aven grant` — list for viewers (`grant` in `VIEWER_VERBS`); grant and `off`
  for operators only (the `/aven reload` check); project resolved from the channel, refused without one; on grant and
  `off` a private reply plus a channel post (`d.post`) naming project, capability, end time and actor (D2, D7). Verify:
  recorded snapshots in `src/chat/slack/commands.record.test.ts` (`grant-list-none`, `grant-workflows`,
  `grant-workflows-2h`, `grant-too-long`, `grant-unknown`, `grant-not-operator`, `grant-unbound`, `grant-off`) via
  `UPDATE_SNAPSHOTS=1 npm test`, then `npm test` green without it.
- [ ] 3.2 The grant reply's effect check (D9): not App auth → "changes nothing here"; installation lacking the
  permission → "an organization owner must approve it". Verify: snapshots `grant-token-mode` and
  `grant-install-lacks` in the same test, with the installation fetch stubbed.

## 4. The end of a grant

- [ ] 4.1 One end function (D8): remove the record and post the end notice (new turns without workflows; tokens
  already minted expire within the hour) through the record's tenant and surface; nothing touches the sandbox. `off`
  (3.1) calls it too. Verify: unit test — the record is gone, one notice is posted, no driver call reaches a sandbox.
- [ ] 4.2 `src/pollers.ts`: the expiry check in the existing 60-second loop. Verify:
  `src/chat/slack/pollers.record.test.ts` — a grant past its end produces the end notice in its channel and leaves no
  record; one not yet due produces nothing.

## 5. Surfaces and docs

- [ ] 5.1 Home tab: one line for `/aven grant workflows [30m]` in `homeBlocks` (`src/chat/slack/blocks.ts`), and the
  verb in `src/chat/teams/teamshome.ts` and `src/chat/web/webhome.ts`. Verify: `src/chat/slack/blocks.test.ts` and the
  Teams/web Home tests (they fail when a Slack Home verb is missing); re-snapshot on purpose.
- [ ] 5.2 `docs/commands.md`: the verb, who may use it, default and maximum, that every turn of the project gets it,
  and how it ends. Verify: read-through; `scripts/public-guard.sh` passes (fictional names only).
- [ ] 5.3 `docs/rollout.md`: ledger row — "Temporary project grants (OpenSpec `project-grants`): `/aven grant
  workflows [dur]`", gate "none — bucket 2, no grant = today's token", watch: the end notice arrives and the next
  turn's push of a workflow change is refused again. Verify: the row is in the PR diff.

## 6. Verification

- [ ] 6.1 `npm run typecheck` and `npm test` green; `openspec validate project-grants --strict` passes.
- [ ] 6.2 On an installation in App mode, after `ship`: grant `workflows` for a few minutes in a project's channel, have
  the agent push a branch that adds `.github/workflows/noop.yml` (succeeds), wait for the end notice, then start a new
  turn and confirm a push of a workflow change is refused again. Record the date in the ledger row.

## Workflow follow-up

- After merge and the canary check: `/openspec-archive-change project-grants`, which adds `openspec/specs/project-grants/`.
