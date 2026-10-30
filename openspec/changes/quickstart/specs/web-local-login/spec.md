# Spec Delta

## Purpose

How a local installation's web chat signs its one person in without an identity provider: a link with a token, printed at boot, that works through a container's published port.

## ADDED Requirements

### Requirement: The sign-in link mode is local only
`WEB_AUTH=link` SHALL be accepted on any `WEB_BIND`. It SHALL require a localhost `WEB_BASE_URL`, and `http://localhost:<WEB_PORT>` when unset. The boot SHALL stop with one sentence naming `WEB_BASE_URL` when the base URL is not a localhost one. `WEB_AUTH=none` and `WEB_AUTH=oidc` SHALL behave as before this change.

#### Scenario: Inside a container
- **WHEN** `.env` sets `WEB_AUTH=link` and `WEB_BIND=0.0.0.0` with no `WEB_BASE_URL`
- **THEN** the web chat starts, listening on every interface, with base URL `http://localhost:8787`

#### Scenario: A public base URL
- **WHEN** `.env` sets `WEB_AUTH=link` and `WEB_BASE_URL=https://chat.example.com`
- **THEN** the boot stops and says the link mode needs a localhost `WEB_BASE_URL`

#### Scenario: The harness mode unchanged
- **WHEN** `.env` sets `WEB_AUTH=none` and `WEB_BIND=0.0.0.0`
- **THEN** the boot stops as before, naming the loopback listener

### Requirement: A new link per boot
At boot the bot SHALL write one line with the sign-in link, `<base URL>/login?key=<key>`, with a random key drawn for that boot, to standard output and not through the logger that forwards to the error tracker. No other line SHALL name the key. A link from an earlier boot SHALL NOT sign in.

#### Scenario: A restart
- **WHEN** the bot restarts
- **THEN** it logs a new link, the old link answers 401, and a browser signed in before the restart stays signed in

### Requirement: The session outlives a restart
Under `WEB_AUTH=link`, when `WEB_SESSION_SECRET` is unset, the bot SHALL generate a session secret on first boot and keep it in `web-session.secret` in the installation directory, readable by its owner only. A set `WEB_SESSION_SECRET` SHALL have at least 32 characters.

#### Scenario: First boot without a secret
- **WHEN** the bot first boots with `WEB_AUTH=link` and no `WEB_SESSION_SECRET`
- **THEN** `web-session.secret` exists with mode 0600, and the next boot reuses it

### Requirement: Only the link signs in
`/login` with the right key SHALL set a session for the fixed local user, who SHALL be an operator. The key SHALL be compared in constant time. Without the key, the login route SHALL store no user, whatever the OIDC settings. A request without a session SHALL reach no page, stream or upload. `/login` without the key or with a wrong one SHALL answer 401 with a page saying the link is in the bot's log.

#### Scenario: Opening the link
- **WHEN** a browser opens the logged link
- **THEN** it lands on the rooms page, signed in as the local user, and operator verbs such as `/usage` answer

#### Scenario: Without the link
- **WHEN** a browser opens `http://localhost:8787/` without a session
- **THEN** it gets the 401 page that points to the log, and no room, stream or file

#### Scenario: A wrong key
- **WHEN** a request asks for `/login?key=` with any other value
- **THEN** it gets 401, no session cookie, and the log shows no key
