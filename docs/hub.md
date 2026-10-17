# The messaging hub — operations

The hub relays agent messages between installations (`docs/agent-messaging.md`). It is a Cloudflare
Worker with one Durable Object (`hub/`, OpenSpec `agent-messaging` → `messaging-hub`): every
installation's bot keeps one outbound WebSocket to it, authenticates with a signed challenge, and sends
envelopes the hub cannot read — sealed end to end between the two installations. The hub admits
enrolled installations, routes between them, keeps undelivered envelopes for 7 days, and reports
presence, removals and expiries. It decides nothing about which agent may ask which: the receiving
installation does.

## Deploying it (from the operator's ops repo)

1. Copy `hub/wrangler.example.toml` to the ops repo as `wrangler.toml`; set the route to the hub's own
   domain (`routes = [{ pattern = "hub.example.com", custom_domain = true }]`).
2. Build `HUB_CONFIG` — the enrolled installations and their signing keys — and store it as a secret:
   ```sh
   wrangler secret put HUB_CONFIG   # {"installations": {"home": {"sign": [{"key": "<…>"}]}, "bluefin": {…}}}
   ```
   Keep the readable copy in the ops repo (`hub.config.json`); it holds public keys only.
3. `wrangler deploy` (from the ops repo, with `hub/` of this repo as the source).

The hub's state (outboxes, tombstones, the schema version) lives in the object's SQLite and survives
deploys; a deploy drops every socket and the bots reconnect.

## Enrolling an installation

1. On the installation's box: set `INSTALLATION_ID` (`[a-z0-9-]{1,32}`, not `local`) and `HUB_KEY_PATH`
   in `.env`, then run `orch hub keygen` — it writes the key file (mode 0600; the private keys never leave
   the box) and prints the public halves: the signing key for the hub, both keys for the peers.
2. Add the signing key to `HUB_CONFIG` and deploy the hub.
3. Add `{"<id>": {"keys": [{"sign": "…", "box": "…"}]}}` to the `hub.peers.json` of every installation
   that should reach it (beside its `projects.config.json`; `deploy.sh export`/`import` carry the file),
   and `/aven reload` there.
4. Set `HUB_URL=wss://hub.example.com` on the new installation and restart its bot. The log says
   `agent messaging: hub client for <id> → …`; a missing id or key file is a loud error, and messaging
   inside the installation keeps working without the hub.

## Removing an installation

Remove it from `HUB_CONFIG` and deploy: on its next request the hub tombstones it (even with an empty
outbox), drops its outbox, refuses its connections, and reports it removed to every connected bot —
whose open tasks with it end `failed: peer removed`. Dropping it from a `hub.peers.json` and running
`/aven reload` does the same on that installation alone.

## Rotating keys

- `orch hub keygen --rotate` makes new keys and keeps the previous encryption key for 14 days, so
  envelopes sealed to it before the peers updated still open.
- Both sides take lists: add the new signing key to `HUB_CONFIG` next to the old one (the old one with a
  `notAfter`), and the new pair to the peers' `hub.peers.json` next to the old (again with `notAfter`).
  Remove the old entries after the grace period.
- Changing an installation's **id** makes its old domain foreign: marks that name it stay, and its open
  tasks fail. Change it only with no open tasks (`/aven asks`).

## Clocks

Nothing in the protocol depends on the bot's clock at a finer grain than days (task expiry, key
`notAfter`). The bot compares the hub's time with its own once per connection and warns
(`hub.clock.skew`) past 30 s — it corrects nothing. Keeping the host's clock in sync is the host's job:
NTP on a server; on WSL the clock stops while the laptop sleeps — `sudo hwclock -s` (or restarting WSL)
after a long sleep.

## Data at rest

On the answering installation: the task records in `state.json` (both directions, with the last
message), the conversations' marks, and the shadow journals in `shadow/<origin>/<task id>.jsonl` — other
agents' questions and this installation's answers, kept 30 days and pruned with the task records. None of
it goes to the ops repo. On the hub: sealed envelopes until acknowledged or expired (7 days), and routing
metadata (who, to whom, method, task id, sizes, times).

## Watching it

Every refusal, an envelope that does not verify, a replaced connection, an outage of 10 minutes or more,
a long backlog and every messaging failure on the bots is logged as `messaging <event> …`, and from
warning up sent to Sentry explicitly (catalogue: `src/messaging/events.ts`). The hub logs its own refusals
and expiries to Workers logs.
