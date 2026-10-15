# Design

## Context

- Built on `chat-driver-interface`: the core talks to a chat driver interface (inbound events, outbound operations on view models, capabilities); Slack is its first implementation. This design only adds the Teams implementation.
- Teams facts that shape the design:
  - No socket mode: Azure Bot Service POSTs activities to a public HTTPS endpoint; proactive sends go to the stored `serviceUrl`.
  - Multi-tenant bot creation ended 2025-07-31; new bots are single-tenant (or managed identity), registered in the tenant that hosts them.
  - A bot sees channel messages without an @mention only with the RSC permission `ChannelMessage.Read.Group` in the manifest, consented by the team owner at install.
  - No ephemeral messages; **targeted messages** (developer preview) show a message in a channel to one user only, disappearing after 24 h.
  - Bots cannot add reactions. Dialogs (task modules) are private pop-ups driven by Adaptive Cards.
  - No Slack Connect equivalent without cross-tenant admin configuration. External people join a team in the host tenant as **guests**.
- The Bot Framework SDK is retired (support ended 2025-12-31). The Teams SDK (`@microsoft/teams.apps`) is the Teams-only successor.

## Goals / Non-Goals

**Goals:**
- A Teams driver with the parity matrix below as its contract.
- The Teams SDK only under `src/chat/teams/`.

**Non-Goals:**
- Core changes beyond additive interface methods if Teams needs one.

## Parity matrix

Legend: **=** same behaviour; **≈** same outcome, different mechanism; **later** follow-up change; **n/a** concept does not exist on Teams.

| Slack today | Teams driver | |
|---|---|---|
| @mention in a project channel starts a thread | @mention in a bound channel starts a thread (reply chain) | = |
| Thread replies continue the session without re-mention | Same, via RSC `ChannelMessage.Read.Group`; without consent only @mention replies reach the bot | ≈ |
| DM with project picker | 1:1 chat with project picker (skipped for one project) | = |
| Group DM | Group chat: @mention only | ≈ |
| 👀 reaction on the user's message | Typing indicator + the status card that appears at once | ≈ |
| `!` note: no turn, 🤫 reaction | No turn, no acknowledgement (bots cannot react) | ≈ |
| Live status message, edited in place | Status card updated in place, coalesced to ≥ 2 s per message | ≈ |
| ✖ Cancel, 🧭 Show steps (modal), 🔄 Restart | Card actions; Show steps opens a dialog | = |
| 🌙 Working in the background, 🔔 Background update | Same cards, proactive messages in the thread | = |
| Answer: mrkdwn, split, PR buttons | Teams markdown (tables → Adaptive Card table or code block), split, PR link buttons | ≈ |
| 👍 / 👎 with live tally, 👎 reason modal | Card buttons with tally (card refresh), reason dialog | = |
| ⚙️ Session panel (ephemeral) + Restart | Session panel as a dialog | ≈ |
| AskUserQuestion buttons, multi-select Submit | Adaptive Card ChoiceSet + Submit | ≈ |
| Inbound files (images, PDFs, docs) | 1:1: file attachments via download URL; channels: inline images via bot token, documents via Graph (SharePoint) with app permission | ≈ |
| `/aven <verb>` slash command | `@Aven /<verb>` in channels, `/<verb>` in 1:1; manifest command list for autocomplete | ≈ |
| Ephemeral replies (status, usage, memory, prompt, access, errors) | Targeted message in the channel; fallback to the user's 1:1 chat when targeted messages are unavailable | ≈ |
| `/aven <question>` private answer in DM | Answer in the user's 1:1 chat (proactive) | = |
| `/aven memory` with topic buttons | Same card, buttons post the topic privately | = |
| `/aven schedule`, `routines`, `routines all` | Same verbs; routine runs post a new thread in the project channel | = |
| `/aven dream`, `housekeeping`, `review`, `review auto`, `autofix` | Same verbs and deliveries | = |
| Autofix notice with Fix button | Same card | = |
| YouTrack poller: ticket card, 🔍 Full ticket modal, 📝 Report to YouTrack modals, owner ping | Same cards and dialogs; owners pinged by Teams mention (needs owners' Entra ids in config) | ≈ |
| Dispatch Send / Dismiss | Same card; Send posts into the target project's Teams channel | = |
| `/aven users` allow/deny `@user`, workspace admins | Same verbs on Entra object ids from mentions; admins = installation operators + owners of the bound team | ≈ |
| Operator-only verbs (usage, reload) on the home workspace | Operators listed in `TEAMS_OPERATORS` | ≈ |
| `/aven reload` | Same | = |
| App Home tab (cheat-sheet + projects) | Home card on personal install and on `/home`, same bullets source | ≈ |
| Channel auto-binding by name (`<prefix><slug>`) | Explicit `teamsChannel` id per project | ≈ (settings page later, both drivers) |
| Ops alerts to the ops channel | Same, into the configured ops channel | = |
| Slack Connect (external org in a shared channel) | External people as guests of the host tenant | ≈ |
| Multi-workspace OAuth installs, tenant-prefixed keys | One Entra tenant per installation | n/a |
| `app_uninstalled` / `tokens_revoked` | `installationUpdate` remove: drop refs, log | ≈ |
| Teams-only extras (streaming in 1:1, static tab) | — | later |

## Decisions

### D1. Teams SDK, isolated
`@microsoft/teams.apps`, exact version pinned in task 1.4 (≥ 2 weeks old, license checked). Only `src/chat/teams/` imports it, enforced by a test, mirroring the `daytona.ts` rule. It provides JWT validation, card actions, dialogs, proactive sends and an HTTP server.
*Alternatives*: M365 Agents SDK (multi-channel weight we do not need), raw Bot Connector REST (we would own token validation).

### D2. Identity, tenant and guests
One single-tenant Entra app + Azure Bot per Teams installation, in the tenant that hosts the teams (canary: a test tenant we own, with no client admin involved). Activities from another tenant id are rejected before any project lookup. Guests invited into that tenant appear in the host tenant's conversations with Entra object ids, so they are ordinary users for access control.

### D3. Keys and conversation references
Keys keep the Slack home shapes, ids digested because Teams ids contain `:` and `;`:
- thread: `thread:<16-hex digest of channel id + root activity id>`;
- 1:1: `dm:<16-hex digest of conversation id>:<slug>`;
- routines, reviews, autofix, YouTrack keep their existing slug-based shapes.
`teamsRefs` in `state.json` maps digest → `{ serviceUrl, conversationId, rootId }`, written on every inbound activity and on every proactive thread the bot creates. Recovery and pollers resolve targets through it.

### D4. Commands
A message is a command when its text, after the bot mention is stripped, starts with `/` followed by a known verb. The verb list and parsing are the existing `/aven` grammar; only the transport differs. The manifest's command list gives autocomplete after `@Aven`. If the spike (task 1.5) shows the Teams client intercepts a leading `/` in 1:1 chats, the prefix becomes `aven ` for 1:1 only.

### D5. Private replies
`postPrivate` uses targeted messages in channels and group chats. Because they are in preview, the driver checks capability at boot (config flag `TEAMS_TARGETED=1`) and otherwise posts to the user's 1:1 chat with a one-line pointer in the thread. Content that must stay private and is long (session panel, steps) uses dialogs instead.

### D6. Status throttling and limits
Status updates coalesce to at most one per `TEAMS_STATUS_MIN_MS` (default 2000 ms) per message, the final state is always flushed, 429 Retry-After is honoured through `netretry.ts`. Answers split under ~25 KB at paragraph, then line, then hard boundaries.

### D7. Files
In 1:1 chats the manifest enables `supportsFiles`; uploads arrive with a pre-authorized download URL. In channels, pasted images come with a content URL readable with the bot token; documents are SharePoint links read through Graph with an application permission granted in our tenant. The fetched bytes enter the existing `attachments.ts` pipeline unchanged.

### D8. Running a Teams installation; what is public and what is overlay
A Teams installation is a second checkout or worktree with its own `.env`, `state.json`, user service (e.g. `coach-aven-teams`) and `SANDBOX_NAME_PREFIX` (e.g. `teams-proj-`) when the sandbox backend is shared.
The repo is public, so the split follows the `go-public` rule: mechanism here, instance in the ops overlay.
- **Public repo**: the driver code, `infra/teams/manifest.template.json` with `${TEAMS_APP_ID}`-style placeholders, the packaging script, `docs/teams.md` with placeholder ids and hosts, `.env.example` keys.
- **Ops overlay** (`infra/prod/runtime/` for prod; the home installation's runtime dir for the canary): `.env` with the Teams secret, `projects.config.json` with `teamsChannel` ids, the rendered manifest and app package, the tenant and team names.
- `scripts/public-guard.txt` gains our Entra tenant id and bot app id (bracket-obfuscated, as the existing entries), so they can never land in a tracked file. Channel ids (`19:…@thread.tacv2`) only ever appear in overlay config.

## Risks / Trade-offs

- [RSC consent missing → thread replies need a mention] → The help text says so; the bot detects missing consent at install and posts a hint to the team owner.
- [Targeted messages are a preview] → D5 fallback to 1:1; flag-gated.
- [Public endpoint] → Only `/api/messages` exposed; SDK token validation; tenant check first; nginx body limit.
- [Guest experience] → Guests switch to the host tenant in the Teams client. The canary checks whether guest policies allow them to chat 1:1 with the app.
- [Test tenant quality] → The test tenant needs at least one Teams-licensed member to own the team, and an Azure subscription for the Azure Bot resource. Verified in task 1.1 before any code depends on it.
- [SDK churn] → One directory imports it, pinned version, contract tests on the activity shapes we rely on.

## Migration Plan

1. Prerequisite: `chat-driver-interface` merged and tagged.
2. Two PRs: Teams driver core, then the rest of the parity matrix (bucket 3 by construction).
3. Canary: a second home installation in our test tenant; people from other tenants join it as guests.
4. A client Teams installation is a separate deploy decision, recorded in the ledger.
Rollback: stop the Teams installation's service.

## Open Questions

- Dev Tunnels vs cloudflared for the home Teams installation, decided in task 1.3.
