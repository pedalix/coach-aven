# Microsoft Teams

CoachAven's second chat driver (OpenSpec `teams-chat-driver`). An installation runs **one** chat
driver: `orch teams` serves its projects through Teams the way `orch slack` serves them through
Slack — same turn engine, same sandboxes, same `/aven` grammar, same pollers. What differs is
the platform, and this page is the map of those differences. Mechanism only: your tenant,
host and ids live in your ops repo (`infra/<slug>/`, see `infra/README.md`).

## The model

- **One Entra tenant per installation.** The bot is a single-tenant app in the tenant that hosts
  the teams (Microsoft no longer lets you create multi-tenant bots). People from other
  organisations join that tenant as **guests** and are ordinary users to the bot — no admin
  consent on their side.
- **One bot identity, created by Terraform.** `infra/teams/` (module) → your ops repo's
  `teams/` root: Entra app + rotating secret, Azure Bot (F0), Teams channel, the app package;
  `infra/teams/publish.sh infra/<slug>/teams` uploads the package to your organisation's app
  catalog. Its three outputs are the driver's settings.
- **A public HTTPS endpoint.** Teams POSTs activities to `https://<host>/api/messages`; the driver
  listens on `127.0.0.1:TEAMS_PORT` (default 3978) and your reverse proxy (nginx) is the public
  face. Slack dials out; Teams dials in — that is the one piece of host setup Slack never needed.
- **Binding by channel id.** Teams channels have no name wildcard: a project declares
  `"teamsChannel": "19:…@thread.tacv2"` in `projects.config.json` (the id Teams delivers in
  activities; the catalog app's "Add to a team" picks the channel). A mention in an unbound
  channel gets "not connected" and no turn.

## Running a Teams installation

1. **Identity**: apply the `infra/teams` module from your ops repo (`infra/teams/README.md`),
   publish the package, add the app to a team and to your own chats (Apps → *Built for your
   org*). Adding it to a team grants the resource-specific consent the manifest asks for, so
   thread replies reach the bot without a mention.
2. **`.env`** (`ops.example/.env.example` → the Teams block): `TEAMS_APP_ID`, `TEAMS_TENANT_ID`,
   `TEAMS_APP_PASSWORD` from `terraform output`; `TEAMS_PORT` if not 3978. Plus everything a
   Slack installation needs except the Slack tokens (sandbox driver, GitHub App, Claude token).
3. **`deploy.env`**: `CHAT_DRIVER=teams`. `npm run ops -- <slug> install` renders `orch teams`
   into the unit; `deploy` waits for `Teams bot running` in the journal.
4. **nginx**: `location / { proxy_pass http://127.0.0.1:3978; }` behind TLS (an origin
   certificate when Cloudflare fronts the host). Only `/api/messages` is served; everything
   else is 404.
5. **Bind a project**: `teamsChannel` in `projects.config.json`, `export`, `/reload` (or restart).

## What differs for people (the parity matrix)

| Slack | Teams |
|---|---|
| `@Aven <task>` in a project channel → a thread | the same → a reply chain; replies there continue the session (no re-mention needed) |
| DM | 1:1 chat; a project picker when several projects are served |
| `/aven <verb>` | `@Aven /<verb>` in a channel, `/<verb>` in a 1:1 or in a reply chain |
| ephemeral replies (status, help, denials) | with `TEAMS_TARGETED=1`: a targeted message in the thread that only you see (Teams removes it after 24 h); otherwise, or when Teams refuses it (no personal install, a guest), your 1:1 chat with the bot with a one-line pointer in the thread |
| 👀 / ✅ / ❌ reactions | the same (bots may react since 2026); a queued message gets only 👀 until its turn starts |
| live status message, ✖ Cancel, 🧭 Show steps | a status card (edited at most every `TEAMS_STATUS_MIN_MS`), the same buttons; Show steps opens a dialog. When the answer is ready the card becomes a one-line receipt ("✅ Done — answer below") and the answer is posted after it |
| `!` note | the same (no turn, nothing posted) |
| answer with PR buttons | the answer text, then ONE card: 🔗 PR links, 🧭 Show steps, ⚙️ Session, 👍 Helped / 👎 Missed (👎 asks for a reason in a dialog). Text and buttons are always adjacent, as the newest messages of the chain |
| agent questions | a card with one button per option; Submit for multi-select |
| App Home tab | a Home card in your 1:1 chat, on install and on `/home` |
| restart recovery into the thread | the same |

| `/aven users allow @user` | `@Aven /users allow @user` with a real mention; ids are Teams user ids (`29:…`). Admins: the installation's operators (`TEAMS_OPERATORS`) and whoever they add. Operator-only verbs (`/usage`, `/reload`) are theirs alone |
| `@user` mentions in bot text | rendered as Teams mentions for people the bot has seen in this run (sender or mentioned); others appear as `@<id>` |

| routines, dreams, housekeeping, auto-review, autofix, YouTrack investigations, ops alerts | the same deliveries into the project's bound channel (`teamsChannel`); a routine opens a new reply chain and replies there continue its session. 🔍 Full ticket waits for the ticket data before the dialog opens (a few seconds at most); 📝 Report to YouTrack and ✏️ Edit & send are dialogs with the editable text |
| YouTrack `ping` owners | the same `youtrack.ping` list, with Teams user ids (`29:…`); each becomes a real mention (the bot looks the name up in the channel roster once) |
| `AVEN_ALERT_CHANNEL` | the same; a Teams channel id the app is in |

| files on a message | 1:1 uploads (needs `supports_files` in the module → `supportsFiles`), pasted images anywhere, documents and photos attached in a channel (through Microsoft Graph — the module's `supports_files` adds `Files.Read.All`, an admin consents once). A channel upload is not in the activity Teams delivers at all: the driver reads the message back through Graph with the team's RSC consent (`ChannelMessage.Read.Group`) and takes the file from there — give the upload a word of text, a file alone is not a message to the bot. An emoji in the text is not a file. A file the bot cannot reach is named in the reply as "file access not granted" |

Admins are the installation's operators, full stop: there is no automatic promotion of team owners (considered and dropped — an installation's operators are the whole role model it needs; `open` mode lets everyone in a bound channel drive the agent anyway).

## Beside Slack, later

A Teams installation will be able to add other chat surfaces (`CHAT_SURFACES`, `docs/runtime-config.md`) once
`multi-driver-installation` PR 2 lands; today an installation runs one driver.

## Operations notes

- **Service URL.** Proactive posts (recovery, routines) need the Bot Connector's base URL,
  which only inbound activities carry; the driver stores the last one in `state.json` (`teams.serviceUrl`).
  A fresh installation can post proactively only after its first inbound message.
- **Consent.** Without the team owner's RSC consent only @mentions reach the bot; the help text
  says so. Re-adding the app to the team shows the consent again.
- **Removed from a team.** The journal says which bound project lost its channel; the binding
  stays in the registry and works again once the app is re-added.
- **Rate limits.** Edits coalesce per message; 429 Retry-After is honoured. Answers over ~25 KB
  are split; the card with the buttons rides on the last part.
- **Secrets.** The client secret rotates yearly by `terraform apply`; update `.env`, restart.
- **Tracing.** `TEAMS_TRACE=1` adds one journal line per inbound activity (`teams-trace: {…}`): type, scope,
  text length and the attachments' content types, names and hosts — never the text or a URL. `TEAMS_TRACE=full`
  journals the whole inbound body, every Connector request and response (`teams-http → / ←`) and every Graph call
  of the file path (`teams-graph`), secrets scrubbed, bodies cut at a few KB — for a staging installation that
  collects what Teams really sends; people's messages land in the journal, so never on a production one.
- **Health.** `journalctl -u <service>` shows `Teams bot running (:3978) — N project(s), M channel-bound`
  at boot; `curl -X POST https://<host>/api/messages` must answer 401 (token validation on).
