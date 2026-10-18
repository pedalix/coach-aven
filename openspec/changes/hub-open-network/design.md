## Context

The hub and the bot's side of it come from the `agent-messaging` change (design D3–D8, D18), which is merged and running on the operator's canary installations but not yet archived. Today:
- **Admission.** `HUB_CONFIG` enrols installations and their signing keys. The challenge signature is `coach-aven-hub/1|host|installation|nonce`.
- **`hello`.** It returns `enrolled` (every installation; nothing in the bot reads it), `online` and `removed`. Presence goes to every connected installation.
- **Envelopes.** The clear header is `{v: 1, id, from: "<inst>/<agent>", to: "<inst>/<agent>", method, task}`. It is signed and used as AAD, and the KDF info is `context|from|to|task`.
- **Hub storage.** `outbox` keeps `to_addr`, `method` and `task`. `expired` reports carry `task` and `to`.
- **Backlog cap.** It is per recipient: 1000 envelopes or 50 MB.
- **Peers.** They are pinned in `hub.peers.json` (sign and box keys, with `notAfter` for rotation); an envelope opens only with the pinned key of its sender.
- **Transports.** The bot sees one `PeerTransport` for both. The local transport passes the same `Envelope` type with the payload in clear and never leaves the process.

Constraints: no new dependency on either side; no new bot setting; the local path must stay byte-for-byte the same (bucket 2); one Durable Object is still enough.

## Goals / Non-Goals

**Goals:**
- The protocol a third party first sees is the one that stays: names, admission, what the hub learns, the wire shape.
- Every later admission or trust mechanism plugs into one named place without a protocol version.
- The bot changes only in its hub client and in how a message is split into a clear header and a sealed payload.

**Non-Goals:**
- Changing who may ask which agent (the accept lists, marks, caps), or the sealing primitives (X25519, HKDF-SHA256, AES-256-GCM, Ed25519).
- The hub distributing keys of any kind. Pins stay the only source of a peer's keys.
- Sharding or federation: their hooks are placed here, nothing more.

## Decisions

### N1. Names: a registry in the hub, first come first served
The object's SQLite gains `names(name PRIMARY KEY, key UNIQUE, claimed_at, last_seen)` and `claims(ip, day, count)`. Reserved names are not stored there: they live in the configuration only.
- **Claiming.** `auth` names the name and the key.
  - A reserved name admits its configured keys.
  - A bound name admits its bound key.
  - A free name is bound if registration is `open`, the key holds no name, and the claim limit of the client's IP (`CF-Connecting-IP`) allows it.
- **Last seen.** It is updated on every authentication, rounded to the hour, so it costs one write per connection.
- **Releasing.** The alarm releases names idle longer than `idleDays` (not reserved ones). A release tombstones the name (`removed(name, at, reason)`), drops its outbox and allow list, and reports it.
- **Aligning with the configuration.** On the first request after a deploy, the object aligns with the configuration, as it aligned enrolment before:
  - a claimed name now reserved for nobody, or for keys other than its bound one, is revoked: tombstoned, its socket closed, its outbox dropped;
  - a claimed name now reserved for its own key just loses its claim row, and stays;
  - a connected reserved name whose key the configuration no longer lists is disconnected (`reserved`), and keeps its name;
  - a name dropped from `reserved` keeps working: the protection ends, nobody is cut off.
- **Claiming again.** It clears the tombstone, so a name can change hands. The peers' pins are what make that safe (N5).
- **One key per claimed name.** A reserved name rotates with `notAfter` as today. Key succession for claimed names comes later, with a migration to a list of keys.

Alternatives:
- *Keep enrolment by the operator.* That cannot serve installations the operator does not know.
- *Key fingerprints as addresses, names as local petnames.* Every address, accept entry, domain, mark and task record in the bot carries the installation id, so this would be a rewrite of the bot side for no gain at this size. The key already is the identity underneath, through the pins.
- *Names proven by DNS only (`/.well-known/`).* That puts friction on a laptop and on anyone without a domain. It stays a later admission mode.

### N2. `auth` version 2 and the connect hint
- **Connecting.** The client connects to `/connect?as=<name>`. The Worker checks the name's grammar and forwards the request to the single object. Later, `idFromName(as)` gives each installation its own object with no client change. A connection without `as` is forwarded too, so that a version-1 bot meets `unsupported version` at its `auth` instead of an HTTP error; a version-2 `auth` without a hint is `hint mismatch`.
- **The challenge is unchanged:** `{t:"challenge", nonce, now}`.
- **The answer** is `{t:"auth", v: 2, name, key, sig}`, with `sig = Ed25519("coach-aven-hub/2|<host>|<name>|<key>|<nonce>")`.
  - The key travels because a free name has no key to look up.
  - The host keeps a signature from being replayed at another hub.
- **Refusals.** A refused `auth` closes the socket with a reason the bot logs. It reuses its existing `hub.connect.failed` event, an error that reaches Sentry, with the hub's reason. The reasons: `unsupported version`, `hint mismatch`, `bad signature`, `name taken`, `key holds a name`, `reserved`, `closed`, `claim limit`, `not authenticated` (anything before a well-formed `auth`), `bad config`.
  - The hub logs the same reason as `hub.auth.refused`, with the claimed name and never the key.
  - Levels differ, because on an open hub most refusals are other people's business:
    - `reserved` (a reserved name claimed with another key) and `bad config` are errors;
    - `unsupported version`, `hint mismatch` and `bad signature` are warnings;
    - the rest are info.
  - An answer without `v: 2` (the version-1 shape) is `unsupported version`.

### N3. The allow list is the pinned peers
- **The frame.** A new client frame, `{t:"allow", installations: [...]}`, is sent after `hello` and whenever the pinned peers change on `/aven reload`.
- **Storage.** The hub keeps it in `allow(installation, peer)`, replacing the whole set, capped at `allowMax` entries.
- **Routing.** The `send` check becomes: the recipient's name is bound, not tombstoned, and its allow list holds the sender.
- **The bot's list** is `Object.keys(peers.current)`. Pins already decide whose envelopes the installation can verify, so the hub only drops early what the receiver would drop anyway, before it takes backlog.
- **No reason that reveals a name.** A free name, a released one and one that does not allow the sender all get `rejected: unknown installation`. The bot words it for the agent as "unknown installation, or it has not pinned `<this installation>`".

Alternatives:
- *Filter only at the receiver* (today): a public hub turns that into a mailbox anyone can fill.
- *A separate `allow` setting in the bot*: a second list that must agree with the pins.
- *Agent-level filtering at the hub*: it needs agent names and the accept lists at the hub, which are exactly what this change takes away from it.

### N4. Presence along mutual edges
- **The edge.** It exists between X and Y when each allows the other. Every task needs both directions (ask and answer), so this is exactly the set of installations a task can run with.
- **`hello`** is `{t:"hello", now, online, removed}`:
  - `online`: the connected installations on an edge with the caller;
  - `removed`: the tombstones of names in the caller's allow list.
- **When things change.** On a connect, a disconnect or an allow-list change, the hub sends a full `presence` frame, recomputed per recipient, to each connected installation whose view changed. Removals are pushed to connected installations whose allow list names the removed name.
- **Why not one-sided lists.** Anyone could add any name to their own allow list to watch its activity. The `agents` tool already answers `offline` for a peer it does not see; the message adds that the peer may not have pinned the caller.

### N5. Envelope version 2: an installation-level header
- **Outer envelope:** `{v: 2, id, from: "<installation>", to: "<installation>", eph, ct, sig}`.
- **Sealed payload:** today's payload plus the routing it lost: `{from: <agent>, to: <agent>, method, task, message, domain, toDomain, marks, depth, cost?}`.
- **Binding:**
  - AAD is `[v, id, from, to]`;
  - KDF info is `coach-aven-hub/2|<eph>|<recipient box key>`;
  - the signature covers `[v, id, from, to, eph, ct]`.
  So the key derivation binds the receiver's encryption key, as HPKE does, and the signature binds the sender's signing key. A name that changes hands can neither open an envelope sealed to the old key nor sign as the old key, and the pins at the receiver turn it into `bad signature from <name>`.
- **Inside the bot,** messages keep their full addresses. The service and the local transport keep working on a message with `<installation>/<agent>` addresses, method and task. Only the hub client splits a message into the outer envelope and the sealed payload, and joins them again on delivery, after checking that the sealed `to` names a local agent. The local path is unchanged, and the service tests prove it.
- **Expiry reports** are `{t:"expired", id}`. The hub client keeps each routed envelope's record — the clear message, without its ciphertext and payload — until the bot's own task expiry (8 days), so the report finds its task there. Task records are untouched, and an expired answer of its own ends the incoming task as today.
- **A delivery for another installation** (its clear `to` is not this one) is dropped as unexpected. A sealed `to` naming no local agent reaches the service, which answers it as it answers any agent that does not accept the caller: `rejected: not accepted` (D9).

### N6. Hub storage, version 2
- **One migration (schema 2)** recreates `outbox` as `(installation, seq, env_id, sender, size, routed_at, expires_at, env)` with an index on `(installation, sender)`.
  - It recreates `expired` as `(env_id, sender)`, and `removed` as `(name, at, reason)`.
  - It drops `enrolled`, and adds `names`, `allow` and `claims`.
- **Version-1 rows are deleted,** because no version-2 client can read them. Only canary envelopes are lost; their tasks end `failed: expired` by the bot's own expiry.
- **Backlog caps.** The pair cap (`pairEnvelopes` 200, `pairBytes` 10 MB) is checked from the outbox with the new index, beside the recipient cap (1000 envelopes, 50 MB). Both answer `rejected: backlog`.

### N7. `HUB_CONFIG` version 2

```
{ "registration": "open" | "closed",
  "reserved": { "<name>": { "sign": [{ "key": "<b64url>", "notAfter"?: "<ISO>" }] } | null },
  "limits"?: { "claimsPerIpPerDay": 5, "idleDays": 180, "pairEnvelopes": 200, "pairBytes": 10485760,
               "backlogEnvelopes": 1000, "backlogBytes": 52428800, "allowMax": 1000 } }
```

- `local` and `hub` are reserved for nobody in code.
- A configuration in the version-1 shape (`installations`) fails parsing. The object then refuses every connection with a logged error, so a stale secret can never open a hub.
- **The place for later admission modes:** one function, `admit(claim, cfg, registry)`, the only place that reads `registration`. Invites, domain proofs and organisation signatures are new values and new branches there.

### N8. No compatibility, one cut-over
- `PROTOCOL_VERSION` becomes 2 and `SIG_CONTEXT` becomes `coach-aven-hub/2`. Neither side keeps version-1 code.
- **Mismatches fail loudly:**
  - a version-1 bot meets `unsupported version` when it authenticates;
  - a version-2 bot meets a version-1 hub's refusal of its `auth` frame;
  - in both cases messaging inside the installation keeps working.
- **Other versions' envelopes.** The hub refuses an envelope of another version when it is sent (`rejected: unsupported version`), so the sender is told there. A receiver cannot read the task inside an envelope of a version it does not know, so it can only log one that still reaches it; it no longer tells the sender itself.
- **Records queued by a version-1 bot** before its upgrade cannot be sent. The upgraded bot settles them `rejected: unsupported version`, so their tasks end loudly.
- **Order:** the hub first, then the canary bots. The window between them is minutes, and tasks in it fail loudly.

### N9. Where each later feature plugs in

| Later | Plugs in at |
|---|---|
| Invite codes, domain proofs, organisation keys as admission | `registration` + `admit()` (N7) |
| Key succession for claimed names | `names.keys` is a list (N1); a `succeed` frame |
| Encryption keys signed by the identity key, served by the hub; prekeys | a new frame and table; pins keep the signing key |
| Pairing codes, `/aven peer add` | the bot's pin store; the allow list follows the pins (N3) |
| Contact requests | a new frame; the allow list stays the gate |
| Directory | an opt-in card beside `names` |
| Sharding | `?as=` → `idFromName(as)` (N2) |
| Federation | `name@host` in the address grammar; the host in the challenge (N2) |
| Laptop node | the bot-independent modules: `protocol`, `a2a`, `seal`, `hubclient` |

## Risks / Trade-offs

- **[Name squatting on an open hub]**
  - Names are handles, and pins make a squatted name useless for impersonation.
  - Reserved names protect the operator's installations.
  - Claims are limited per IP, and idle names are released.
- **[A released name is taken over]** The new key fails every pin, so its envelopes are dropped as `bad signature`. The peers that allowed it were told when it was released.
- **[The hub learns the relationship graph]** It already sees traffic between installations. Agent-level accept lists never leave the installation.
- **[`unknown installation` hides the real cause]** The bot's message and `docs/hub.md` name the missing pin as the likely cause.
- **[Per-IP limits behind shared addresses]** The default is generous and configurable. Reserved names skip it.
- **[One object holds the registry]** That is fine for thousands of names. The hint makes sharding a deploy change.
- **[First contact still needs keys exchanged out of band]** That is unchanged from today, and deliberate: the hub never vouches for a key. Pairing codes make it one paste later.
- **[An installation the operator does not run pins one of ours]** It can then ask our agents that accept it, which is the accept list's decision as today. Accepting an installation run by someone else still waits for the hard read-only shadow mode (`agent-messaging` Risks); `docs/hub.md` says so.

## Migration Plan

1. Merge. Prod has no `HUB_URL`, so prod does not change. On the canary bots, nothing changes until both they and the hub run version 2.
2. In the operator's ops repo, convert `hub.config.json` to version 2: `registration: "open"`, with the operator's installations under `reserved` with their keys, including prod's name before prod connects.
3. Deploy the hub. Check `/health` and a `hub.auth.refused unsupported version` from the still-version-1 bots.
4. Deploy the Teams staging bot, and the home bot in its restart window. Check:
   - the connect logs;
   - that both sent their allow lists;
   - that each sees the other online.
5. Canary end to end: owen-ops asks a staging project, gets the answer, and `/aven asks` shows the cost. The hub's stored rows and logs name installations only.
6. Prod joins on the next tag that carries version 2: keygen, its reserved entry (already there), pins on both sides, `HUB_URL`.

**Rollback.** Redeploy the previous hub and bot releases together. The storage migration is one-way, so the previous hub starts on empty storage and loses only canary envelopes.

## Changed while implementing

Implementation choices that differ from the text above as first proposed. Each is now written into the decision it belongs to.
- N1: one key column per claimed name instead of a key list; reserved names stay in the configuration only; the alignment rules are spelled out.
- N2: refusals reuse the bot's `hub.connect.failed` event (the plan named `hub.connect.refused`); two more reasons (`not authenticated`, `bad config`); a level per reason; a connection without a hint is forwarded.
- N5: expiry reports find their task in the hub client's routed records, not in new `envIds` on the task records; a sealed `to` with no such agent is the service's `not accepted`.
- N8: the receiver no longer tells the sender of an envelope of another version (the hub does, at send time); the version-1 `onUnsupported` hook is gone; version-1 outbox records end `rejected: unsupported version`.

## Open Questions

- The defaults for `idleDays` (180) and `claimsPerIpPerDay` (5) are configuration. They can be tuned after the first months of an open hub without touching code or specs.
