# Proposal

## Why

CoachAven can only be reached from Slack: the turn engine, the event handlers, the `/aven` router, the pollers and every renderer talk to Bolt directly. Further chat clients are planned (Microsoft Teams in `teams-chat-driver`, deferred; a self-hosted chat in `web-chat-driver`, deferred). Both need the same thing first: a platform-neutral core and a **chat driver** interface it talks to, with Slack as the first implementation. Doing this once, as its own change, keeps the two follow-ups small and lets them proceed in any order.

"Chat driver" is deliberately distinct from the existing **sandbox driver** (`src/driver.ts`): one is where people talk, the other is where the agent runs.

## The model: one installation, one chat driver

An **installation** is one deployed bot: its checkout, its `.env`, its `state.json`, its service, its ops overlay. Each installation runs exactly ONE chat driver, chosen by the command that starts it (`orch slack` today; `orch teams`, `orch web` later). A project is served by the installation whose registry lists it, so a project has exactly one chat client. Two installations that share a sandbox backend use different `SANDBOX_NAME_PREFIX` values, as dev and prod already do.

## What Changes

- **Chat driver interface** (`src/chat/driver.ts`): inbound events normalized into platform-neutral shapes (message, action, dialog submit, command, home opened, installed/removed), outbound operations on platform-neutral **view models** (post, update, private reply, direct message, open/update dialog, home, permalink, file fetch, mention, admin check, project channel), and a small capability declaration per driver (e.g. whether private replies are native, whether thread replies need a mention) so shared help text can adapt.
- **Platform-neutral core** (`src/chat/core/`): the logic of today's `events.ts`, `commands.ts`, pollers' delivery, dispatch and the turn engine's chat calls, with no Bolt import.
- **Slack chat driver** (`src/chat/slack/`): Bolt wiring, Block Kit rendering (`blocks.ts`), installations/OAuth, reactions, Slack files and channel name binding move behind the interface.
- **No Slack behaviour change.** Every move is pinned by recorded Slack call snapshots taken before it.

## Out of scope

- Any new chat driver (separate changes `teams-chat-driver`, `web-chat-driver`).
- Running two drivers in one installation.
- A channel-binding settings page.
- Changing any Slack text, block, timing or permission.

## Capabilities

### New Capabilities
- `chat-driver-interface`: an installation serves people through exactly one chat driver, and moving Slack behind the interface leaves every Slack interaction unchanged.

### Modified Capabilities
None.

## Impact

- Code: new `src/chat/` (interface, view models, core, Slack driver); `turn.ts`, `events.ts`, `commands.ts`, `pollers.ts`, `routinerun.ts`, `dispatchrun.ts` lose their Bolt imports; `blocks.ts`, `installations.ts`, `slackfiles.ts`, `channels.ts` move under `src/chat/slack/`; `cli.ts` gains the driver selection seam (only `slack` exists).
- Tests: a test-only recording fake Bolt and scripted scenarios covering every Slack surface; a test that only `src/chat/slack/` imports `@slack/bolt`.
- **Rollout bucket 1**, four PRs (turn path; actions, dialogs, Home; messages and commands; pollers, routines, dispatch, alerts). Each PR is an invisible refactor proven by snapshots identical before and after; ledger row per PR; tags after the usual canary window.
- No dependency changes, no config changes, no overlay changes. CLAUDE.md architecture pointers updated in the last PR.
