# Proposal

> **Status: active again (2026-10-26).** The 2026-10-15 review ("do not build our own web chat; Slack for colleagues, Mostlymatter if ever") predates the first client who needs the web: Brandnamic's account managers and copywriters test the newsletter agent and asked for a web interface rather than Teams (their own tenant needs their admin and a published app; the operator's tenant means guest accounts). Mattermost would be one more server and one more chat tool for them; one-user LLM chat UIs have no shared threads, approvals or cards. The web driver as designed below is the fit, with its scope cut to what that use needs first.

## Why

Slack and Teams both put a third party between a client and the agent: a workspace, a tenant, its admins, its licences and its UI limits. A web chat that CoachAven serves itself removes that dependency: a client gets a URL and a login, nothing to install or negotiate. It is also the driver where parity with Slack is easiest, because we render everything: private replies, dialogs, commands and files are native rather than mapped.

Built on `chat-driver-interface` (merged; the Teams driver proved it) and `multi-driver-installation` (prerequisite): the web driver is a *surface* an installation adds, not a second installation. The newsletter project moves from the Teams staging installation's Teams surface to its web surface, keeping its sandbox and its state.

## The model

As defined in `multi-driver-installation`: an installation has a default surface and may add others. `orch web` makes the web the default surface of an installation; `CHAT_SURFACES=web` adds it to a Slack or Teams installation. A project is reachable on the web when it is bound to a room (every project of the installation has one; `webRoom: false` hides it).

## What Changes

- **Web chat driver** (`src/chat/web/`): an HTTP server that serves the chat UI, a live update stream and the actions, behind an OIDC login.
- **Rooms and threads**: each project the installation serves on the web is a room. A top-level post in a room starts a thread and a turn; replies in the thread continue the session. Each user also has a private conversation per project (the Slack DM equivalent).
- **Parity in two steps.** MVP (PR 1 + PR 2): login, rooms, threads, private conversations, live status with Cancel / Show steps / Restart, background and long-task follow-ups, answers with PR links, Helped / Missed with reason dialog, Session panel, agent questions, `!` notes, `/status` `/help` `/home` `/restart` and the private-question form of `/`, file uploads, routines and every poller delivering into the project room, the ✋ held-message card of agent messaging, Home page, restart recovery, history. Rest (PR 3, when a client needs it): the remaining `/aven` verbs, YouTrack card and dialogs, autofix Fix, `/users` editing the allow-list.
- **Message history** stored by the driver on disk (Slack and Teams keep history for us; here we must).
- **Security baseline** for rendering agent output, which is untrusted: markdown rendered without raw HTML, link scheme allow-list, strict Content Security Policy, CSRF protection, HttpOnly session cookies; a security review before the first shared deployment.
- Docs: `docs/web.md`, README pointer, rollout ledger rows.

## Out of scope (follow-up changes)

- Notifications outside an open tab (e-mail, web push, mobile).
- Message editing and deletion by users; reactions; user-to-user DMs.
- A settings page for rooms and access (config file for now, like the other drivers).
- Search across rooms.
- Showing one thread on two surfaces (a conversation belongs to its surface).

## Capabilities

### New Capabilities
- `web-chat-driver`: people reach a project's agent through a web chat served by the installation, with login, rooms, threads, private conversations and the Slack feature set.

### Modified Capabilities
None.

## Impact

- Requires `multi-driver-installation` PR 1 and PR 2 merged.
- Code: new `src/chat/web/` (server, auth, history store, `webviews.ts` renderer, `webformat.ts`, static client assets); `cli.ts` (`web`), `config.ts` (`web` block), `projects.ts` (`webRoom`), `drivers.ts`.
- Dependencies: an OIDC client library and a markdown renderer with raw HTML disabled (exact packages and versions pinned in the tasks). No frontend framework or bundler.
- External: an OIDC client in the installation's identity provider — for the Teams staging installation the platform's Amazon Cognito staff pool, the accounts its people already use for the platform (instance values in the ops overlay); a public HTTPS hostname behind the installation's nginx (SSE needs proxy buffering off).
- **Rollout bucket 3 by construction**: the driver runs only as a surface named by `orch web` or `CHAT_SURFACES`, which no existing installation sets. Ledger row per PR.
- Slack untouched. The web Home page renders the same cheat-sheet source as the Slack App Home tab.
