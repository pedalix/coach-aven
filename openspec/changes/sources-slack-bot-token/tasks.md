# Tasks

## 1. Token kinds

- [ ] 1.1 `auth slack add` detects the identity kind from `auth.test` (`bot_id` → bot) and records `kind` on the workspace entry; `auth slack add --from-install <team_id>` copies the CoachAven installation's bot token; `auth slack check` prints the kind; verify with auth tests (user, bot, from-install missing).

## 2. Puller

- [ ] 2.1 Join step before `listConversations` for bot entries: listed public channels not yet joined (`conversations.join`), `joinPublic` → every public channel via `conversations.list`; each join logged; verify with a fake-client test (joins only what is listed/public, never private, never for a user token).
- [ ] 2.2 Skip reasons: a listed private channel the bot is not in is logged once per run as unreadable; verify in the same test.

## 3. Docs and rollout

- [ ] 3.1 `docs/sources.md` (token kinds, the tenant setup: install → invite/join, what Slack Connect still covers, scopes required), manifest check, `docs/rollout.md` row (bucket 2); verify typecheck + tests.
- [ ] 3.2 Canary: once the app is installed in Bluefin's workspace, bluefin-ops lists one Bluefin-internal public channel; the log shows the join and `scope: n of m`; the store gains the channel and no DM.
