# Tasks

## 1. Token kinds

- [x] 1.1 `tokenKind(auth.test)` (`bot_id` → bot) recorded as `kind` on the workspace entry by `identify`; `add --bot` pastes a xoxb, `add --from-install <team_id>` copies the CoachAven installation's bot token from state.json; `check`/`list` print the kind (and `check` backfills it on old records). Tested: `auth.test.ts` (kind), the from-install-missing path throws with the install link.

## 2. Puller

- [x] 2.1 `joinPlan` (scope.ts, pure) + `WorkspaceSync.joinStep` (conversations.list → conversations.join for the plan, each join logged); `joinPublic` wired through config/run/pull; tested in `scope.test.ts` (listed public → join, member → nothing, private → unreadable, user token → nothing, joinPublic → all).
- [x] 2.2 Unreadable listed channels (private without invite / not found) are logged once per run as `unreadable: …`; history of a non-member channel stays a per-conversation skip (`not_in_channel`).

## 3. Docs and rollout

- [x] 3.1 `docs/sources.md` (scope row, token store, `add --from-install` example), manifest already grants channels:history/join/read, groups:history/read, users:read; `docs/rollout.md` row (bucket 2).
- [ ] 3.2 Canary: once the app is installed in Bluefin's workspace, bluefin-ops lists one Bluefin-internal public channel; the log shows the join and `scope: n of m`; the store gains the channel and no DM.
