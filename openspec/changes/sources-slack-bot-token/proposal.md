# Proposal

## Why

Today the Slack puller reads with a USER token (xoxp): everything the person is a member of, scoped by the allow-list (`sources-slack-channel-allowlist`). That fits a personal store, and it fits Bluefin's shared channels inside Owen's workspace. It does not fit Bluefin's own workspace: Owen is not in it, inviting him costs a seat and makes the store "what Owen sees", and no human account is the right owner of a tenant's scope. Slack's model for this is the app itself: install CoachAven in the workspace, the bot joins public channels on its own (`channels:join`), gets invited to private ones, and never sees DMs. The store's scope becomes the bot's membership — visible to everyone in Slack, decided by the tenant.

## What Changes

- `sources.slack` workspaces may carry a BOT token (`xoxb`, stored by `auth slack add --bot` or taken from the CoachAven installation record of that workspace when the app is installed there).
- With a bot token the puller lists the bot's conversations (`users.conversations` works for bots), joins public channels listed in `channels` that it is not in yet (`conversations.join`, needs `channels:join`), and reads history of what it is a member of. Private channels are read only when the bot was invited.
- Optional `sources.slack.joinPublic: true` lets the bot join EVERY public channel of the workspace (the "see everything public" mode for a tenant that wants it); default off — the allow-list decides.
- `auth slack check` reports the token kind, the bot's membership and which listed channels it cannot read (not a member, private).
- Docs: `docs/sources.md` (token kinds, the recommended tenant setup: install the app, invite it; what Slack Connect still covers), the manifest's bot scopes (`channels:history`, `groups:history`, `channels:read`, `groups:read`, `channels:join`, `users:read`) — already granted for the prod app (`slack-app-manifest.json`), verified before use.

## Capabilities

### New Capabilities
- `sources-slack-bot-access`: a workspace's Slack conversations pulled through the app's own bot identity, scoped by its membership.

### Modified Capabilities
- `sources-slack-scope`: `channels` entries may name public channels the bot is not in yet — it joins them.

## Impact

- `src/sources/slack/auth.ts` (token kind), `src/sources/slack/client.ts` (no change in calls), `src/sources/slack/pull.ts` (join step, membership-aware skip reasons), `src/sources/slack/normalise.ts` (author = bot's view; `is_bot` for the app's own messages), `docs/sources.md`, `docs/rollout.md` row.
- Rollout bucket 2: a `xoxp` entry behaves exactly as today; the join step runs only for a bot token.
- Prerequisite for the Bluefin-workspace layer of the access model (plan v3.1 answer, 2026-10-14): keep the pedalix-created `#bluefin-aven-*` channels as they are; add the Bluefin installation for Bluefin's internal channels.
