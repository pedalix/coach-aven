# Web chat

CoachAven's third chat driver (OpenSpec `web-chat-driver`): a web chat the installation serves **itself**, behind a
login, with the Slack feature set and no workspace or tenant in between. A client gets a URL and signs in with the
accounts they already have. `orch web` makes it an installation's default surface; `CHAT_SURFACES=web` adds it beside
Slack or Teams (`docs/runtime-config.md` → *Chat surfaces*): same turn engine, same sandboxes, same `/aven` grammar,
same pollers. Mechanism only — your hostname, issuer and client ids live in your ops repo (`infra/<slug>/`).

## The model

- **Rooms and threads.** Every project is a room (`webRoom: false` on a project hides it). A top-level post in a room
  starts a thread and a turn — no mention needed; a post beginning with `!` is a note and starts nothing. Replies in a
  thread continue that thread's session. Everyone who is signed in sees every room.
- **Private conversations.** Each person has one private conversation per project (the Slack DM): only they see it.
- **Commands** are `/<verb> …` typed in any room, thread or private conversation (`/aven <verb>` is accepted too), and
  their replies are visible to the person who typed them alone. `/<question>` that is not a verb is a private question,
  answered where it was asked, for the asker alone.
- **Live.** Every open page listens to a stream: status lines tick, answers land, buttons work (✖ Cancel, 🧭 Show
  steps, ⚙️ Session, 👍 / 👎, agent questions), dialogs open — for every viewer of the thread alike. A dropped connection
  catches up on its own. A background tab counts unread activity in its title.
- **History is ours.** Slack and Teams keep the messages; here the installation does: one append-only JSONL file per
  conversation under `<data dir>/web/<slug>/` (`room.jsonl`, `pc-<user>.jsonl`), the same data dir as `sources`
  (`AVEN_DATA_DIR`, default `data/`). Back it up with `state.json`; there is no deletion policy yet.
- **Identity is the surface's, access is the core's.** The web signs people in through **OIDC only** (authorization
  code + PKCE) against the issuer the installation names — the client's own identity provider or a broker the
  installation runs for them (the Teams staging installation uses the platform's Amazon Cognito staff pool). CoachAven
  never keeps passwords. Every logged-in person is an actor of ONE organization (`WEB_ORG`, the surface's tenant), so
  the core's gates see one open tenant: everyone may drive, the operators (`WEB_OPERATORS`) get the operator verbs.
  `WEB_ALLOW` narrows who may enter at all (e-mails or `group:<name>` from the groups claim); empty = everyone the
  issuer lets in.

## Running a web installation

1. **An OIDC client** at your issuer: confidential, authorization code, redirect URI `https://<host>/auth/callback`
   (add `http://localhost:8787/auth/callback` for a local run), scopes `openid email profile`. For a Cognito pool the
   installation's Terraform creates it (the staging overlay's platform module has one); for Entra or Google it is an app
   registration. You need the issuer URL, the client id and the client secret.
2. **`.env`** (`ops.example/.env.example` → the Web block): `WEB_OIDC_ISSUER`, `WEB_OIDC_CLIENT_ID`,
   `WEB_OIDC_CLIENT_SECRET`, `WEB_BASE_URL=https://<host>`, `WEB_SESSION_SECRET` (`openssl rand -hex 32`), `WEB_ORG`,
   `WEB_OPERATORS`; `WEB_PORT` if not 8787; `WEB_ALLOW` when not everyone with a login may use the chat. Plus everything
   a Slack installation needs except the Slack tokens (sandbox driver, GitHub App, Claude token). All five login settings
   are required together — the surface refuses to start naming the missing one; a public listener never runs without a login.
3. **`deploy.env`**: `CHAT_DRIVER=web` for a web-only installation (`npm run ops -- <slug> install` renders `orch web`;
   `deploy` waits for `Web chat running` in the journal), or `CHAT_SURFACES=web` in `.env` beside an existing driver.
4. **nginx**: TLS terminated there, proxying to `127.0.0.1:8787` — on its own hostname, or at the root of a Teams
   installation's host (Teams uses only `/api/messages`; keep that location on the Teams port). The stream is
   Server-Sent Events: turn proxy buffering off and lift the read timeout for `/stream`:

   ```nginx
   location / {
     proxy_pass http://127.0.0.1:8787;
     proxy_http_version 1.1;
     proxy_set_header Host $host;
     proxy_set_header X-Forwarded-Proto https;
   }
   location /stream {
     proxy_pass http://127.0.0.1:8787;
     proxy_http_version 1.1;
     proxy_set_header Host $host;
     proxy_buffering off;
     proxy_cache off;
     proxy_read_timeout 1h;
   }
   ```
5. **Projects**: nothing to bind — every project has a room. `webRoom: false` hides one. `deliverTo: ["web"]` on a
   project sends its auto-reviews and ticket investigations to its room too when the web is an additional surface.

**Local run, no login.** `WEB_AUTH=none` is accepted only when the listener is loopback (`WEB_BIND=127.0.0.1`) and the
base URL is a localhost one: a fixed local user, no identity provider — for development and the end-to-end harness.
Without `WEB_SESSION_SECRET` the secret is generated per boot, so a restart signs everyone out (one redirect to sign in
again); set it to keep sessions across restarts. Running beside a Slack or Teams bot of the same machine? Start it with
its own `SANDBOX_NAME_PREFIX`, `AVEN_DATA_DIR` and without the hub settings, or it shares their sandboxes and identity.

## What differs for people (the parity matrix)

| Slack | Web |
|---|---|
| `@Aven <task>` in a project channel → a thread | any top-level post in the room → a thread; `!` for a note |
| DM with a project picker | a private conversation per project, in the sidebar — no picker |
| `/aven <verb>` | `/<verb>` in the composer; `/<question>` answers privately where you are |
| ephemeral replies | messages only you see, marked *only you* |
| 👀 / ✅ / ❌ / 🤫 reactions | *seen / done / failed / note* marks on your post |
| live status message, ✖ Cancel, 🧭 Show steps | the same, live for every viewer; Show steps opens a dialog that updates while the turn runs |
| answer with PR buttons, 👍 / 👎 with tally, ⚙️ Session | the same; the reason and the session panel are dialogs and a private message |
| agent questions | the same (buttons; Submit for multi-select) |
| App Home tab | the Home page at `/`; `/home` and `/help` show it as a dialog |
| files on a message | 📎 Attach, drop or paste in the composer: up to 10 files, each under `WEB_MAX_FILE_MB`, of the types the agent can read (images, PDF, text, office documents) — a file over the limit or of another type is named and the message is not sent. Stored beside the conversation; a download needs the session and is served as an attachment |
| routines, dreams, housekeeping, reviews, held cards | the same deliveries into the project's room (a routine opens a thread, replies there continue its session); autofix and YouTrack investigations later; ops alerts have no web channel yet |
| `/aven users` | the same: everyone who logs in may drive (open mode); the operators (`WEB_OPERATORS`) are the admins |
| notifications | the tab's title counts activity while it is in the background; the sidebar marks conversations this browser has not opened since their last activity; 🔔 Notify (once allowed) shows a browser notification for a bot answer while the tab is hidden |

## Security baseline

Agent output is untrusted and the web is the first surface where we render it as HTML (design D4): markdown with raw
HTML off, links only to `http(s)` and `mailto`, images shown as links, every attribute escaped, a strict
Content-Security-Policy with no inline script, `frame-ancestors 'none'`. The session is a signed HttpOnly cookie
(Secure on https, SameSite=Lax, 12 h), nothing of the identity provider's tokens is stored; every POST carries the
session's CSRF token and must be a same-origin fetch; bodies are capped; posting is rate-limited per person. Hostile
inputs are a test suite (`src/chat/web/webformat.test.ts`).

## Operations notes

- **Health.** `journalctl -u <service>` shows `Web chat running (https://<host> ← 127.0.0.1:8787) — N project(s), M room(s)`
  at boot. The identity provider is reached once at boot (discovery): a wrong issuer fails the boot by name.
- **Sign-out.** `Sign out` clears the session cookie and, when the issuer publishes an end-session endpoint (Cognito's
  hosted UI does), ends the identity provider's session too — otherwise `/login` would sign the person straight back
  in on the provider's live session. The browser passes through `/signing-out`, a page of ours that refreshes to the
  provider's endpoint: Chrome applies the page's `form-action 'self'` to the redirects of a form submission, so a
  redirect from the `Sign out` POST straight to the provider would be blocked. The provider returns the browser to
  `/signed-out` (register `https://<host>/signed-out` as the client's logout URL); without such an endpoint the
  sign-out is local only. The denied page links `/signing-out` too — the way to come back as someone else.
- **People.** Who logged in is in `state.json` (`webUsers`: id, name, e-mail, last login) — the names on posts,
  cards and the header come from there, resolved live, so a later login with a better name reaches every page; a
  record whose name is just the id shows its e-mail. The user id is the issuer's subject. The display name is the ID
  token's `name`, else given + family name, else `preferred_username`, else the e-mail, else `cognito:username` when it
  is not the subject (in a Cognito pool that signs people in by e-mail it is the subject's UUID).
- **Journal.** Logins (`web login: <e-mail>`), rejected POSTs (`web: rejected a POST … without a valid CSRF token`),
  denied people (`not on the allow-list`), a dialog with no open page (`dropped — no open page`). Failures on the
  core's path reach the thread and Sentry, as on every surface.
- **Data.** `<data dir>/web/<slug>/*.jsonl` — inspectable, one event per line; a torn last line (a crash mid-write) is
  dropped on load. Remove a file to forget a conversation; the session state in `state.json` is separate. Uploads live
  beside it in `files/room/` and `files/pc-<user>/` as `<id>__<name>`; nothing deletes them yet — part of the backup.
- **nginx and uploads.** `client_max_body_size` must allow `WEB_MAX_FILE_MB` (the staging template sets 25m).
