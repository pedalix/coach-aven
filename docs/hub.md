# The messaging hub — operations

The hub relays agent messages between installations (`docs/agent-messaging.md`). It is a Cloudflare
Worker with one Durable Object (`hub/`; OpenSpec `messaging-hub`, opened to any installation by
`hub-open-network`).
- **Connections.** Every installation's bot keeps one outbound WebSocket to the hub and claims its name
  with a signed challenge.
- **Envelopes.** The bot sends envelopes the hub cannot read: sealed end to end between the two
  installations.
- **What the hub does.** It admits names, routes between installations that pinned each other, keeps
  undelivered envelopes for 7 days, and reports presence, removals and expiries.
- **What it does not decide.** Which agent may ask which: the receiving installation decides that.

Every node is untrusted by default: the hub, the installations and their sandboxes. The hub sees
installations, never agents: agent names, the method and the task id travel sealed.

## Names

- **Uniqueness.** An installation's name (`[a-z0-9-]{1,32}`) is unique on its hub.
- **Claiming.** The first key that connects with a free name gets it, and one key holds one name. New
  names are limited per address and day: per IPv4 address, or per IPv6 /64.
- **Release.** A name whose key has not connected for `idleDays` (180) is released, unless it is
  reserved. The installations that pinned it hear that it was removed, and anyone may claim it again.
- **Reserved names.** The hub's configuration reserves names, for the keys listed (an operator's own
  installations) or for nobody (`null`). `local` and `hub` are reserved for nobody on every hub. A reserved
  name is never released, and no other key can take it.
- **Bindings are stored.** The hub stores every name's binding to the key that last used it, whether the
  name was claimed or admitted as reserved. Dropping a name from `reserved` ends its protection, not its
  binding: it stays with that key, as a claimed name would.
- **The key is the identity, the name only a handle.** Peers pin keys, so a name that changes hands can
  neither read nor forge anything: its new key fails every pin, and the receiver logs `bad signature from
  <name>`.
- **Other hubs.** `<name>@<host>` is kept for addresses on other hubs (federation) and refused for now.

## Deploying it (from the operator's ops repo)

1. Copy `hub/wrangler.example.toml` to the ops repo as `wrangler.toml`, and set the route to the hub's own
   domain: `routes = [{ pattern = "hub.example.com", custom_domain = true }]`.
2. Write `HUB_CONFIG`, the registration policy, and store it as a secret (`wrangler secret put HUB_CONFIG`):
   ```json
   { "registration": "open",
     "reserved": { "home": { "sign": [{ "key": "<orch hub keygen output>" }] },
                   "bluefin": { "sign": [{ "key": "<…>" }] },
                   "northwind": null },
     "limits": { "claimsPerIpPerDay": 5, "idleDays": 180 } }
   ```
   - `registration`: `open` (the default: anyone may claim a free name) or `closed` (no new claims:
     reserved names, and names already bound to a key, keep connecting with their keys; anyone else is
     refused `closed`, whatever name it asks for).
   - `reserved`: a name maps to `{"sign": [{"key", "notAfter"?}]}`, the keys that may hold it (a list, so a
     rotation can overlap), or to `null`, nobody.
   - `limits`, all optional (defaults):
     - `claimsPerIpPerDay` (5): new names one address may claim per day;
     - `idleDays` (180): days without a connection before a claimed name is released;
     - `pairEnvelopes` (200) and `pairBytes` (10 MB): what one sender may have waiting for one recipient;
     - `backlogEnvelopes` (1000) and `backlogBytes` (50 MB): what may wait for one recipient from everyone;
     - `allowMax` (1000): installations one allow list may name.
   - A configuration in the version-1 shape (`{"installations": …}`) is refused, and so is any key the hub
     does not know, at any level: a misspelt `"registraton": "closed"` must not leave a hub open. The hub
     then admits nobody, logs `hub.config.invalid` naming the problem, and `/health` answers 503, so the
     check after a deploy fails.

   Keep the readable copy in the ops repo (`hub.config.json`). It holds public keys only.
3. Sentry, optional: `wrangler secret put SENTRY_DSN` (the bots' DSN will do), and a `SENTRY_ENVIRONMENT`
   var that tells the hub's events apart (default `hub`). `--var SENTRY_RELEASE:<git sha>` on the deploy
   tags them with the version.
4. `wrangler deploy` (from the ops repo, with `hub/` of this repo as the source).

The hub's state lives in the object's SQLite and survives deploys: outboxes, names, allow lists, tombstones
and the schema version. A deploy drops every socket, and the bots reconnect.

## Joining a hub

1. On the installation's box:
   - set `INSTALLATION_ID` (its name: not `local` or `hub`) and `HUB_KEY_PATH` in `.env`;
   - run `orch hub keygen`. It writes the key file (mode 0600; the private keys never leave the box) and
     prints the public halves: a `reserved` entry for the hub's configuration, and the peers' entry.
2. At the hub:
   - **open hub:** nothing to do — the bot claims its name when it first connects;
   - **protecting the name** (an operator's own installations, or any hub with closed registration): add
     the printed `reserved` entry to `HUB_CONFIG` and deploy, *before* the bot first connects.
3. Pin both ways:
   - add `{"<name>": {"keys": [{"sign": "…", "box": "…"}]}}` to the `hub.peers.json` of every installation
     that should talk to it, and its peers' entries to its own;
   - the file sits beside `projects.config.json`, and `deploy.sh export`/`import` carry it;
   - run `/aven reload` on each.
4. Set `HUB_URL=wss://hub.example.com` on the new installation and restart its bot. The log says
   `agent messaging: hub client for <name> → …`. A missing name or key file is a loud error, and messaging
   inside the installation keeps working without the hub.

## Who hears from whom

- **Pins are the allow list.** An installation's pinned peers (`hub.peers.json`) are its allow list at
  the hub. The bot sends them after every connect, and again when a `/aven reload` changes them.
  - The hub routes an envelope only to an installation whose list names its sender. These are exactly the
    senders whose envelopes the installation can verify; the hub just drops the others before they take a
    place in the mailbox.
  - Which agent may ask which stays with the agents' `accept` lists, which never leave the installation.
- **`unknown installation`** is the same answer for three cases: a name nobody holds, a removed one, and
  one that has not pinned the sender. So the hub does not tell a sender who exists. When it is your own
  peer, check that it pinned you: the asking agent is told so.
- **Presence and removals.**
  - An installation sees another online only when the two pinned each other.
  - A removal reaches the installations that pinned the removed name.
  - No installation learns the list of names on the hub.
- **Allow lists are cheap.** An unchanged list changes nothing and tells nobody anything. A changed one
  sends a fresh view only where a relationship changed: an installation that does not allow the sender
  hears nothing. The hub takes at most 10 lists per connection in 10 minutes. The next one closes the
  connection (`allow throttled`), so that the bot reconnects after its backoff and sends its current list
  once, under a fresh budget. A bot sends one list per connection and one per reload that changed its pins,
  so this happens only as fast as an operator reloads.
- **Quotas.** If either limit is reached, the envelope is refused `rejected: backlog`:
  - 1000 envelopes or 50 MB waiting for one recipient;
  - 200 envelopes or 10 MB from one sender to one recipient, so one peer cannot fill a mailbox for the
    others.
- **Why pins and installation keys.** An agent is not a cryptographic principal — the installation that runs it
  is — so keys per agent, group keys and the hub as a certificate authority were rejected: the hub never vouches for
  anyone. Pins grow with pairs (50 installations in a full mesh are 1225 pairs, and one key rotation touches up to 49
  peers); the steps after them are pairing codes, then organisation keys, then well-known names (OpenSpec
  `hub-open-network`).

## Removing an installation

To cut an installation off, reserve its name for nobody (`"northwind": null`) and deploy. On its first
request the hub does all of this, whether the installation is connected or not, and with or without
envelopes waiting for it:
- tombstones the name (`revoked`);
- drops its outbox and allow list, and closes its connection;
- reports it removed to the installations that pinned it, whose open tasks with it end
  `failed: peer removed` (an offline one hears of it when it next connects).

Reserving a name for another key does the same to whoever holds it now, and the new key takes the name
when it connects.

Dropping a name from `reserved` cuts nobody off. It ends the protection: the name stays bound to the
key that last used it, and is released like any claimed name after `idleDays` without a connection.

Dropping a peer from one installation's `hub.peers.json` and running `/aven reload` ends that
installation's tasks with the peer, and stops the hub delivering from it there.

## Rotating keys

- **A reserved name** (keep the old and the new key listed together until the bot uses the new one; a key
  that disappears from the list revokes the name if it was the one bound):
  1. Run `orch hub keygen --rotate`. It makes new keys and keeps the previous encryption key for 14 days,
     so envelopes sealed to it before the peers updated still open.
  2. Add the new signing key to the name's `reserved` list next to the old one, giving the old one a
     `notAfter`.
  3. Add the new pair to the peers' `hub.peers.json` next to the old one, again with a `notAfter`.
  4. Remove the old entries after the grace period.
- **A claimed name** is bound to one key. Rotating it needs key succession, which is not built yet. Until
  then the hub's operator can reserve the name for the new key, or the installation takes a new name and
  its peers re-pin it.
- **Changing an installation's name** makes its old domain foreign: marks that name it stay, and its open
  tasks fail. Change it only with no open tasks (`/aven asks`).

## Moving to protocol version 2

The hub and every bot that uses it speak one protocol version. Version 2 does not speak version 1: a
version-1 bot is refused `unsupported version`, and a version-2 bot is refused by a version-1 hub. Either
way messaging inside each installation keeps working.
1. Convert `hub.config.json` to version 2. Reserve the operator's installations, including the ones not
   connected yet, then deploy the hub. Until the bots are upgraded, the hub logs `hub.auth.refused
   reason="unsupported version"` for them.
2. Upgrade the bots (deploy, or pull and restart in their windows). Check each connect log, and that the
   installations that pinned each other see each other online.

The hub's storage migration drops the version-1 envelopes still waiting. Their tasks end
`failed: expired` by the bots' own expiry.

## Clocks

Nothing in the protocol depends on the bot's clock at a finer grain than days: task expiry, key
`notAfter`, idle names.
- The bot compares the hub's time with its own once per connection and warns (`hub.clock.skew`) past 30 s.
  It corrects nothing.
- Keeping the host's clock in sync is the host's job: NTP on a server. On WSL the clock stops while the
  laptop sleeps, so run `sudo hwclock -s` (or restart WSL) after a long sleep.

## Data at rest

- **On the answering installation:**
  - the task records in `state.json`, both directions, with the last message;
  - the conversations' marks;
  - the shadow journals in `shadow/<origin>/<task id>.jsonl`: other agents' questions and this
    installation's answers, kept 30 days and pruned with the task records.
- **On every sending installation:** the clear message of each envelope the hub routed, without its
  ciphertext or payload, kept in `state.json` until the task expiry, so that an expiry report — which
  names only the envelope id — finds its task.

None of it goes to the ops repo.
- **On the hub:**
  - sealed envelopes until acknowledged or expired (7 days), each with its two installations, id, size and
    times;
  - every name's binding (name, key, when bound and last seen), the allow lists, the tombstones, and the
    claim counts per address (an IPv4 address, an IPv6 /64) per day.

  No agent names, methods or task ids.

## Watching it

- **On the bots:** every messaging failure is logged as `messaging <event> …`, and from warning up sent to
  Sentry explicitly (catalogue: `src/messaging/events.ts`). This covers:
  - a refused connection (`hub.connect.failed` with the hub's reason);
  - an envelope that does not verify;
  - a replaced connection;
  - an outage of 10 minutes or more;
  - a long backlog.
- **On the hub:** it logs every refusal, rejection, replacement, removal and expiry to Workers logs as one
  JSON line.
  - With a `SENTRY_DSN` secret it also sends the warnings and errors among them to Sentry, along with any
    uncaught exception.
  - Tags are `area=hub`, `event`, `reason` and, for the operator's reserved names, `installation`. There is
    one event per event, reason and installation per hour, because a bot that is refused redials every minute.
  - Any other name travels as `claimed`, a plain field, not a tag: in refusals, and in `hub.replaced`,
    `hub.allow.throttled`, `hub.allow.capped` and `hub.installation.removed`. Those are deduped on the event
    and reason alone, so names invented by the thousand cannot turn repeats into events. The dedupe memory
    is bounded.
  - How loud a refusal is depends on whose business it is:
    - a reserved name claimed with another key is an error: the operator's own bot is misconfigured, or
      someone is posing as it;
    - a version-1 bot, a mismatched hint or a bad signature is a warning;
    - a name taken, a claim limit or closed registration is info: on an open hub, other people's business.
  - Routing metadata only: never a key, a signature, an envelope, an agent, a method or a task.
