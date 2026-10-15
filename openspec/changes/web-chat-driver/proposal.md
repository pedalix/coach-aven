# Proposal

> **Status: deferred (2026-10-15), likely superseded.** Review conclusion: do not build our own web chat. Findings from the search for ready-made options:
> - Lightweight self-hosted chats (Campfire, Tinode, Matrix servers, Zulip) lack the bot interactivity our UX relies on: buttons, ephemeral replies, dialogs, threads together.
> - LLM chat UIs (Open WebUI, LibreChat, the Vercel Chat SDK web adapter) are one-user-to-bot; no shared rooms or buttons.
> - Agent workspaces (open-tag, zano) bundle their own agent orchestrator, have no interactive messages, and are young; useful as UX references only.
> - If we need a chat of our own, the candidate is **Mostlymatter** (Framasoft's Mattermost fork without the v11 user/history limits): Slack-like bot API (threads, ephemeral posts, buttons, dialogs, slash commands), mobile apps, mature. A driver for it would be a near-copy of the Slack driver. That would be a new change, `mattermost-chat-driver`.
> - For a quick proof of concept with colleagues, Slack itself is used: the app is installed into their workspace through the existing multi-workspace support, or a separate app from the manifest gets its own installation.
>
> The design below is kept as the reference for what an own web chat would have cost.

## Why

Slack and Teams both put a third party between a client and the agent: a workspace, a tenant, its admins, its licences and its UI limits. A web chat that CoachAven serves itself removes that dependency: a client gets a URL and a login, nothing to install or negotiate. It is also the driver where parity with Slack is easiest, because we render everything: private replies, dialogs, commands and files are native rather than mapped.

Built on `chat-driver-interface` (prerequisite): the core already talks to a chat driver; this change adds the web implementation.

## The model

As defined in `chat-driver-interface`: one installation runs one chat driver. A web installation (`orch web`) has its own checkout, `.env`, `state.json`, service, ops overlay and `SANDBOX_NAME_PREFIX`, and its own hostname.

## What Changes

- **Web chat driver** (`src/chat/web/`), started by `orch web`: an HTTP server that serves the chat UI, a live update stream and the actions, behind an OIDC login.
- **Rooms and threads**: each project the installation serves is a room. A top-level post in a room starts a thread and a turn; replies in the thread continue the session. Each user also has a private conversation per project (the Slack DM equivalent).
- **Full Slack parity** where the concept exists: live status with Cancel / Show steps / Restart, background and long-task follow-ups, answers with PR links, Helped / Missed with reason dialog, Session panel, agent questions, `!` notes, every `/aven` verb typed as `/verb` in the composer with private replies visible only to the caller, routines and every poller delivering into the project room, YouTrack card and dialogs, autofix Fix, dispatch Send / Dismiss, file uploads, access allow-list, Home page, restart recovery.
- **Message history** stored by the driver on disk (Slack and Teams keep history for us; here we must).
- **Security baseline** for rendering agent output, which is untrusted: markdown rendered without raw HTML, link scheme allow-list, strict Content Security Policy, CSRF protection, HttpOnly session cookies.
- Docs: `docs/web.md`, README pointer, rollout ledger rows.

## Out of scope (follow-up changes)

- Notifications outside an open tab (e-mail, web push, mobile).
- Message editing and deletion by users; reactions; user-to-user DMs.
- A settings page for rooms and access (config file for now, like the other drivers).
- Running the web driver beside Slack or Teams in one installation.
- Search across rooms.

## Capabilities

### New Capabilities
- `web-chat-driver`: people reach a project's agent through a web chat served by the installation, with login, rooms, threads, private conversations and the Slack feature set.

### Modified Capabilities
None.

## Impact

- Requires `chat-driver-interface` merged.
- Code: new `src/chat/web/` (server, auth, history store, `webviews.ts` renderer, `webformat.ts`, static client assets); `cli.ts` (`web`), `config.ts` (`web` block), `projects.ts` (nothing: rooms are the registry's projects).
- Dependencies: an OIDC client library and a markdown renderer with raw HTML disabled (exact packages and versions pinned in the tasks). No frontend framework or bundler.
- External: an OIDC client registration in our identity provider (instance values in the ops overlay), a public HTTPS hostname for shared use (prod: nginx; the home canary can start on localhost).
- **Rollout bucket 3 by construction**: the driver runs only under `orch web`, which no existing installation starts. Ledger row per PR.
- Slack untouched. The web Home page renders the same cheat-sheet source as the Slack App Home tab.
