# Tasks

## 1. Groundwork (no product code)

- [ ] 1.1 Test tenant (ours, named in the overlay): confirm a Teams-licensed owner account, custom app upload allowed, a test team with a project channel, two guests from other tenants, and an Azure subscription for the bot resource. Verify: a guest posts in the test channel.
- [ ] 1.2 Register the single-tenant Entra app + Azure Bot (Teams channel) in the test tenant; ids and the secret go to the home installation's runtime dir, the obfuscated tenant and app ids to `scripts/public-guard.txt`; `docs/teams.md` describes the steps with placeholders. Verify: Azure "Test in Web Chat" reaches the endpoint once 2.2 is up.
- [ ] 1.3 Pick the home tunnel (Dev Tunnels vs cloudflared) after a trial; record the choice and its user unit. Verify: `curl -X POST https://<tunnel>/api/messages` returns 401 from a stub.
- [ ] 1.4 Pin `@microsoft/teams.apps` (exact version ≥ 2 weeks old, license checked); record in design D1. Verify: version and date in D1.
- [ ] 1.5 SDK spike in a scratch worktree (throwaway): echo bot with a card update, a dialog, a targeted message, a proactive post into a channel thread, a `/status` message in 1:1 and after `@Aven`, a file in 1:1 and in a channel, RSC thread replies without mention. Record findings in design D4, D5, D7. Verify: each item noted as works / does not.

## 2. PR 1 — Teams driver core (bucket 3 by construction)

- [ ] 2.1 `orch teams` in `src/cli.ts`; `teams` config block (`TEAMS_APP_ID`, `TEAMS_APP_SECRET`, `TEAMS_TENANT_ID`, `TEAMS_PORT`, `TEAMS_STATUS_MIN_MS`, `TEAMS_OPERATORS`, `TEAMS_TARGETED`), validated only by `orch teams`. Verify: config tests for absent / partial / full; `orch slack` ignores the block.
- [ ] 2.2 `src/chat/teams/` server: `/api/messages`, token validation, tenant check, inbound normalization, `teamsRefs` in `state.json`, digest keys. Verify: tests with a stubbed SDK (other tenant, missing token → 401, guest accepted); key helpers pass `isThreadKey` / `slugOfBase`; a test that only `src/chat/teams/` imports the SDK.
- [ ] 2.3 `teamsformat.ts` (markdown conversion, splitter) and `teamscards.ts` (status, answer, question, picker views). Verify: golden tests; split parts concatenate to the input.
- [ ] 2.4 Teams outbound: post/update with coalescing and Retry-After, markSeen as typing, permalink deep links, proactive thread creation. Verify: fake-clock test (50 updates in 1 s → ≤ 1 intermediate + final).
- [ ] 2.5 `teamsChannel` in `projects.ts`; mentions, thread replies (RSC), 1:1 with picker, `!` notes, Cancel / Show steps / Restart, questions, recovery. Verify: core scenarios from the spec run against a fake Teams transport.
- [ ] 2.6 Manifest template (`infra/teams/manifest.template.json`: team + personal scopes, RSC `ChannelMessage.Read.Group`, `supportsFiles`, command list, placeholder ids) and `npm run teams:package -- <runtime dir>` that renders it with the installation's ids into that runtime dir and zips it. Verify: Developer Portal validation passes; `scripts/public-guard.sh` clean.
- [ ] 2.7 Ledger row "Teams installation mode", gate `orch teams`; PR. Verify: CI green.

## 3. PR 2 — Teams parity rest (bucket 3)

- [ ] 3.1 Commands: `/verb` parsing per D4, `postPrivate` via targeted messages with 1:1 fallback, private questions in 1:1. Verify: every verb scenario from the spec against the fake transport.
- [ ] 3.2 Answer extras: feedback buttons with tally refresh, reason dialog, Session panel dialog, PR links, background / long-task cards. Verify: card snapshots + feedback record test.
- [ ] 3.3 Files per D7 (1:1 download URL, channel images, Graph for documents). Verify: fixture activities for each kind reach `attachments.ts`.
- [ ] 3.4 Background deliveries: routines, dream, housekeeping, auto-review, autofix Fix, YouTrack card + Full ticket + Report dialogs + owner mentions, dispatch, alerts. Verify: the pollers scenarios of `chat-driver-interface` task 4.1 replayed against the Teams driver.
- [ ] 3.5 Access with Entra ids, operators and team owners as admins. Verify: `access` tests with Teams ids.
- [ ] 3.6 Home card from the shared cheat-sheet source, sent on personal install and `/home`. Verify: card snapshot; Slack `homeBlocks` snapshot unchanged.
- [ ] 3.7 `docs/teams.md` (model, registration, env, endpoint, tunnel, unit `coach-aven-teams`, `SANDBOX_NAME_PREFIX`, binding, guests, parity matrix differences for users); README pointer; ledger row; PR. Verify: CI green.

## 4. Canary

- [ ] 4.1 Second home installation in the test tenant bound to the canary project; run every spec scenario with a member and a guest, including restart mid-turn and a queued message across a restart. Verify: scenarios ticked in the PR; the Slack home bot shows no regression for 2 days.
