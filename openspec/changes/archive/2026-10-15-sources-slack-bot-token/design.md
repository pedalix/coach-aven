# Design

## Context

`auth slack add` pastes a user token and verifies it with `auth.test` + `users.conversations`; the puller runs `users.conversations` (membership-scoped) then `conversations.history`/`replies`. Bot tokens answer the same methods for the bot user. CoachAven's multi-workspace install already stores per-workspace bot tokens (`state.json` installations), with the scopes the manifest grants. See proposal.md.

## Goals / Non-Goals

**Goals:**
- One puller, two token kinds; the record shape and the store do not change.
- The tenant decides the scope in Slack (invite / join), the allow-list stays the belt-and-braces.

**Non-Goals:**
- Reading DMs or private channels the bot was not invited to — impossible by Slack's model and not wanted.
- Enterprise Grid Discovery API / admin exports.

## Decisions

- **Token kind is detected, not configured:** `auth.test` says whether the identity is a bot (`bot_id`); the store entry records `kind: user|bot`. Alternative: a config flag — would drift from the token.
- **Reuse the installation token when the workspace is a CoachAven tenant:** `auth slack add --from-install <team_id>` copies the bot token from the installation record into the sources token store, so one install serves chat and ingest. Alternative: a second app — two installs to explain to the tenant.
- **Join is explicit and logged:** only `channels` entries (by id or name) that are public and not yet joined are joined, once per run, each join logged; `joinPublic: true` extends that to every public channel (listed first via `conversations.list`). Private channels are never joined — the log names the ones the bot cannot read.
- **The app's own messages are `is_bot`** like any integration (bots.ts already marks the bot user), so the agent's answers never become "inbound" for `unanswered` — unless the tenant lists the agent on a side, which is the people-file's call.

## Risks / Trade-offs

- [A bot joining every public channel reads like surveillance] → off by default; the tenant turns `joinPublic` on, and the join is visible as a join event in each channel.
- [Rate limits: a workspace with hundreds of channels] → `conversations.join` is Tier 3; paced like the rest, and the allow-list is the normal path.
- [Two token kinds in one store file] → the entry carries `kind`; `auth slack check` prints it.

## Migration Plan

Bucket 2. Home bot: add the Bluefin installation's bot token to the bluefin-ops token store once Bluefin's Slack admin installs the app; the allow-list then lists Bluefin-internal channel ids beside the pedalix ones (`workspaces: [T0000FAKE01, <Bluefin team>]`). Ledger row; no flag needed.
