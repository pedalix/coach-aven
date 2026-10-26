# Proposal

> **Status: active (refreshed 2026-10-16).** Planned 2026-10-15, deferred while the test tenant was locked; everything it waited for now exists: `chat-driver-interface` is merged and archived, `ops-overlays` ships the `infra/teams/` Terraform module, and the first Teams installation (an operator's staging host, its bot identity and the app in that tenant's catalog) is up and waiting for this driver. Decisions taken in review: Teams SDK (`@microsoft/teams.apps`) directly rather than a multi-platform wrapper; `@Aven /verb` commands; targeted messages with 1:1 fallback; RSC consent in the MVP; admins = installation operators + team owners; **two PRs, the first one usable in Teams on its own** so the driver can be tried before the parity tail lands.

## Why

Clients that live in Microsoft Teams cannot use CoachAven without a Slack workspace. `chat-driver-interface` put a platform-neutral core and a chat driver interface (`src/chat/driver.ts`) in front of everything chat-related, with Slack as its first implementation. This change adds the Teams chat driver: an installation started with `orch teams` serves its projects through Teams, covering as much of the Slack feature set as Teams allows.

## The model

As defined in `chat-driver-interface`: one installation runs one chat driver. A Teams installation is its own ops overlay (`infra/<slug>/`, OpenSpec `ops-overlay`): its own host, `.env`, `state.json`, service and sandboxes. Its bot identity and app package come from the `infra/teams/` module (`teams-bot-infra`); the driver needs only the module's three outputs in `.env`.

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
- **Deploy tooling knows the driver**: `deploy.env` names the installation's chat driver (`CHAT_DRIVER=slack|teams`, default `slack`); `deploy.sh install` renders it into the unit and the health check waits for that driver's "bot running" line.
- Docs: `docs/teams.md` (running a Teams installation end to end: module → overlay → `.env` → deploy), README pointer, rollout ledger rows.

## Out of scope (follow-up changes)

- One installation running two drivers; one project reachable from two platforms.
- A channel-binding settings page (wanted for Slack and Teams alike; Teams binds by channel id in config for now).
- A Teams static tab (web page) as Home; the Home card covers it.
- Several Entra tenants per installation, AppSource/store distribution, Teams shared channels (cross-tenant direct connect).
- Teams streaming-message protocol, meetings, voice/video files.
- The operator's own rollout (which host, which tenant, which first project) — the installation's ops repo.

## Capabilities

### New Capabilities
- `teams-chat-driver`: people reach a project's agent from Microsoft Teams with the Slack feature set mapped per the parity matrix, in an installation that runs the Teams chat driver.

### Modified Capabilities
- `ops-overlay`: the overlay's `deploy.env` names the chat driver the service runs; install and the deploy health check follow it.

## Impact

- Code: new `src/chat/teams/` (`app.ts` composition root, `driver.ts`, `server.ts`, `events.ts`, `cards.ts`, `format.ts`, `keys.ts`); `src/chat/drivers.ts` (`CHAT_DRIVERS` gains `teams`), `src/cli.ts` (`teams`), `src/config.ts` (`teams` block, validated only by `orch teams`), `src/projects.ts` (`teamsChannel`), `src/state.ts` (Teams conversation references), `src/chat/imports.test.ts` (the SDK import rule). `infra/deploy/deploy.sh`, the unit template, `ops.example/deploy.env.example`.
- Dependencies: `@microsoft/teams.apps` **2.1.0** (2026-09-16, MIT, Node ≥ 22.12; brings `express` 5, `jsonwebtoken`, `jwks-rsa`, `@azure/msal-node`). External: the `infra/teams` module's outputs, a host whose `https://<host>/api/messages` reaches the driver (nginx → loopback `TEAMS_PORT`), Graph application permission for channel documents (PR 2).
- **Rollout bucket 3 by construction**: the driver runs only under `orch teams`, which no existing installation starts; `CHAT_DRIVER` absent = `slack` = today's unit and health check (test pins it). Two PRs, ledger row each.
- Slack untouched. The Teams Home card renders the same cheat-sheet source as the Slack App Home tab.
