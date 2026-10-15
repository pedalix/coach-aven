# Proposal

> **Status: deferred (2026-10-15).** Planned and agreed; implementation waits until `chat-driver-interface` is merged and the test tenant's admin access is restored. Decisions taken in review: Teams SDK (`@microsoft/teams.apps`) directly rather than a multi-platform wrapper (fewer beta dependencies, our interface already plays that role); `@Aven /verb` commands; targeted messages with 1:1 fallback; RSC consent in the MVP; admins = installation operators + team owners.

## Why

Clients that live in Microsoft Teams cannot use CoachAven without a Slack workspace. `chat-driver-interface` (prerequisite) puts a platform-neutral core and a chat driver interface in front of everything chat-related, with Slack as its first implementation. This change adds the Teams chat driver: an installation started with `orch teams` serves its projects through Teams, covering as much of the Slack feature set as Teams allows.

## The model

As defined in `chat-driver-interface`: one installation runs one chat driver. A Teams installation has its own checkout, `.env`, `state.json`, service, ops overlay and `SANDBOX_NAME_PREFIX`.

## What Changes

- **Teams chat driver** (`src/chat/teams/`, the only code allowed to import the Teams SDK `@microsoft/teams.apps`), run by `orch teams`, with feature parity as defined by the parity matrix in `design.md`:
  - channel @mention starts a thread turn; replies in that thread continue the session without a re-mention; 1:1 chat works like a Slack DM with a project picker;
  - live status card with Cancel, Show steps, Restart session; background / long-task follow-ups; answer with feedback buttons, Session panel, PR links;
  - agent questions as cards; dispatch Send/Dismiss; autofix Fix button; YouTrack ticket card, Full ticket and Report-to-YouTrack dialogs;
  - every `/aven` verb as a bot command (`@Aven /status`, `/status` in 1:1), private answers as Teams targeted messages, falling back to the user's 1:1 chat;
  - routines, dreams, housekeeping, auto-review, autofix and the YouTrack poller deliver into the project's Teams channel;
  - inbound files (images and documents in channels and 1:1);
  - a Home card (on install and on `/home`) built from the same cheat-sheet as the Slack App Home tab;
  - restart recovery into the original Teams thread;
  - single Entra tenant per installation; external people join as guests of that tenant.
- Docs: `docs/teams.md`, README pointer, rollout ledger rows.

## Out of scope (follow-up changes)

- The interface and the Slack refactor (`chat-driver-interface`).
- One installation running two drivers; one project reachable from two platforms.
- A channel-binding settings page (wanted for Slack and Teams alike; Teams binds by channel id in config for now).
- A Teams static tab (web page) as Home; the Home card covers it.
- Several Entra tenants per installation, AppSource/store distribution, Teams shared channels (cross-tenant direct connect).
- Teams streaming-message protocol, meetings, voice/video files.

## Capabilities

### New Capabilities
- `teams-chat-driver`: people reach a project's agent from Microsoft Teams with the Slack feature set mapped per the parity matrix, in an installation that runs the Teams chat driver.

### Modified Capabilities
None.

## Impact

- Requires `chat-driver-interface` merged (all four PRs).
- Code: new `src/chat/teams/` (driver, server, `teamscards.ts`, `teamsformat.ts`); `cli.ts` (`teams`), `config.ts` (`teams` block), `projects.ts` (`teamsChannel`), `state.ts` (Teams conversation references).
- Dependencies: `@microsoft/teams.apps` (exact version pinned in the tasks). External: single-tenant Entra app + Azure Bot resource (needs an Azure subscription) in a test tenant we own, a Teams app package (template in this repo, real ids in the installation's ops overlay), a public HTTPS endpoint (prod: nginx; home: a tunnel), Graph application permissions for channel files.
- **Rollout bucket 3 by construction**: the driver runs only under `orch teams`, which no existing installation starts. Two PRs (core, then the rest of the parity matrix), ledger row each.
- Slack untouched. The Teams Home card renders the same cheat-sheet source as the Slack App Home tab.
