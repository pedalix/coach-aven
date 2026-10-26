# Design

## Context

- Built on `chat-driver-interface` and `multi-driver-installation`: the core emits view models and receives normalized events; a driver renders and transports, as a surface of an installation that may run others. Slack and Teams render to someone else's UI and get history for free. The web driver owns the UI, the transport, the login and the history.
- The first users: the client's account managers and copywriters on the newsletter agent — one thread per newsletter, a preview link and texts at stop 2, an explicit go-ahead before an upload, photos attached; not developers.
- Agent output is untrusted (prompt injection can shape it), and the web driver is the first place we render it as HTML. Slack and Teams sanitize for us; here we must.
- The repo is public (`go-public`): the mechanism lives here, instance values (hostname, identity provider issuer, client id, allow-list) live in the installation's ops overlay.

## Goals / Non-Goals

**Goals:**
- Parity with Slack on every row where the concept exists, with no "≈ mapped" rows: private replies, dialogs and commands are native.
- Small surface: server-rendered fragments, a few hundred lines of client script, no framework, no bundler.
- Safe by construction against hostile answer content.

**Non-Goals:**
- A general team chat. Humans can talk in threads, but the product is talking to the agent.
- Offline notifications, mobile apps, search.

## Parity matrix

| Slack today | Web driver |
|---|---|
| Project channel | Project room |
| @mention starts a thread | Any top-level post starts a thread (no mention needed; `!` for a human-only note) |
| Thread replies continue the session | Same |
| DM with project picker | Private conversation per project, chosen in the sidebar (no picker needed) |
| 👀 reaction | "Seen" marker on the post + the status entry |
| Live status, Cancel, Show steps, Restart, background cards | Same, live over the stream |
| Answer, PR buttons, 👍/👎 with tally, reason modal, Session panel | Same; modals are dialogs |
| AskUserQuestion | Same |
| Files | Upload in the composer |
| `/aven <verb>` | `/<verb>` in the composer, with suggestions |
| Ephemeral replies | Messages stored with `visibleTo` = caller |
| `/aven <question>` private answer | Answer in the caller's private conversation |
| Routines, dreams, housekeeping, reviews, autofix, YouTrack, alerts | Same, into the project room (MVP: routines, dreams, housekeeping, reviews, alerts; YouTrack and autofix in PR 3) |
| ✋ held-message card (agent messaging) | Same, in the thread |
| Users allow/deny, admins | Allow-list in config (e-mails / groups), operators as admins; `/users` edits it |
| App Home tab | Home page |
| Slack Connect, multi-workspace | n/a: anyone with a login on the allow-list |
| Notifications | In-tab only (title badge, unread counts, browser notification while open); offline later |

## Decisions

### D1. Server-rendered fragments over a live stream
The server renders view models to HTML fragments (`webviews.ts`, pure, golden-tested) exactly as the Slack driver renders them to Block Kit. Each fragment has a stable element id (`msg-<id>`). One Server-Sent Events stream per open page delivers `{ id, html }` replacements and appends; the client script swaps them in. Forms and buttons POST to action endpoints and get 204; the effect arrives over the stream for every viewer alike.
*Alternatives*: a React/Vite SPA with a JSON API (a build pipeline and a second rendering of every view, in another language of components); WebSockets (bidirectional is not needed; SSE reconnects and resumes with `Last-Event-ID` for free).

### D2. History store
Append-only JSONL per conversation under the installation's data dir: `web/<slug>/<conversationId>.jsonl`, one event per line (`post`, `update`, `visibleTo`), compacted on read into the current state of each message. A small index per room lists threads with last activity. The SSE event id is the line offset, so a reconnect replays exactly what was missed.
*Alternative*: SQLite (`node:sqlite` is already used by `src/sources/`). Kept as the fallback if room listings get slow; JSONL matches `queue.jsonl` / `usage/*.jsonl` and is trivially inspectable.

### D3. Identity is the surface's job, access is the core's — and the web speaks OIDC only
Every driver hands the core an `actor { tenant, user, name, email }`; the core decides with `access.ts` by `(tenant, user)` as it does for Slack and Teams, so the web adds nothing to the core's model. The web surface authenticates with OIDC (authorization code + PKCE) against the issuer its configuration names and nothing else: `WEB_OIDC_ISSUER`, `WEB_OIDC_CLIENT_ID/_SECRET`, the claim that carries groups. Which identity provider stands behind that issuer is the installation's choice: the client's own (Entra, Google) or a broker per installation that holds a user pool for pilots, federates to the client's IdP later, and brings MFA and groups — the Teams staging installation uses the platform's Amazon Cognito staff pool (hosted UI, the accounts the client's people already use, groups from `cognito:groups`). CoachAven never keeps passwords of its own: a client asks for SSO sooner or later, and credentials are a liability we do not want. The session is a signed HttpOnly, Secure, SameSite=Lax cookie refreshed through OIDC; every POST carries a CSRF token bound to the session; no IdP token is stored. For local development and the end-to-end harness only: `WEB_AUTH=none` is accepted when the listener is bound to 127.0.0.1, with a fixed local user.
*Alternatives*: an own user database with e-mail magic links (quick for a pilot, a liability afterwards, and B2B wants SSO anyway); hard-wiring one provider (the next client has another).
Packages (task 1.1): `openid-client` 6.8.8 (2026-09-05, MIT; discovery, PKCE, the code grant with state and nonce checks) — the only module that imports it is `src/chat/web/oidc.ts`.

### D4. Rendering untrusted content
Markdown is rendered with raw HTML disabled and links restricted to `http`, `https`, `mailto` (`markdown-it` 14.3.2, 2026-09-12, MIT, with `@types/markdown-it` 14.2.0; only `src/chat/web/webformat.ts` imports it). Images render as links, never as `<img>`: nothing loads from a third party when a thread is opened. Every response carries a CSP with no inline script, no `eval`, scripts and styles only from self. Fragments are produced by escaping templates, never string concatenation of user or agent text. A test suite of hostile inputs runs against `webformat.ts` and `webviews.ts`.

### D5. Keys and identities
Keys keep the shapes from `chat-driver-interface`, with the surface segment of `multi-driver-installation` when the web is an additional surface. The driver owns the conversation ids the core sees (`src/chat/web/keys.ts`): a room is `room:<slug>`, a person's private conversation of a project is `pc:<userId>:<slug>` — both name their project, so the channel directory resolves them without a name lookup (`channels.ts` `projectOf` / `conversationFor`, the surface's own hooks). A thread's id is its root message's id. So a room thread's key is `web:thread:<rootId>` and a private conversation's `web:dm:pc:<userId>:<slug>:<slug>` (the core appends the slug to every DM key — a harmless redundancy), bare when the web is the installation's default surface. Message and thread ids are generated without `:`; a user id is the OIDC `sub` when it is plain (`[A-Za-z0-9._@-]`), else a digest of it. Name and e-mail are recorded at login in `state.json` (`webUsers`). `actor.tenant` is `WEB_ORG`, the organization behind the issuer (D6).

### D6. Organization, access and roles
The web surface's `tenant` is the organization behind its issuer, one per surface (`WEB_ORG`, an id the operator picks): the access gate and agent messaging's domains work unchanged, so data of one organization does not reach another without a person. At the start every logged-in user may do everything (`open` mode, the identity provider's user pool is the allow-list) and every project with a room is visible to all of them; `allowlist`, groups → projects and `/users` editing come in PR 3 when a client asks, through the same `access.ts`. Roles stay the ones the product has: the installation's operators (`WEB_OPERATORS`, OIDC subjects or e-mails), tenant admins, members. One person on several surfaces (the same colleague on Teams and on the web) is two identities today; a people registry keyed by verified e-mail is a later change (it serves `/users`, owner mentions and `/aven asks`, not the MVP).

### D6a. Commands and private replies
`/<verb> …` typed anywhere the person can write is a command (the Slack spelling `/aven <verb>` is accepted too); the typed line is stored visible to its author alone, and every reply of the router is a private message in that conversation (`visibleTo`), the web's native form of Slack's ephemeral — `replace` rewrites the previous one. `/<question>` that is not a verb is a private question and is **answered where it was asked, for the asker alone**: the driver has no `openDirect` (a private conversation names its project, which a bare user id cannot), so the router takes its in-place fallback (`runAsk` → a private markdown reply) — on the web that is the better experience anyway (no page change). The spec's "answered in the caller's private conversation" is adjusted accordingly.

### D7. Files
Multipart upload with a per-file and per-post limit (`WEB_MAX_FILE_MB`, default 20). Files are stored next to the conversation and handed to the existing `attachments.ts` pipeline. Downloads of stored files require the session and are served with `Content-Disposition: attachment` and `X-Content-Type-Options: nosniff`.

### D8. Hosting and what is public
The web surface listens on `WEB_PORT` (default 8787), beside the Teams listener when both run. Behind the installation's nginx with TLS on a dedicated hostname (the Teams staging installation: a second server block on its box; SSE needs proxy buffering off for that location). Home canary: localhost first (one user, no tunnel).
Public repo: driver code, `docs/web.md` with placeholders, `.env.example` keys. Ops overlay: hostname, issuer, client id and secret, allow-list, nginx site file.

## Changed while implementing (PR 1, 2026-10-26)

- **Conversation ids carry the project** (D5): `room:<slug>` and `pc:<userId>:<slug>` instead of a bare user id for private conversations, so the core resolves a project without a name wildcard and no DM picker ever appears on the web. The channel directory gained two hooks for surfaces that bind by construction (`projectOf`, `conversationFor`); Slack and Teams pass neither.
- **Private questions are answered in place** (D6a), not in "the caller's private conversation".
- **Dialogs ride the person's stream**: `openDialog` pushes `{ id, title, html }` to every page the person has open (every stream subscribes to its person's pushes), `updateDialog` pushes the same id again; the Home page is a page (`GET /`) and `/home` shows it as such a dialog.
- **History stores the view model, not HTML**: every bot message is its last `MessageView` (or `PrivateView`) as JSON, re-rendered for each viewer on page load and on the stream — so a rating tally re-renders the answer after a restart too.
- **The stream carries one conversation**: a thread or private page gets message elements, a room page gets thread cards; a `noop` frame advances the id past events the viewer may not see, so `Last-Event-ID` replays stay exact.
- **No file uploads yet** (PR 2 / D7): `hasFiles` is false on every web message.
- **One hostname per installation, path-routed** (D8 revisited): the Teams staging installation's origin certificate names its one host, and Teams uses only `/api/messages` there — so the web chat is served at that host's root (`location /api/messages` → the Teams port, everything else → the web port, `/stream` unbuffered) instead of a second hostname with a second certificate and DNS record. A dedicated hostname stays an option for an installation that wants one.

## Risks / Trade-offs

- [XSS through agent output] → D4: no raw HTML, link allow-list, CSP, escaping templates, hostile-input tests; a security review (`/security-review`) before the first shared deployment.
- [We own history and its retention] → Stored under the installation's data dir with the same backups as `state.json`; deletion policy is a follow-up, stated in `docs/web.md`.
- [People miss answers without notifications] → Unread counts and in-tab notifications in MVP; e-mail digest as the first follow-up if the canary shows it is needed.
- [UI work is open-ended] → Fixed scope: Home, room list, thread view, private conversation, dialogs. No theming beyond light/dark.
- [Public endpoint] → Login on everything, CSRF, body limits, rate limit per session on posting.

## Identity in the long run

- Surfaces authenticate, the core authorizes: the contract is `actor { tenant, user, name, email }` on every event, the same gate for every surface.
- Web: OIDC only; the issuer is the installation's business — the client's IdP, or a broker per installation (Cognito, Auth0) with a pool for pilots and federation later. Public mechanism in the repo, instance values in the ops overlay, as for Teams.
- Organization = tenant = domain. One surface, one organization; several organizations behind one web surface would take the tenant from a claim — not planned.
- Roles do not multiply: operators, tenant admins, members. Project visibility by groups and `allowlist` arrive when a client asks.
- People across surfaces: a registry keyed by verified e-mail, a separate change.
- Never our own passwords.

## Migration Plan

1. Prerequisite: `multi-driver-installation` PR 1 and PR 2 merged and on the Teams staging installation.
2. PR 1: server, login, rooms, threads, private conversations, turn lifecycle, history, recovery.
3. PR 2: the MVP commands, dialogs, feedback, files, background deliveries with the held card, Home page.
4. Canary: the end-to-end harness locally (`WEB_AUTH=none`, the operator's own machine, every MVP scenario driven over HTTP), then straight to the Teams staging installation with `CHAT_SURFACES=web`: the newsletter project rebound from its Teams channel to its web room, the client's people logged in through the staff pool, everyone may do everything.
5. PR 3 (when a client needs it): the remaining verbs, YouTrack, autofix, `/users`.
Rollback: drop `web` from `CHAT_SURFACES`; the Teams surface and the project's state are untouched.

## Open Questions

- Visual design details (layout, colours) are settled during PR 1 against a screenshot review; they do not change the spec.
