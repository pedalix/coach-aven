# Design

## Context

- Built on `chat-driver-interface` (archived): the core talks to `ChatDriver` (`src/chat/driver.ts`) — turn path `post / update / mark / permalink`, interaction surface `reply / postPrivate / openDialog / updateDialog / refreshRating / publishHome`, lookups `conversationName / openDirect / findConversation`, `capabilities` — with the view models of `src/chat/views.ts` (`MessageView`, `PrivateView`, `DialogView`, `HomeView`). Inbound, a driver normalizes to `ChatMessage` (with lazy `files()` and `claim()`), `ChatAction`, `ChatCommand`, `DialogSubmit` and hands them to `src/chat/core/` (`messages.ts`, `interactions.ts`, `commands.ts`, `gates.ts`). The Slack driver is the template: `src/chat/slack/app.ts` is the composition root (turn engine + channel resolver + pollers), `driver.ts` renders views and calls the Web API, `events.ts`/`commands.ts` adapt Bolt payloads, `blocks.ts` holds all Block Kit. `src/chat/drivers.ts` lists the drivers a build can run; `src/chat/imports.test.ts` enforces that only a driver's directory imports its SDK.
- Infrastructure already in place (`ops-overlays`, `teams-bot-infra`): the `infra/teams/` module creates the single-tenant Entra app + rotating secret, the Azure Bot (F0) with the Teams channel and the app package; its outputs are the driver's three settings. The first Teams installation runs on its own host with nginx terminating TLS behind Cloudflare and proxying `https://<host>/` to a loopback port; the catalog already holds the app. No tunnel anywhere: the staging installation is the canary.
- Teams facts that shape the design:
  - No socket mode: Azure Bot Service POSTs activities to the public HTTPS endpoint; proactive sends go to the stored `serviceUrl`.
  - Multi-tenant bot creation ended 2025-07-31; bots are single-tenant, registered in the tenant that hosts them.
  - A bot sees channel messages without an @mention only with the RSC permission `ChannelMessage.Read.Group` (in our manifest, with `webApplicationInfo`), consented by the team owner at install.
  - No ephemeral messages; **targeted messages** (developer preview) show a message in a channel to one user only, disappearing after 24 h.
  - Bots cannot add reactions. Dialogs (task modules) are private pop-ups driven by Adaptive Cards.
  - External people join a team in the host tenant as **guests**.
- The Bot Framework SDK is retired (support ended 2025-12-31). The Teams SDK (`@microsoft/teams.apps`) is the Teams-only successor: JWT validation, activity routing, card actions, dialogs, proactive sends, an Express 5 server.

## Goals / Non-Goals

**Goals:**
- A Teams driver with the parity matrix below as its contract.
- The Teams SDK only under `src/chat/teams/`.
- PR 1 alone gives a usable bot in Teams (mention → thread turn, status card, answer, 1:1, the basic commands, recovery), so the driver is tried on the staging installation before the parity tail.

**Non-Goals:**
- Core changes beyond additive interface methods if Teams needs one.
- Anything about the operator's host, tenant or first project — that is the installation's ops repo.

## Parity matrix

Legend: **=** same behaviour; **≈** same outcome, different mechanism; **later** follow-up change; **n/a** concept does not exist on Teams. **PR** says which PR delivers it.

| Slack today | Teams driver | | PR |
|---|---|---|---|
| @mention in a project channel starts a thread | @mention in a bound channel starts a thread (reply chain) | = | 1 |
| Thread replies continue the session without re-mention | Same, via RSC `ChannelMessage.Read.Group`; without consent only @mention replies reach the bot | ≈ | 1 |
| DM with project picker | 1:1 chat with project picker (skipped for one project) | = | 1 |
| Group DM | Group chat: @mention only | ≈ | 1 |
| 👀 reaction on the user's message | Typing indicator + the status card that appears at once | ≈ | 1 |
| `!` note: no turn, 🤫 reaction | No turn, no acknowledgement (bots cannot react) | ≈ | 1 |
| Live status message, edited in place | Status card updated in place, coalesced to ≥ 2 s per message | ≈ | 1 |
| ✖ Cancel, 🧭 Show steps (modal), 🔄 Restart | Card actions; Show steps opens a dialog | = | 1 |
| 🌙 Working in the background, 🔔 Background update | Same cards, proactive messages in the thread | = | 1 |
| Answer: mrkdwn, split, PR buttons | Teams markdown (tables → code block), split, PR link buttons | ≈ | 1 |
| 👍 / 👎 with live tally, 👎 reason modal | Card buttons with tally (card refresh), reason dialog | = | 2 |
| ⚙️ Session panel (ephemeral) + Restart | Session panel as a dialog | ≈ | 2 |
| AskUserQuestion buttons, multi-select Submit | Adaptive Card ChoiceSet + Submit | ≈ | 1 |
| Inbound files (images, PDFs, docs) | 1:1: file attachments via download URL; channels: inline images via bot token, documents via Graph (SharePoint) with app permission | ≈ | 2 |
| `/aven <verb>` slash command | `@Aven /<verb>` in channels, `/<verb>` in 1:1; manifest command list for autocomplete | ≈ | 1 (`status`, `help`, `home`, `reload`), 2 (the rest) |
| Ephemeral replies (status, usage, memory, prompt, access, errors) | Targeted message in the channel; fallback to the user's 1:1 chat when targeted messages are unavailable | ≈ | 1 (1:1 fallback), 2 (targeted) |
| `/aven <question>` private answer in DM | Answer in the user's 1:1 chat (proactive) | = | 2 |
| `/aven memory` with topic buttons | Same card, buttons post the topic privately | = | 2 |
| `/aven schedule`, `routines`, `routines all` | Same verbs; routine runs post a new thread in the project channel | = | 2 |
| `/aven dream`, `housekeeping`, `review`, `review auto`, `autofix` | Same verbs and deliveries | = | 2 |
| Autofix notice with Fix button | Same card | = | 2 |
| YouTrack poller: ticket card, 🔍 Full ticket modal, 📝 Report to YouTrack modals, owner ping | Same cards and dialogs; owners pinged by Teams mention (needs owners' Entra ids in config) | ≈ | 2 |
| Dispatch Send / Dismiss | Same card; Send posts into the target project's Teams channel | = | 2 |
| `/aven users` allow/deny `@user`, workspace admins | Same verbs on Entra object ids from mentions; admins = installation operators + owners of the bound team | ≈ | 2 |
| Operator-only verbs (usage, reload) on the home workspace | Operators listed in `TEAMS_OPERATORS` | ≈ | 1 |
| `/aven reload` | Same | = | 1 |
| App Home tab (cheat-sheet + projects) | Home card on personal install and on `/home`, same bullets source | ≈ | 1 |
| Channel auto-binding by name (`<prefix><slug>`) | Explicit `teamsChannel` id per project | ≈ (settings page later, both drivers) | 1 |
| Ops alerts to the ops channel | Same, into the configured ops channel | = | 2 |
| Slack Connect (external org in a shared channel) | External people as guests of the host tenant | ≈ | 1 |
| Multi-workspace OAuth installs, tenant-prefixed keys | One Entra tenant per installation | n/a | – |
| `app_uninstalled` / `tokens_revoked` | `installationUpdate` remove: drop refs, log | ≈ | 2 |
| Restart recovery into the original thread | Same, through the stored conversation references | = | 1 |
| Teams-only extras (streaming in 1:1, static tab) | — | later | – |

## Decisions

### D1. Teams SDK 2.1.0, isolated
`@microsoft/teams.apps@2.1.0` (published 2026-09-16, MIT, `engines.node >= 22.12`, brings `@microsoft/teams.api` and `@microsoft/teams.cards` at the same version), pinned exactly. Only `src/chat/teams/` imports `@microsoft/teams.*`, enforced by `src/chat/imports.test.ts` exactly as the `@slack/*` rule. The SDK's `App` validates the Bot Framework JWT, routes activities, sends and updates messages, opens dialogs and serves HTTP; we hand it our own Express-less listener on `TEAMS_PORT` bound to `127.0.0.1` (nginx is the public face).
*Alternatives*: M365 Agents SDK (multi-channel weight we do not need), raw Bot Connector REST (we would own token validation).

### D2. Identity, tenant and guests
One single-tenant Entra app + Azure Bot per Teams installation, created by the `infra/teams` module in the tenant that hosts the teams. The driver's settings are the module's outputs: `TEAMS_APP_ID` (client id), `TEAMS_APP_PASSWORD` (the secret), `TEAMS_TENANT_ID`. Activities whose `conversation.tenantId` differs from `TEAMS_TENANT_ID` are rejected before any project lookup. Guests invited into that tenant appear in its conversations with Entra object ids, so they are ordinary users for access control.

### D3. Keys and conversation references
A channel activity's `conversation.id` is `<channel id>;messageid=<root id>`. The driver hands the core `conv` = the channel id (`19:…@thread.tacv2`, exactly the value a project's `teamsChannel` holds) and `thread` = the chain's root message id (undefined for the message that starts a chain, which is then its own root — a Slack top-level mention); a 1:1 chat is `conv` = its id, no thread. Keys therefore keep their Slack shapes unchanged: `thread:<root id>`, `dm:<conv>:<slug>` (the extra `:` in a Teams id is harmless — the slug is the last segment, teamkeys.ts), and the slug-based shapes of routines, reviews, autofix and YouTrack. No digests: raw ids keep the registry binding a plain string comparison and the keys readable in `state.json`. Sends address `<conv>;messageid=<thread>`; edits remember the chain a message was posted into. The Bot Connector's service URL, which only inbound activities carry, is stored in `state.json` (`teams.serviceUrl`) so proactive posts (recovery, routines) work after a restart.
*Was:* 16-hex digests of the ids (the plan before the probe); dropped once the real ids proved key-safe.

### D4. Commands
A message is a command when its text, after the bot mention is stripped, starts with `/`, wherever the bot listens: after a mention in a channel, bare in a 1:1 chat, and in a reply chain of a channel (no mention needed there — the probe showed the Teams client passes a leading `/` through untouched in both scopes). The verb list and parsing are the existing `/aven` grammar in `src/chat/core/commands.ts`; only the transport differs: the driver builds a `ChatCommand` and calls the same router, which answers privately. The manifest's command list gives autocomplete after `@Aven` (PR 2).

### D5. Private replies
`postPrivate` and `reply` use targeted messages in channels and group chats once `TEAMS_TARGETED=1` says the tenant has them; otherwise (and in PR 1 always) they post to the user's 1:1 chat with a one-line pointer in the thread. Content that must stay private and is long (session panel, steps) uses dialogs.

### D6. Status throttling and limits
Status updates coalesce to at most one per `TEAMS_STATUS_MIN_MS` (default 2000 ms) per message, the final state is always flushed, 429 Retry-After is honoured through `netretry.ts`. Answers split under ~25 KB at paragraph, then line, then hard boundaries; `format.ts` (markdown → Teams markdown, the splitter) is pure and golden-tested.

### D7. Files
In 1:1 chats the manifest enables `supportsFiles` (a module variable, PR 2); uploads arrive with a pre-authorized download URL. In channels, pasted images come with a content URL readable with the bot token; documents are SharePoint links read through Graph with an application permission granted in the tenant. The fetched bytes enter the existing `attachments.ts` pipeline unchanged.

### D8. Running a Teams installation: public mechanism, private instance
- **Public repo**: the driver; `infra/teams/` (the identity + package module, already shipped); `deploy.env`'s `CHAT_DRIVER` rendered into the unit by `deploy.sh install` (`ExecStart=… src/cli.ts __DRIVER__`), the health check waiting for `<Slack|Teams> bot running`; `ops.example/.env.example` with the `TEAMS_*` keys; `docs/teams.md` with placeholders.
- **Ops overlay** (`infra/<slug>/`): `teams/` root + tfvars, `deploy.env` with `CHAT_DRIVER=teams`, `.env` with the three outputs, `projects.config.json` with `teamsChannel` ids, the tenant and team names. Channel ids (`19:…@thread.tacv2`) only ever appear there.
- `scripts/public-guard.txt` already carries the tenant id and the first bot's app id.

### D9. Server shape
`server.ts` owns the HTTP listener: `POST /api/messages` only (everything else 404), body limit 1 MB, bound to `127.0.0.1:TEAMS_PORT` (default 3978). Startup logs `Teams bot running (:<port>) — <n> project(s), <m> channel-bound`, the line the deploy health check waits for. `orch teams` validates the `teams` config block at boot and refuses to start naming the missing key; `orch slack` never reads it.

### D10. What the canary taught (2026-10-16), and what PR 2 does about it
Rules of the platform found on the first real turns, now pinned in the driver and in
`docs/teams-pitfalls.md`:
- **Text and a card never share one message.** An edit with both is rejected (`BadSyntax: Activity resulted into multiple skype activities`); a new message with both is split by Teams and returns no usable id. The driver posts text and card as separate messages and edits the status card into the answer text, with the buttons as a follow-up card. Consequence: with queued turns the follow-up cards gather at the end of the chain, after the later turns' status cards.
- **Reply chains exist in channels only** (`@thread.tacv2`); a `;messageid=` suffix on a 1:1 (`a:…`) or group-chat (`@thread.v2`) id is a 403. A 1:1 message is a direct message whatever mention entity rides along.
- **Re-deliveries** after 15 s, the **5-second invoke budget**, **429/412/5xx retries** with `Retry-After`, `extendedmarkdown` (tables, highlighted code, headings render) — all applied.
PR 2 takes from this: (a) one post-answer card per answer (🧭 steps, 👍/👎, ⚙️ Session) instead of several; (b) a queued turn acknowledged with a 👀 reaction on the person's message (bots may react now, 2/s) and its status card posted only when the turn starts, so an answer and its card stay adjacent — an engine option the driver's capabilities switch on; (c) `mark()` as reactions in channels; (d) targeted channel messages (GA) for private replies, with the 1:1 fallback kept for people without the personal install (403 `ForbiddenOperationException`) and for guests, who never get a 1:1; (e) deep links to 1:1 messages need the `19:` chat id, not the `a:` conversation id.

## Risks / Trade-offs

- [RSC consent missing → thread replies need a mention] → The help text says so; the bot detects missing consent at install and posts a hint to the team owner.
- [Targeted messages are a preview] → D5 fallback to 1:1; flag-gated.
- [Public endpoint] → Only `/api/messages` exposed; SDK token validation; tenant check first; nginx body limit.
- [Guest experience] → Guests switch to the host tenant in the Teams client. The canary checks whether guest policies allow them to chat 1:1 with the app.
- [SDK churn] → One directory imports it, pinned version, contract tests on the activity shapes we rely on (fixture activities recorded from the canary, scrubbed).
- [Express 5 enters the dependency tree] → Only via the SDK; our listener exposes one route.

## Migration Plan

1. PR 1 — Teams driver core + deploy tooling (bucket 3 by construction). After the merge the staging installation deploys `main` (it is the canary) and people try the bot in Teams.
2. PR 2 — the rest of the parity matrix.
3. A client Teams installation beyond the canary is a separate decision, recorded in the ledger.
Rollback: stop the Teams installation's service; `CHAT_DRIVER` absent keeps every Slack installation on today's unit.
